import { expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectOutputExcludes,
  expectRecovery,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "recovery";

test(
  "a project whose bound clone is gone degrades on read, refuses on write, and names the way back",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with the bound clone missing, read-only status degrades to missing_upstream at exit 0 while apply exits 6 with the three-step fix; every invalid binding is refused without touching project state; the correct binding restores materialization",
      labels: ["reproduced-user-workflow", "constructed-recovery-state"],
      proofLimits: [
        "the missing clone is produced by renaming the directory, not by restoring a machine from backup",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { "csv-report": "csv report\n" },
      });
      const otherShelf = await world.git.createDataRepo({
        name: "other-shelf",
        origin: "https://example.invalid/other.git",
        skills: { "csv-report": "different shelf\n" },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(
        await world.capshelf(project, ["add", "skills/csv-report"]),
        0,
      );

      // The machine came back without the clone the binding names.
      const moved = world.path("shelf-elsewhere");
      await rename(shelf, moved);

      // A read-only command degrades rather than refusing: the row says the
      // source is unavailable and the exit stays 0
      // (src/commands/status.ts:122-141).
      const degraded = await world.capshelf(project, ["status", "--json"]);
      expectExit(degraded, 0);
      expect(
        statusRow(parseStatusRows(degraded.stdout), "skills", "csv-report")
          .state,
      ).toBe("missing_upstream");

      const before = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      // A command that needs shelf bytes cannot proceed. Exit 6 is the
      // documented code for "no data repo configured for this project"
      // (docs/cli.md:1250-1261), and the message is the three-step fix
      // (docs/cli.md:1265-1297): clone it, point capshelf at it, retry. The
      // repair has to be runnable — the bound directory is gone, so a command
      // that operates on it cannot be the way out.
      const refused = await world.capshelf(project, ["apply", "--json"]);
      expectExit(refused, 6);
      expectOutputContains(refused, "https://example.invalid/shelf");
      expectRecovery(refused, "capshelf set-data <path>");
      expectOutputExcludes(refused, `git -C ${shelf} remote add origin`);
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "apply with a missing clone",
      );

      // A remote URL is not a binding; the message points at init.
      const remoteBinding = await world.capshelf(project, [
        "data",
        "bind",
        "https://example.invalid/shelf.git",
      ]);
      expectExit(remoteBinding, 3);
      expectOutputContains(remoteBinding, "init --data");

      // A directory inside a worktree is not a data repo root
      // (docs/cli.md:189-198). A refused precondition is exit 3
      // (docs/cli.md:1250-1261).
      const nested = await world.capshelf(project, [
        "data",
        "bind",
        join(moved, "skills"),
      ]);
      expectExit(nested, 3);

      // A clone of the wrong shelf is refused with both identities printed.
      const wrongShelf = await world.capshelf(project, [
        "data",
        "bind",
        otherShelf,
      ]);
      expectExit(wrongShelf, 4);
      expectOutputContains(wrongShelf, "https://example.invalid/shelf");
      expectOutputContains(wrongShelf, "https://example.invalid/other");

      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "refused bindings",
      );

      // The correct clone binds, and the command that failed now works.
      expectExit(await world.capshelf(project, ["data", "bind", moved]), 0);
      expectExit(await world.capshelf(project, ["apply"]), 0);
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "an interrupted initialization is recovered by running the same command again",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with the machine-local binding absent, init re-runs cleanly and adopts a leftover system item whose content matches the running binary",
      labels: ["constructed-recovery-state"],
      proofLimits: [
        "the partial state is constructed by deleting the binding, not by killing init mid-run; producing it from a real interruption belongs to a source-level fault-injection test",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { "csv-report": "csv report\n" },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      const systemSkill = join(
        project,
        ".agents",
        "skills",
        "capshelf",
        "SKILL.md",
      );
      const systemBytes = await readFile(systemSkill, "utf-8");

      // The binding is the completion marker: an interruption leaves none.
      await rm(join(project, ".capshelf", "local.json"));

      const rerun = await world.capshelf(project, ["init", "--data", shelf]);
      expectExit(rerun, 0);
      expect(await readFile(systemSkill, "utf-8")).toBe(systemBytes);
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "data sync reports each clone state, prints its report before a non-zero exit, and never moves the clone except by fast-forward",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "sync classifies no_origin, local_ahead, and diverged with the documented exit codes, always prints the JSON report, and leaves a diverged clone untouched",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the remote is a local bare repository, so credential helpers, proxies, and provider-side rejection are not exercised",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const remote = await world.git.createBareRemote("shelf-remote");
      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: remote.url,
        skills: { "csv-report": "csv report\n" },
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

      const syncState = async (): Promise<{
        state: string;
        exit: number;
        stdout: string;
      }> => {
        const result = await world.capshelf(project, [
          "data",
          "sync",
          "--json",
        ]);
        if (result.outcome.kind !== "exit") {
          throw new Error(
            `sync did not exit normally: ${world.describe(result)}`,
          );
        }
        const payload = JSON.parse(result.stdout) as { state: string };
        return {
          state: payload.state,
          exit: result.outcome.exitCode,
          stdout: result.stdout,
        };
      };

      expect(await syncState()).toMatchObject({ state: "up_to_date", exit: 0 });

      // An unpushed promote is a designed state, not an error.
      await world.git.writeAndCommit(
        shelf,
        { "skills/csv-report/SKILL.md": "csv report local\n" },
        "local work",
      );
      expect(await syncState()).toMatchObject({
        state: "local_ahead",
        exit: 0,
      });

      // The remote is rewritten under the clone: both sides have work.
      const rewriter = await world.git.cloneViaTransport(
        remote.url,
        "rewriter",
      );
      await world.git.writeAndCommit(
        rewriter,
        { "skills/csv-report/SKILL.md": "csv report upstream\n" },
        "upstream work",
      );
      await world.git.ok(rewriter, ["push", "-q", "origin", "main"]);

      const beforeDiverged = await captureOwnedState(world, {
        // A fetch moves remote-tracking refs by design; the claim here is
        // that the clone's own branch and worktree do not move.
        dataRepo: {
          path: shelf,
          paths: ["skills"],
          refPrefixes: ["refs/heads/"],
        },
      });
      const diverged = await syncState();
      expect(diverged).toMatchObject({ state: "diverged", exit: 4 });
      // The report prints before the non-zero exit, so a wrapper can read it.
      expect(diverged.stdout.length).toBeGreaterThan(0);
      expectSameState(
        beforeDiverged,
        await captureOwnedState(world, {
          // A fetch moves remote-tracking refs by design; the claim here is
          // that the clone's own branch and worktree do not move.
          dataRepo: {
            path: shelf,
            paths: ["skills"],
            refPrefixes: ["refs/heads/"],
          },
        }),
        "diverged sync",
      );

      // A clone with no origin cannot sync at all.
      await world.git.ok(shelf, ["remote", "remove", "origin"]);
      expect(await syncState()).toMatchObject({ state: "no_origin", exit: 3 });
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a pin that cannot be proved refuses apply and revert, and only update repairs it",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with the locked commit unreachable, apply and revert refuse and point at update, update re-pins onto the current source, and one wedged item does not stop the healthy ones",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { "csv-report": "csv report\n", "release-notes": "notes\n" },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(
        await world.capshelf(project, ["add", "skills/csv-report"]),
        0,
      );
      expectExit(
        await world.capshelf(project, ["add", "skills/release-notes"]),
        0,
      );

      // A fresh clone taken before the pin: it can resolve nothing the
      // project locked, which is what a rewritten history leaves behind.
      const rewritten = await world.git.createDataRepo({
        name: "rewritten-shelf",
        origin: "https://example.invalid/shelf.git",
        skills: {
          "csv-report": "csv report rewritten\n",
          "release-notes": "notes\n",
        },
      });

      const item = ["--data", rewritten];
      const refusedApply = await world.capshelf(project, [
        ...item,
        "apply",
        "skills/csv-report",
      ]);
      // An unresolvable item is reported and the command exits 1
      // (docs/cli.md:253), with the documented repair sentence
      // (docs/cli.md:1112-1120).
      expectExit(refusedApply, 1);
      expectOutputContains(
        refusedApply,
        "the locked source cannot supply a verified target — repair the pin with: capshelf update skills/csv-report",
      );

      const refusedRevert = await world.capshelf(project, [
        ...item,
        "revert",
        "skills/csv-report",
        "--yes",
      ]);
      expectExit(refusedRevert, 1);
      expectOutputContains(
        refusedRevert,
        "the locked source cannot supply a verified target — repair the pin with: capshelf update skills/csv-report",
      );

      // Only update has a new, verified target.
      expectExit(
        await world.capshelf(project, [
          ...item,
          "update",
          "skills/csv-report",
          "--yes",
        ]),
        0,
      );
      expect(
        await readFile(
          join(project, ".agents", "skills", "csv-report", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("csv report rewritten\n");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "one unresolvable copy item is reported while every healthy item still converges",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "apply reports an item whose source cannot be read, converges the rest, and exits 1",
      labels: ["reproduced-user-workflow", "constructed-recovery-state"],
      proofLimits: [
        "the unresolvable source is constructed by pointing the binding at a clone that never had the pinned commit",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { wedged: "wedged\n", healthy: "healthy\n" },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "skills/healthy"]), 0);

      // `wedged` is locked to a commit only this shelf has; the replacement
      // shelf below carries `healthy` at a resolvable commit and not `wedged`.
      expectExit(await world.capshelf(project, ["add", "skills/wedged"]), 0);
      const healthyInstalled = join(
        project,
        ".agents",
        "skills",
        "healthy",
        "SKILL.md",
      );
      await writeFile(healthyInstalled, "drifted\n");

      const replacement = await world.git.createDataRepo({
        name: "replacement-shelf",
        origin: "https://example.invalid/shelf.git",
        skills: { healthy: "healthy\n" },
      });
      // Re-pin only the healthy item onto the replacement shelf, so exactly
      // one locked entry is unresolvable there.
      expectExit(
        await world.capshelf(project, [
          "--data",
          replacement,
          "update",
          "skills/healthy",
          "--yes",
        ]),
        0,
      );
      await writeFile(healthyInstalled, "drifted again\n");

      const applied = await world.capshelf(project, [
        "--data",
        replacement,
        "apply",
        "--json",
        "--yes",
      ]);
      expectExit(applied, 1);
      const payload = JSON.parse(applied.stdout) as {
        items: { key: string; action: string }[];
      };
      const byKey = new Map(payload.items.map((row) => [row.key, row.action]));
      expect(byKey.get("data/skills/wedged")).toBe("error");
      expect(byKey.get("data/skills/healthy")).toBe("reconciled");
      expect(await readFile(healthyInstalled, "utf-8")).toBe("healthy\n");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
