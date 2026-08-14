import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("a refused share leaves the data repo as it was (GIT-7)", () => {
  test(
    "a rejecting hook takes the generated source back out, so a retry works",
    async () => {
      const project = await tempRepo("capshelf-share-hook-project-");
      const dataRepo = await tempRepo("capshelf-share-hook-data-");
      const run = runInProcess(project);
      await writeFile(join(dataRepo, "README.md"), "baseline\n");
      await commitAll(dataRepo, "baseline");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

      const from = join(project, "server.json");
      await writeFile(
        from,
        `${JSON.stringify({ mcpServers: { server: { command: "x" } } })}\n`,
      );
      const hook = join(dataRepo, ".git", "hooks", "pre-commit");
      await mkdir(join(dataRepo, ".git", "hooks"), { recursive: true });
      await writeFile(
        hook,
        ["#!/bin/sh", "echo 'no shares today' >&2", "exit 1", ""].join("\n"),
      );
      await chmod(hook, 0o755);
      const headBefore = (
        await $`git -C ${dataRepo} rev-parse HEAD`.quiet()
      ).stdout
        .toString()
        .trim();

      const refused = await run([
        "share",
        "mcp/server",
        "--target",
        "claude",
        "--from",
        from,
      ]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toString()).toContain("no shares today");
      expect(
        (await $`git -C ${dataRepo} rev-parse HEAD`.quiet()).stdout
          .toString()
          .trim(),
      ).toBe(headBefore);
      // No leftover source: `share` refuses a canonical path that already
      // exists, so leaving one behind would make the retry impossible. The
      // empty parent directory is left, which git does not track and the
      // next attempt does not see.
      expect(existsSync(join(dataRepo, "mcp", "server", "claude.json"))).toBe(
        false,
      );
      expect(
        (await $`git -C ${dataRepo} status --porcelain`.quiet().text()).trim(),
      ).toBe("");

      await rm(hook);
      const retried = await run([
        "share",
        "mcp/server",
        "--target",
        "claude",
        "--from",
        from,
      ]);
      expect(retried.exitCode).toBe(0);
      expect(
        await readFile(join(dataRepo, "mcp", "server", "claude.json"), "utf-8"),
      ).toContain('"command":"x"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("a refused fragment promote restores only the index (GIT-7)", () => {
  test(
    "a rejecting hook keeps the canonical edit and stages nothing",
    async () => {
      const project = await tempRepo("capshelf-fragment-hook-project-");
      const dataRepo = await tempRepo("capshelf-fragment-hook-data-");
      const run = runInProcess(project);
      const source = join(dataRepo, "settings", "base", "settings.json");
      await mkdir(join(dataRepo, "settings", "base"), { recursive: true });
      await writeFile(source, `${JSON.stringify({ env: { A: "1" } })}\n`);
      await commitAll(dataRepo, "settings base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/base"])).exitCode).toBe(0);

      await writeFile(source, `${JSON.stringify({ env: { A: "2" } })}\n`);
      const hook = join(dataRepo, ".git", "hooks", "pre-commit");
      await mkdir(join(dataRepo, ".git", "hooks"), { recursive: true });
      await writeFile(
        hook,
        ["#!/bin/sh", "echo 'no fragments today' >&2", "exit 1", ""].join("\n"),
      );
      await chmod(hook, 0o755);
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lockBefore = await readFile(lockPath, "utf-8");
      const headBefore = (
        await $`git -C ${dataRepo} rev-parse HEAD`.quiet()
      ).stdout
        .toString()
        .trim();

      const promoted = await run(["promote", "settings/base", "-m", "bump"]);

      expect(promoted.exitCode).not.toBe(0);
      expect(promoted.stderr.toString()).toContain("no fragments today");
      expect(
        (await $`git -C ${dataRepo} rev-parse HEAD`.quiet()).stdout
          .toString()
          .trim(),
      ).toBe(headBefore);
      // The edit being promoted is the user's own file: it survives, and the
      // command that failed leaves nothing staged for them to clean up.
      expect(await readFile(source, "utf-8")).toBe(
        `${JSON.stringify({ env: { A: "2" } })}\n`,
      );
      expect(
        (
          await $`git -C ${dataRepo} diff --cached --name-only`.quiet().text()
        ).trim(),
      ).toBe("");
      expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

/**
 * GIT-9. `promote --merge` used to pick its commit mechanism from whether the
 * data repo had a Codex marketplace: with one it committed through the
 * marketplace transaction and ran the repository's hooks, without one it
 * committed through `commit-tree` and ran none. Both configurations now take
 * the same path, so both must produce the same outcome.
 */
describe("promote --merge runs the data repo's hooks (GIT-9)", () => {
  async function mergeFixture(
    prefix: string,
    codex: boolean,
  ): Promise<{
    project: string;
    dataRepo: string;
    run: ReturnType<typeof runInProcess>;
    installed: string;
    dataItem: string;
  }> {
    const project = await tempRepo(`${prefix}-project-`);
    const dataRepo = await tempRepo(`${prefix}-data-`);
    await addSkill(dataRepo, "hello", "base\n");
    await commitAll(dataRepo, "hello base");
    if (codex) {
      const inData = runInProcess(dataRepo);
      expect(
        (
          await inData([
            "--data",
            dataRepo,
            "marketplace",
            "init",
            "--target",
            "codex",
            "--name",
            "company-codex",
            "--owner",
            "Engineering",
          ])
        ).exitCode,
      ).toBe(0);
    }
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    // Disjoint edits: upstream adds one file, the project adds another.
    const dataItem = join(dataRepo, "skills", "hello");
    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".agents", "skills", "hello");
    await writeFile(join(installed, "local.txt"), "local\n");
    return { project, dataRepo, run, installed, dataItem };
  }

  async function writeHook(dataRepo: string, body: string[]): Promise<void> {
    const hook = join(dataRepo, ".git", "hooks", "pre-commit");
    await mkdir(join(dataRepo, ".git", "hooks"), { recursive: true });
    await writeFile(hook, ["#!/bin/sh", ...body, ""].join("\n"));
    await chmod(hook, 0o755);
  }

  async function head(dataRepo: string): Promise<string> {
    return (
      await $`git -C ${dataRepo} rev-parse HEAD`.quiet()
    ).stdout.toString();
  }

  test(
    "a rejecting hook stops the merge and unwinds it, either configuration",
    async () => {
      for (const codex of [false, true]) {
        const f = await mergeFixture(`capshelf-merge-reject-${codex}`, codex);
        await writeHook(f.dataRepo, [
          "echo 'refused by the data repo pre-commit hook' >&2",
          "exit 1",
        ]);
        const lockPath = join(f.project, ".capshelf", "capshelf.lock.json");
        const headBefore = await head(f.dataRepo);
        const lockBefore = await readFile(lockPath, "utf-8");

        const result = await f.run([
          "promote",
          "skills/hello",
          "--merge",
          "-m",
          "merge",
        ]);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "refused by the data repo pre-commit hook",
        );
        expect(await head(f.dataRepo)).toBe(headBefore);
        expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
        // The data repo is exactly as it was: no merged file, upstream intact.
        expect(existsSync(join(f.dataItem, "local.txt"))).toBe(false);
        expect(await readFile(join(f.dataItem, "SKILL.md"), "utf-8")).toBe(
          "base\n",
        );
        expect(await readFile(join(f.dataItem, "upstream.txt"), "utf-8")).toBe(
          "upstream\n",
        );
        expect(
          (await $`git -C ${f.dataRepo} status --porcelain`.text()).trim(),
        ).toBe("");
        // The project keeps its edit and has not taken the merge result.
        expect(await readFile(join(f.installed, "local.txt"), "utf-8")).toBe(
          "local\n",
        );
        expect(existsSync(join(f.installed, "upstream.txt"))).toBe(false);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a hook that rewrites a merged file is refused, either configuration",
    async () => {
      for (const codex of [false, true]) {
        const f = await mergeFixture(`capshelf-merge-rewrite-${codex}`, codex);
        await writeHook(f.dataRepo, [
          `printf 'rewritten by a hook\\n' > ${JSON.stringify(
            join(f.dataItem, "local.txt"),
          )}`,
          "git add skills/hello/local.txt",
        ]);
        const headBefore = await head(f.dataRepo);

        const result = await f.run([
          "promote",
          "skills/hello",
          "--merge",
          "-m",
          "merge",
        ]);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "the committed content is not the content this project holds",
        );
        expect(await head(f.dataRepo)).toBe(headBefore);
        expect(existsSync(join(f.dataItem, "local.txt"))).toBe(false);
        expect(await readFile(join(f.installed, "local.txt"), "utf-8")).toBe(
          "local\n",
        );
        expect(
          (await $`git -C ${f.dataRepo} status --porcelain`.text()).trim(),
        ).toBe("");
      }
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
