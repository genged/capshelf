import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectBytes,
  expectExit,
  expectHeadTreeContains,
  expectHeadTreeExcludes,
  expectIgnored,
  expectRealDirectory,
  expectRecovery,
  expectRelativeSymlink,
  expectSameState,
  parseApplyRows,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "fresh-clone";

test(
  "a fresh clone refuses to materialize without a binding, then binds and converges",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "a clone of a published project binds to the data repo and converges, and publication never carries machine-local state",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the bare remote is local: it proves Git transport and ref advertisement, not GitHub policy or UI",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const dataRepo = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { hello: "hello\n" },
      });
      const original = await world.git.createProject("original");
      const projectRemote = await world.git.createBareRemote("project");

      expectExit(
        await world.capshelf(original, ["init", "--data", dataRepo]),
        0,
      );
      expectExit(await world.capshelf(original, ["add", "skills/hello"]), 0);

      // Publication is the user's step. capshelf never pushes, and never
      // stages the project for the user.
      expectExit(
        await world.git.run(original, [
          "add",
          "--",
          ".capshelf",
          ".agents/skills",
          ".claude/skills",
        ]),
        0,
      );
      expectExit(
        await world.git.run(original, [
          "commit",
          "-q",
          "-m",
          "configure capshelf",
        ]),
        0,
      );
      await expectHeadTreeContains(world, original, [
        ".capshelf/.gitignore",
        ".capshelf/capshelf.json",
        ".capshelf/capshelf.lock.json",
        ".agents/skills/hello/SKILL.md",
        ".claude/skills/hello",
      ]);
      await expectHeadTreeExcludes(world, original, [
        ".capshelf/local.json",
        ".capshelf/local.lock.json",
      ]);
      await expectIgnored(world, original, [
        ".capshelf/local.json",
        ".capshelf/local.lock.json",
      ]);
      expect(await world.git.porcelain(original)).toBe("");

      expectExit(
        await world.git.run(original, [
          "remote",
          "add",
          "origin",
          projectRemote.url,
        ]),
        0,
      );
      expectExit(
        await world.git.run(original, ["push", "-q", "-u", "origin", "main"]),
        0,
      );

      // A transport clone is what a second machine receives.
      const clone = await world.git.cloneViaTransport(
        projectRemote.url,
        "clone",
      );
      await expectBytes(join(clone, ".capshelf", "local.json"), null);

      // With no binding at all, a read-only command degrades instead of
      // refusing: the row says the source is unavailable and the exit stays 0.
      const unbound = await world.capshelf(clone, ["status", "--json"]);
      expectExit(unbound, 0);
      expect(
        statusRow(parseStatusRows(unbound.stdout), "skills", "hello").state,
      ).toBe("missing_upstream");

      const beforeRefusal = await captureOwnedState(world, {
        projectFiles: clone,
        projectGit: clone,
        requiredAbsent: [join(clone, ".capshelf", "local.json")],
      });
      const refused = await world.capshelf(clone, ["apply", "--json"]);
      expectExit(refused, 6);
      expectRecovery(refused, "capshelf set-data <path>");
      expectSameState(
        beforeRefusal,
        await captureOwnedState(world, {
          projectFiles: clone,
          projectGit: clone,
          requiredAbsent: [join(clone, ".capshelf", "local.json")],
        }),
        "apply without a binding",
      );

      const ignorePath = join(clone, ".capshelf", ".gitignore");
      const ignoreBeforeBind = await readFile(ignorePath, "utf-8");
      expectExit(await world.capshelf(clone, ["data", "bind", dataRepo]), 0);
      expect(await readFile(ignorePath, "utf-8")).toBe(ignoreBeforeBind);
      await expectIgnored(world, clone, [
        ".capshelf/local.json",
        ".capshelf/local.lock.json",
      ]);
      expect(await world.git.porcelain(clone)).toBe("");

      const applied = await world.capshelf(clone, ["apply", "--json"]);
      expectExit(applied, 0);
      expect(parseApplyRows(applied.stdout)).toContainEqual({
        key: "data/skills/hello",
        action: "already-current",
      });
      await expectRealDirectory(join(clone, ".agents", "skills", "hello"));
      await expectRelativeSymlink(
        join(clone, ".claude", "skills", "hello"),
        "../../.agents/skills/hello",
      );
      await expectBytes(
        join(clone, ".agents", "skills", "hello", "SKILL.md"),
        "hello\n",
      );
      await expectBytes(
        join(clone, ".claude", "skills", "hello", "SKILL.md"),
        "hello\n",
      );

      // Null second run: the same reconcile operation must change nothing.
      const beforeSecondRun = await captureOwnedState(world, {
        projectFiles: clone,
        projectGit: clone,
      });
      const second = await world.capshelf(clone, ["apply", "--json"]);
      expectExit(second, 0);
      expect(parseApplyRows(second.stdout)).toContainEqual({
        key: "data/skills/hello",
        action: "already-current",
      });
      expectSameState(
        beforeSecondRun,
        await captureOwnedState(world, {
          projectFiles: clone,
          projectGit: clone,
        }),
        "second apply",
      );

      expectExit(
        await world.capshelf(clone, ["status", "skills/hello", "--strict"]),
        0,
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
