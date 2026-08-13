import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

/**
 * PIN-11 and the lock-writer gate.
 *
 * The proof is `A == B`: what the project held equals the tree the commit
 * produced. A destination-side check cannot see the difference, because a
 * `pre-commit` hook rewrites the worktree *and* the commit, so both sides of
 * that check agree on content the project never had.
 */
describe("promote proves the commit equals the project (PIN-11)", () => {
  test(
    "a pre-commit hook that rewrites a file refuses the promotion and rolls back",
    async () => {
      const project = await tempRepo("capshelf-proof-project-");
      const dataRepo = await tempRepo("capshelf-proof-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "upstream v1\n");
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello");
      await writeFile(join(installed, "SKILL.md"), "project edit\n");

      const hook = join(dataRepo, ".git", "hooks", "pre-commit");
      await mkdir(join(dataRepo, ".git", "hooks"), { recursive: true });
      await writeFile(
        hook,
        [
          "#!/bin/sh",
          `printf 'rewritten by a hook\\n' > ${JSON.stringify(
            join(dataRepo, "skills", "hello", "SKILL.md"),
          )}`,
          "git add skills/hello/SKILL.md",
          "",
        ].join("\n"),
      );
      await chmod(hook, 0o755);

      const headBefore = (
        await $`git -C ${dataRepo} rev-parse HEAD`.quiet()
      ).stdout
        .toString()
        .trim();
      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);
      expect(promoted.exitCode).not.toBe(0);
      expect(promoted.stderr.toString()).toContain(
        "the committed content is not the content this project holds",
      );

      // Rolled back: HEAD, the worktree, and the lock are all where they were.
      expect(
        (await $`git -C ${dataRepo} rev-parse HEAD`.quiet()).stdout
          .toString()
          .trim(),
      ).toBe(headBefore);
      expect(
        await readFile(join(dataRepo, "skills", "hello", "SKILL.md"), "utf-8"),
      ).toBe("upstream v1\n");
      expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toBe(
        "project edit\n",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a fragment promote has no project snapshot and is unaffected by the rule",
    async () => {
      const project = await tempRepo("capshelf-proof-fragment-project-");
      const dataRepo = await tempRepo("capshelf-proof-fragment-data-");
      const run = runInProcess(project);
      await mkdir(join(dataRepo, "settings", "base"), { recursive: true });
      await writeFile(
        join(dataRepo, "settings", "base", "settings.json"),
        `${JSON.stringify({ env: { A: "1" } }, null, 2)}\n`,
      );
      await commitAll(dataRepo, "settings base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/base"])).exitCode).toBe(0);

      // A fragment promote commits the user's own edit where it already lives
      // in the data repo. There is no `A` to compare, so applying `A == B`
      // here would refuse a legitimate operation.
      await writeFile(
        join(dataRepo, "settings", "base", "settings.json"),
        `${JSON.stringify({ env: { A: "2" } }, null, 2)}\n`,
      );
      const promoted = await run(["promote", "settings/base", "-m", "bump"]);
      expect(promoted.exitCode).toBe(0);

      const lock = await file(
        join(project, ".capshelf", "capshelf.lock.json"),
      ).json();
      expect(lock.items["data/settings/base"].sourcePinDigest).toMatch(
        /^[0-9a-f]{64}$/,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("ordinary lock writers refuse an unmigrated lock", () => {
  test(
    "add, update, keep-local, move, rm, and revert all point at lock migrate",
    async () => {
      const project = await tempRepo("capshelf-gate-project-");
      const dataRepo = await tempRepo("capshelf-gate-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "hello v1\n");
      await addSkill(dataRepo, "other", "other v1\n");
      await commitAll(dataRepo, "skills");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf-8"));
      const entry = lock.items["data/skills/hello"];
      lock.version = 3;
      lock.items["data/skills/hello"] = {
        source: "data",
        sha: "0123456789ab",
        sourceCommit: entry.sourceCommit,
        appliedAt: entry.appliedAt,
        needs: entry.needs,
        needsSourceCommit: entry.needsSourceCommit,
      };
      const legacyBytes = `${JSON.stringify(lock, null, 2)}\n`;
      await writeFile(lockPath, legacyBytes);

      for (const args of [
        ["add", "skills/other"],
        ["update", "skills/hello"],
        ["keep-local", "skills/hello", "--reason", "x"],
        ["move", "skills/hello", "--to", "local"],
        ["rm", "skills/hello", "--yes"],
        ["revert", "skills/hello", "--yes"],
      ]) {
        const result = await run(args);
        expect(result.exitCode).not.toBe(0);
        const output = `${result.stdout.toString()}${result.stderr.toString()}`;
        expect(output).toContain("capshelf lock migrate");
      }

      // Nothing was written by any of them.
      expect(await readFile(lockPath, "utf-8")).toBe(legacyBytes);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
