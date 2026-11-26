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
 * promote writes team-shared state and its limits break silently, so tests
 * check it never pushes, never reaches another project, and never overwrites
 * unseen upstream content.
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

      // Asserts a commit, not just a working-tree change, so later clones
      // receive the edit.
      expect(await world.git.head(shelf)).not.toBe(shelfHeadBefore);
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      expect(
        await Bun.file(join(shelf, "skills", "hello", "SKILL.md")).text(),
      ).toBe(WARMER);

      expect(await world.git.advertisedRefs(remote.url)).toEqual(refsBefore);

      expectSameState(
        borealisBefore,
        await captureOwnedState(world, {
          projectFiles: borealis,
          projectGit: borealis,
        }),
        "borealis after atlas promoted",
      );

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

      await world.git.writeAndCommit(
        shelf,
        {
          "skills/hello/SKILL.md":
            "---\nname: hello\ndescription: Greet.\n---\n\nUpstream rewrite.\n",
        },
        "upstream rewrite",
      );
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

      // The field must stay silent here: consumers key "upstream work
      // discarded" on it, so reporting it would falsely alarm.
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

      expect(
        await Bun.file(join(shelf, "skills", "hello", "SKILL.md")).text(),
      ).toBe(chosen);

      // Check reachability from HEAD, not object presence: a `reset --hard`
      // would leave the object until gc and `hasCommit` would still pass.
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

      // An uncommitted shelf edit has no provenance to overwrite, so --stale-ok
      // does not apply: the guard is about missing history, not staleness.
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
