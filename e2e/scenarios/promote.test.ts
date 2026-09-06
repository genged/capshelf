import { expect, test } from "bun:test";
import { join } from "node:path";
import type { OwnedState } from "../support/assertions";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectRecovery,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { asObject, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

/**
 * `promote` is the one verb that writes to state a whole team shares, so its
 * blast radius is the shelf rather than the calling project. Three limits are
 * what make it safe to run, and each one is silent when it breaks: it must not
 * push, it must not reach another project, and it must not overwrite upstream
 * content the caller has not seen.
 */
const SCENARIO = "promote";

const HELLO_HEAD = "---\nname: hello\ndescription: Greet.\n---\n\n";
const HELLO = `${HELLO_HEAD}Say hello.\n`;
const WARMER = `${HELLO_HEAD}Say hello, warmly.\n`;

test(
  "promote publishes to the shelf, never pushes it, and never reaches another project",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "promote commits the calling project's edit to the bound data repo and re-pins that project, leaves the shelf's remote refs unmoved, leaves a second project byte-identical until it runs update, and reports already-current when re-run",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the shelf's remote is a local bare repository, so 'never pushes' is measured as its advertised refs never moving, and says nothing about provider-side policy",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const remote = await world.git.createBareRemote("shelf-remote");
      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: remote.url,
        skills: { hello: HELLO },
      });
      await world.git.ok(shelf, ["push", "-q", "-u", "origin", "main"]);

      // Two projects on one shelf: the second one is the subject of the
      // isolation claim, not scenery.
      const install = async (name: string): Promise<string> => {
        const project = await world.git.createProject(name);
        expectExit(
          await world.capshelf(project, [
            "init",
            "--data",
            shelf,
            "--no-upstream",
          ]),
          0,
        );
        expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);
        return project;
      };
      const atlas = await install("atlas");
      const borealis = await install("borealis");

      // Atlas edits its installed copy. That is the state promote publishes.
      await world.git.writeFiles(atlas, {
        ".agents/skills/hello/SKILL.md": WARMER,
      });
      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(atlas, ["status", "--json"])).stdout,
          ),
          "skills",
          "hello",
        ).state,
      ).toBe("drifted_local");

      const refsBefore = await world.git.advertisedRefs(remote.url);
      const borealisBefore = await captureOwnedState(world, {
        projectFiles: borealis,
        projectGit: borealis,
      });
      const shelfHeadBefore = await world.git.head(shelf);

      const promoted = await world.capshelf(atlas, [
        "promote",
        "skills/hello",
        "-m",
        "warmer hello",
        "--json",
      ]);
      expectExit(promoted, 0);
      const payload = asObject(
        parseJsonText(promoted.stdout, "promote --json"),
        "promote --json",
      );
      expect(payload.action).toBe("promoted");
      expect(payload.dataRepo).toBe(shelf);
      expect(payload.dataRepoHasOrigin).toBe(true);

      // The edit reached the shelf as a commit, not just as a working-tree
      // change: a later clone has to receive it.
      expect(await world.git.head(shelf)).not.toBe(shelfHeadBefore);
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      expect(
        await Bun.file(join(shelf, "skills", "hello", "SKILL.md")).text(),
      ).toBe(WARMER);

      // Never pushes. Publication stays the user's step, so the refs the
      // remote advertises are the ones it advertised before.
      expect(await world.git.advertisedRefs(remote.url)).toEqual(refsBefore);

      // Never reaches another project. Borealis shares the shelf and is
      // untouched, down to its Git index.
      expectSameState(
        borealisBefore,
        await captureOwnedState(world, {
          projectFiles: borealis,
          projectGit: borealis,
        }),
        "borealis after atlas promoted",
      );

      // Borealis changes only when it asks to.
      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(borealis, ["status", "--json"])).stdout,
          ),
          "skills",
          "hello",
        ).state,
      ).toBe("update_available");
      expectExit(await world.capshelf(borealis, ["update", "skills/hello"]), 0);
      expect(
        await Bun.file(
          join(borealis, ".agents", "skills", "hello", "SKILL.md"),
        ).text(),
      ).toBe(WARMER);

      // Null second run. Promote re-pinned atlas, so the same command now has
      // nothing to publish and must not build an empty commit.
      const headAfterPromote = await world.git.head(shelf);
      const second = await world.capshelf(atlas, [
        "promote",
        "skills/hello",
        "-m",
        "warmer hello again",
        "--json",
      ]);
      expectExit(second, 0);
      expect(
        asObject(
          parseJsonText(second.stdout, "promote --json"),
          "promote --json",
        ).action,
      ).toBe("already-current");
      expect(await world.git.head(shelf)).toBe(headAfterPromote);
      expectExit(await world.capshelf(atlas, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "promote refuses to overwrite upstream content the project has not seen",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with the item changed upstream past the project's lock, promote exits 3, names both the update and the --stale-ok way out, and leaves the data repo byte-identical",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the upstream advance is one commit made directly in the shelf, not a second project's promote arriving through a remote",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { hello: HELLO },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);

      // Someone else's change lands on the shelf after this project pinned.
      await world.git.writeAndCommit(
        shelf,
        {
          "skills/hello/SKILL.md":
            "---\nname: hello\ndescription: Greet.\n---\n\nUpstream rewrite.\n",
        },
        "upstream rewrite",
      );
      // This project edits the same item, unaware of that.
      await world.git.writeFiles(project, {
        ".agents/skills/hello/SKILL.md": WARMER,
      });

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["skills"] },
        });
      const before = await snapshot();

      const refused = await world.capshelf(project, [
        "promote",
        "skills/hello",
        "-m",
        "warmer hello",
      ]);
      expectExit(refused, 3);
      expectOutputContains(refused, "changed in the data repo since");
      // Both ways out, because taking upstream and overwriting it are
      // different decisions and the refusal must not make either one for the
      // user.
      expectRecovery(refused, "capshelf update skills/hello");
      expectRecovery(refused, "capshelf promote skills/hello --stale-ok");

      expectSameState(before, await snapshot(), "refused stale promote");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "promote --stale-ok overrides the refusal on purpose and says that it did",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "--stale-ok turns the stale refusal into a promote that replaces the newer upstream content, reports staleOverride only when it actually bypassed a check, keeps the overwritten commit reachable, and still does not push",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the shelf's remote is a local bare repository, so 'never pushes' is measured as its advertised refs never moving",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const remote = await world.git.createBareRemote("shelf-remote");
      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: remote.url,
        skills: { hello: HELLO },
      });
      await world.git.ok(shelf, ["push", "-q", "-u", "origin", "main"]);
      const project = await world.git.createProject("atlas");
      expectExit(
        await world.capshelf(project, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);
      const refsBefore = await world.git.advertisedRefs(remote.url);

      // The flag is passed with nothing stale. It must stay silent: a
      // consumer keys "was upstream work discarded" on this field, so
      // reporting it here would raise an alarm on an ordinary promote.
      await world.git.writeFiles(project, {
        ".agents/skills/hello/SKILL.md": WARMER,
      });
      const quiet = await world.capshelf(project, [
        "promote",
        "skills/hello",
        "--stale-ok",
        "-m",
        "ordinary promote",
        "--json",
      ]);
      expectExit(quiet, 0);
      const quietPayload = asObject(
        parseJsonText(quiet.stdout, "promote --json"),
        "promote --json",
      );
      expect(quietPayload.action).toBe("promoted");
      expect(quietPayload.staleOverride).toBeUndefined();

      // Now upstream really does move past the lock, and the project
      // overwrites it knowingly.
      const overwritten = await world.git.writeAndCommit(
        shelf,
        { "skills/hello/SKILL.md": `${HELLO_HEAD}Upstream rewrote this.\n` },
        "upstream rewrite",
      );
      const chosen = `${HELLO_HEAD}The version this project chose.\n`;
      await world.git.writeFiles(project, {
        ".agents/skills/hello/SKILL.md": chosen,
      });

      const overridden = await world.capshelf(project, [
        "promote",
        "skills/hello",
        "--stale-ok",
        "-m",
        "override on purpose",
        "--json",
      ]);
      expectExit(overridden, 0);
      const payload = asObject(
        parseJsonText(overridden.stdout, "promote --json"),
        "promote --json",
      );
      expect(payload.action).toBe("promoted");
      expect(payload.staleOverride).toBe(true);

      // The shelf now holds this project's version.
      expect(
        await Bun.file(join(shelf, "skills", "hello", "SKILL.md")).text(),
      ).toBe(chosen);

      // Overwritten, not erased. The override lands as a new commit on top,
      // so the discarded upstream work is still recoverable from history —
      // that is what makes the escape hatch safe to offer.
      //
      // Reachability from HEAD, not object presence: a `reset --hard` that
      // dropped the upstream commit would leave the object in place until the
      // next gc, so `hasCommit` here would report success over lost history.
      expectExit(
        await world.git.run(shelf, [
          "merge-base",
          "--is-ancestor",
          overwritten,
          "HEAD",
        ]),
        0,
      );
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);

      // Overriding a stale check is still not publishing.
      expect(await world.git.advertisedRefs(remote.url)).toEqual(refsBefore);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "an uncommitted data-repo edit blocks promote, and --stale-ok does not bypass it",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with uncommitted changes inside the item's path in the data repo, promote exits 3 and names the paths to inspect, and passing --stale-ok does not change that or write anything",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { hello: HELLO },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);

      // A half-finished edit in the shelf worktree. It has no commit, so
      // there is no provenance to overwrite and nothing for --stale-ok to
      // weigh: the guard is about missing history, not about staleness.
      await world.git.writeFiles(shelf, {
        "skills/hello/SKILL.md": `${HELLO_HEAD}Half-finished shelf edit.\n`,
      });
      await world.git.writeFiles(project, {
        ".agents/skills/hello/SKILL.md": WARMER,
      });

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["skills"] },
        });

      for (const extra of [[], ["--stale-ok"]]) {
        const before = await snapshot();
        const refused = await world.capshelf(project, [
          "promote",
          "skills/hello",
          ...extra,
          "-m",
          "should not land",
        ]);
        expectExit(refused, 3);
        expectOutputContains(
          refused,
          "the data repo copy has uncommitted changes",
        );
        expectRecovery(refused, "status --short -- skills/hello");
        expectSameState(
          before,
          await snapshot(),
          `refused promote ${extra.join(" ")}`,
        );
      }
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
