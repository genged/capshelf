import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  rejection,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";
import { PreconditionError } from "../src/errors";
import { assertCommittedTreeEqualsCandidate } from "../src/promote-proof";

/**
 * PIN-11 and the lock-writer gate.
 *
 * The proof is `A == B`: what the project held equals the tree the commit
 * produced. A destination-side check cannot see the difference, because a
 * `pre-commit` hook rewrites the worktree *and* the commit, so both sides of
 * that check agree on content the project never had.
 */
describe("promote proves the commit equals the selected candidate (PIN-11)", () => {
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
        "the committed content is not the selected publication content",
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
    "a fragment promote commits the canonical candidate it captured",
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
      // in the data repo. Its candidate is those exact canonical bytes.
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

describe("a file the data repo ignores refuses the publication before the commit", () => {
  async function promoteFixture(prefix: string): Promise<{
    project: string;
    dataRepo: string;
    installed: string;
    run: ReturnType<typeof runInProcess>;
  }> {
    const project = await tempRepo(`${prefix}-project-`);
    const dataRepo = await tempRepo(`${prefix}-data-`);
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "upstream v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    return {
      project,
      dataRepo,
      installed: join(project, ".agents", "skills", "hello"),
      run,
    };
  }

  async function head(repo: string): Promise<string> {
    return (await $`git -C ${repo} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
  }

  test(
    "an ignored file in the item exits 3, names the rule, and changes nothing",
    async () => {
      const { project, dataRepo, installed, run } = await promoteFixture(
        "capshelf-ignore-pyc",
      );
      await writeFile(join(dataRepo, ".gitignore"), "__pycache__/\n");
      await commitAll(dataRepo, "ignore pycache");
      await writeFile(join(installed, "SKILL.md"), "project edit\n");
      await mkdir(join(installed, "scripts", "__pycache__"), {
        recursive: true,
      });
      await writeFile(
        join(installed, "scripts", "__pycache__", "x.pyc"),
        "pyc",
      );
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lockBefore = await readFile(lockPath, "utf-8");
      const headBefore = await head(dataRepo);

      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);

      expect(promoted.exitCode).toBe(3);
      const stderr = promoted.stderr.toString();
      expect(stderr).toContain(
        "the data repo ignores files that this commit must contain",
      );
      expect(stderr).toContain("skills/hello/scripts/__pycache__/x.pyc");
      expect(stderr).toContain("ignored by .gitignore:1  __pycache__/");
      expect(stderr).toContain("remove the rule from the data repo");
      expect(stderr).not.toContain("rewrote the file");
      expect(await head(dataRepo)).toBe(headBefore);
      expect(
        await readFile(join(dataRepo, "skills", "hello", "SKILL.md"), "utf-8"),
      ).toBe("upstream v1\n");
      expect(existsSync(join(dataRepo, "skills", "hello", "scripts"))).toBe(
        false,
      );
      expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a tracked file that matches a rule changes, a deletion commits, and nothing refuses",
    async () => {
      const project = await tempRepo("capshelf-ignore-tracked-project-");
      const dataRepo = await tempRepo("capshelf-ignore-tracked-data-");
      const run = runInProcess(project);
      const root = await addSkill(dataRepo, "hello", "upstream v1\n");
      await writeFile(join(root, "notes.pyc"), "v1");
      await writeFile(join(root, "extra.txt"), "extra");
      await writeFile(join(dataRepo, ".gitignore"), "*.pyc\n");
      await $`git -C ${dataRepo} add -A`.quiet();
      await $`git -C ${dataRepo} add -f skills/hello/notes.pyc`.quiet();
      await $`git -C ${dataRepo} commit -qm baseline`.quiet();
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "hello");
      await writeFile(join(installed, "notes.pyc"), "v2");
      await rm(join(installed, "extra.txt"));

      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);

      expect(promoted.stderr.toString()).toBe("");
      expect(promoted.exitCode).toBe(0);
      expect(
        await $`git -C ${dataRepo} show HEAD:skills/hello/notes.pyc`
          .quiet()
          .text(),
      ).toBe("v2");
      const tree = await $`git -C ${dataRepo} ls-tree -r --name-only HEAD`
        .quiet()
        .text();
      expect(tree).not.toContain("skills/hello/extra.txt");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a rule that the item itself supplies is named as written by the commit",
    async () => {
      const { project, installed, run } = await promoteFixture(
        "capshelf-ignore-own-rule",
      );
      await writeFile(join(installed, ".gitignore"), "*.log\n");
      await writeFile(join(installed, "notes.log"), "log");
      // Project scope reads what project Git tracks, so a tracked file stays
      // selected even when the item's own `.gitignore` matches it.
      await $`git -C ${project} add -f .agents/skills/hello/.gitignore .agents/skills/hello/notes.log`.quiet();

      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);

      expect(promoted.exitCode).toBe(3);
      const stderr = promoted.stderr.toString();
      expect(stderr).toContain("ignored by skills/hello/.gitignore:1  *.log");
      expect(stderr).toContain(
        "the rule comes from skills/hello/.gitignore, which this commit writes;",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an ignored upstream sidecar that promote restores unchanged still passes",
    async () => {
      const { dataRepo, installed, run } = await promoteFixture(
        "capshelf-ignore-kept-sidecar",
      );
      await writeFile(join(dataRepo, ".gitignore"), ".capshelf.yml\n");
      await commitAll(dataRepo, "ignore sidecars");
      await writeFile(
        join(dataRepo, "skills", "hello", ".capshelf.yml"),
        "needs: []\n",
      );
      await writeFile(join(installed, "SKILL.md"), "project edit\n");

      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);

      expect(promoted.stderr.toString()).toBe("");
      expect(promoted.exitCode).toBe(0);
      expect(
        await readFile(
          join(dataRepo, "skills", "hello", ".capshelf.yml"),
          "utf-8",
        ),
      ).toBe("needs: []\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a sidecar that the project item supplies is not exempt, even with the same bytes",
    async () => {
      const { dataRepo, installed, run } = await promoteFixture(
        "capshelf-ignore-own-sidecar",
      );
      await writeFile(join(dataRepo, ".gitignore"), ".capshelf.yml\n");
      await commitAll(dataRepo, "ignore sidecars");
      await writeFile(
        join(dataRepo, "skills", "hello", ".capshelf.yml"),
        "needs: []\n",
      );
      await writeFile(join(installed, ".capshelf.yml"), "needs: []\n");
      await writeFile(join(installed, "SKILL.md"), "project edit\n");
      const headBefore = await head(dataRepo);

      const promoted = await run(["promote", "skills/hello", "-m", "publish"]);

      expect(promoted.exitCode).toBe(3);
      expect(promoted.stderr.toString()).toContain(
        "skills/hello/.capshelf.yml",
      );
      expect(await head(dataRepo)).toBe(headBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a fragment share into an ignored path exits 3 with the rule, not Git's stderr",
    async () => {
      const project = await tempRepo("capshelf-ignore-share-project-");
      const dataRepo = await tempRepo("capshelf-ignore-share-data-");
      const run = runInProcess(project);
      await writeFile(join(dataRepo, ".gitignore"), "mcp/\n");
      await commitAll(dataRepo, "ignore mcp");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      const from = join(project, "server.json");
      await writeFile(
        from,
        `${JSON.stringify({ mcpServers: { server: { command: "x" } } })}\n`,
      );
      const headBefore = await head(dataRepo);

      const refused = await run([
        "share",
        "mcp/server",
        "--target",
        "claude",
        "--from",
        from,
      ]);

      expect(refused.exitCode).toBe(3);
      const stderr = refused.stderr.toString();
      expect(stderr).toContain("mcp/server/claude.json");
      expect(stderr).toContain("ignored by .gitignore:1  mcp/");
      expect(stderr).not.toContain("Use -f if you really want to add them");
      expect(await head(dataRepo)).toBe(headBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("the PIN-11 refusal names an ignore rule for an absent row", () => {
  test(
    "an anchored item-local rule is found, and a ! re-include is not reported",
    async () => {
      const dataRepo = await tempRepo("capshelf-proof-rule-data-");
      const root = await addSkill(dataRepo, "s", "v1\n");
      // Anchored to the item directory: it matches only the full repo path
      // `skills/s/x.pyc`, never the item-relative `x.pyc`.
      await writeFile(join(root, ".gitignore"), "/x.pyc\n*.log\n!keep.log\n");
      await commitAll(dataRepo, "skill");
      const commit = (
        await $`git -C ${dataRepo} rev-parse HEAD`.quiet().text()
      ).trim();
      const file = (path: string, text: string) => ({
        path,
        mode: "100644" as const,
        content: Buffer.from(text),
      });

      const error = await rejection(
        assertCommittedTreeEqualsCandidate({
          dataRepo,
          kind: "skills",
          name: "s",
          commit,
          candidateFiles: [
            file(".gitignore", "/x.pyc\n*.log\n!keep.log\n"),
            file("SKILL.md", "v1\n"),
            file("keep.log", "kept"),
            file("x.pyc", "pyc"),
          ],
        }),
        PreconditionError,
      );

      const lines = error.message.split("\n");
      const pycRow = lines.findIndex((line) => line.includes("x.pyc "));
      expect(lines[pycRow + 1]).toBe(
        "      ignored by skills/s/.gitignore:1  /x.pyc",
      );
      const keepRow = lines.findIndex((line) => line.includes("keep.log "));
      expect(lines[keepRow + 1]).not.toContain("ignored by");
      expect(error.message).toContain(
        "possible causes in the data repo: an ignore rule, a pre-commit hook,",
      );
      expect(error.message).not.toContain("rewrote the file");
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

  test(
    "a hook rewrite cannot publish bytes outside the captured candidate",
    async () => {
      const project = await tempRepo("capshelf-fragment-rewrite-project-");
      const dataRepo = await tempRepo("capshelf-fragment-rewrite-data-");
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
        [
          "#!/bin/sh",
          `printf '%s\\n' '${JSON.stringify({ env: { A: "3" } })}' > settings/base/settings.json`,
          "git add settings/base/settings.json",
          "",
        ].join("\n"),
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
      expect(promoted.stderr.toString()).toContain(
        "the committed content is not the selected publication content",
      );
      expect(
        (await $`git -C ${dataRepo} rev-parse HEAD`.quiet()).stdout
          .toString()
          .trim(),
      ).toBe(headBefore);
      expect(
        (
          await $`git -C ${dataRepo} diff --cached --name-only`.quiet().text()
        ).trim(),
      ).toBe("");
      // The transaction never restores the worktree. It leaves the hook's
      // edit visible, but it does not accept or record that edit.
      expect(await readFile(source, "utf-8")).toBe(
        `${JSON.stringify({ env: { A: "3" } })}\n`,
      );
      expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
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
