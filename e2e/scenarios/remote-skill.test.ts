import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectAbsent,
  expectExit,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { NETWORK_SUBCOMMANDS } from "../support/git";
import { declareEvidence } from "../support/report";
import { asObject, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "remote-skill";

const PDF_V1 = "---\nname: pdf\ndescription: Extract text\n---\n\nbody\n";
const PDF_V2 =
  "---\nname: pdf\ndescription: Extract text and tables\n---\n\nbody\n";

async function remoteKeys(project: string): Promise<string[]> {
  const path = join(project, ".capshelf", "remotes.lock.json");
  const lock = asObject(
    parseJsonText(await readFile(path, "utf-8"), path),
    path,
  );
  return Object.keys(asObject(lock.items, `${path} items`)).sort();
}

test(
  "a skill pulled from a repository installs, stays offline, and adopts into the shelf",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "add <url> installs one skill from a repository outside the shelf into a gitignored local record, a second add reports already-current and writes nothing, a bare status reports the pin while the upstream has moved and only --check-upstream sees the move, a bare update sweep runs no networked Git and moves no pin, a cold-cache update refuses and leaves every owned path byte identical, and share --adopt moves ownership into the data repo and releases the remote row",
      labels: ["reproduced-user-workflow", "modeled-external-step"],
      modeledSteps: [
        "the third-party host is a local bare repository reached over file://, standing in for github.com",
      ],
      proofLimits: [
        "GitHub itself, its authentication, and its rate limits stay unproved: the suite carries no credentials and every fetch is local",
        "the cold-cache refusal is measured against a cache this test deleted, not one a real machine lost",
        "the offline claim is measured over the Git the binary ran, so a connection opened by anything other than Git would not be seen",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      // The third-party repository. A bare repo plus the working clone that
      // pushes to it, which is how a later commit reaches the URL the project
      // pinned.
      const upstream = await world.git.createBareRemote("third-party");
      const upstreamWork = await world.git.createDataRepo({
        name: "third-party-work",
        origin: upstream.url,
        skills: { pdf: PDF_V1, xlsx: "---\nname: xlsx\n---\n\nbody\n" },
      });
      await world.git.ok(upstreamWork, ["push", "-q", "-u", "origin", "main"]);

      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: null,
        skills: { placeholder: "---\nname: placeholder\n---\n\nbody\n" },
      });
      const project = await world.git.createProject("app");
      expectExit(
        await world.capshelf(project, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );

      // Install one skill from the URL. The picker needs a terminal, so a
      // repository holding two skills is named with --path.
      const added = await world.capshelf(project, [
        "add",
        upstream.url,
        "--path",
        "skills/pdf",
        "--yes",
        "--json",
      ]);
      expectExit(added, 0);
      expect(await remoteKeys(project)).toEqual(["remote/skills/pdf"]);
      const tracked = await world.git.ok(project, [
        "ls-files",
        ".capshelf/remotes.lock.json",
      ]);
      expect(tracked.stdout.trim()).toBe("");

      // The null second run: byte-stable, and strict status stays clean.
      const afterInstall = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const again = await world.capshelf(project, [
        "add",
        upstream.url,
        "--path",
        "skills/pdf",
        "--yes",
        "--json",
      ]);
      expectExit(again, 0);
      expect(again.stdout).toContain('"action": "already-current"');
      expectSameState(
        afterInstall,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "a second add of the same URL",
      );
      expectExit(
        await world.capshelf(project, ["status", "--strict", "--json"]),
        0,
      );

      // The upstream moves. Only the check sees it; a bare status does not.
      await world.git.writeAndCommit(
        upstreamWork,
        { "skills/pdf/SKILL.md": PDF_V2 },
        "revise pdf",
      );
      await world.git.ok(upstreamWork, ["push", "-q", "origin", "main"]);
      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(project, ["status", "--json"])).stdout,
          ),
          "skills",
          "pdf",
        ).state,
      ).toBe("ok");

      // D15: one command and two flags carry every network path, and a bare
      // update is none of them. The cache still holds the commit the install
      // pinned, so a sweep that fetched could move the pin; this one must not.
      // Exit 0 alone is not proof, because a failed fetch is reported rather
      // than thrown — the Git the binary ran is what settles it.
      const lockPath = join(project, ".capshelf", "remotes.lock.json");
      const lockBeforeSweep = await readFile(lockPath, "utf-8");
      const recorder = await world.git.recordInvocations();
      expectExit(
        await world.capshelf(project, ["update", "--json"], {
          env: recorder.env,
        }),
        0,
      );
      const ranGit = await recorder.subcommands();
      // A run that reached no Git at all would satisfy the filter below while
      // measuring nothing.
      expect(ranGit.length).toBeGreaterThan(0);
      expect(
        ranGit.filter((subcommand) => NETWORK_SUBCOMMANDS.includes(subcommand)),
      ).toEqual([]);
      expect(await readFile(lockPath, "utf-8")).toBe(lockBeforeSweep);
      expect(
        await readFile(join(project, ".agents/skills/pdf/SKILL.md"), "utf-8"),
      ).toBe(PDF_V1);

      expectExit(
        await world.capshelf(project, ["status", "--check-upstream", "--json"]),
        0,
      );
      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(project, ["status", "--json"])).stdout,
          ),
          "skills",
          "pdf",
        ).state,
      ).toBe("update_available");

      // Safe failure: a cold cache refuses and writes nothing. The cache is
      // machine state outside the project, so deleting it is the state a user
      // reaches by clearing $XDG_DATA_HOME.
      const cacheRoot = join(world.home, ".local", "share", "capshelf");
      await world.run(world.stage, ["rm", "-rf", cacheRoot]);
      const beforeRefusal = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
        dataRepo: { path: shelf, paths: ["skills"] },
      });
      const refused = await world.capshelf(project, [
        "update",
        "skills/pdf",
        "--yes",
        "--json",
      ]);
      expect(refused.outcome).toMatchObject({ kind: "exit" });
      expect(`${refused.stdout}${refused.stderr}`).toContain(
        "capshelf status --check-upstream",
      );
      expectSameState(
        beforeRefusal,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["skills"] },
        }),
        "a cold-cache update refusal",
      );

      // Re-fetch, then move the pin. `update` reads the cache the check left.
      expectExit(
        await world.capshelf(project, ["status", "--check-upstream", "--json"]),
        0,
      );
      expectExit(
        await world.capshelf(project, [
          "update",
          "skills/pdf",
          "--yes",
          "--json",
        ]),
        0,
      );
      expect(
        await readFile(join(project, ".agents/skills/pdf/SKILL.md"), "utf-8"),
      ).toContain("Extract text and tables");

      // Adopt: the shelf takes ownership and the remote row is released last.
      const shelfHeadBefore = await world.git.head(shelf);
      const adopted = await world.capshelf(project, [
        "share",
        "skills/pdf",
        "--adopt",
        "--json",
        "-m",
        "adopt pdf",
      ]);
      expectExit(adopted, 0);
      expect(adopted.stdout).toContain('"adoptedFrom": "remote"');
      expect(adopted.stdout).toContain('"previousOwnerReleased": true');
      expect(await remoteKeys(project)).toEqual([]);
      expect(await world.git.head(shelf)).not.toBe(shelfHeadBefore);
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      expect(
        await readFile(join(shelf, "skills/pdf/.capshelf.yml"), "utf-8"),
      ).toContain("upstreamPath: skills/pdf");

      // The skill is an ordinary shelf item now, and strict status is clean.
      expectExit(
        await world.capshelf(project, ["status", "--strict", "--json"]),
        0,
      );
      await expectAbsent(join(project, ".agents/skills/xlsx"));
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
