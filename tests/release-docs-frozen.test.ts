import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_INTEGRATION_TEST_TIMEOUT_MS, tempDir } from "./cli-fixtures";
import { initRepo } from "./git-fixtures";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "scripts",
  "check-release-docs-frozen.sh",
);

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function check(repo: string, args: string[] = []): Result {
  const run = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    cwd: repo,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

async function notesRepo(): Promise<string> {
  const repo = await tempDir("capshelf-frozen-notes-");
  await initRepo(repo);
  await mkdir(join(repo, "docs", "release-notes"), { recursive: true });
  await writeFile(
    join(repo, "docs", "release-notes", "release-notes-1.0.0.md"),
    "# 1.0.0\n\n- shipped\n",
  );
  await writeFile(join(repo, "docs", "whats-new-1.0.md"), "# 1.0\n\nDetail.\n");
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${"add 1.0.0 release docs"}`.quiet();
  await $`git -C ${repo} tag v1.0.0`.quiet();
  return repo;
}

describe("release documentation freeze", () => {
  test(
    "passes on a clean tree and on a newly added note",
    async () => {
      const repo = await notesRepo();
      expect(check(repo, ["--base", "v1.0.0"]).exitCode).toBe(0);

      await writeFile(
        join(repo, "docs", "release-notes", "release-notes-1.1.0.md"),
        "# 1.1.0\n",
      );
      await $`git -C ${repo} add -A`.quiet();
      const added = check(repo, ["--base", "v1.0.0"]);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain("is frozen");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses an edit whether it is unstaged, staged, or committed",
    async () => {
      const note = "docs/release-notes/release-notes-1.0.0.md";
      const edited = "# 1.0.0\n\n- edited\n";

      const unstaged = await notesRepo();
      await writeFile(join(unstaged, note), edited);
      const dirty = check(unstaged);
      expect(dirty.exitCode).toBe(1);
      expect(dirty.stdout).toContain("has changed since v1.0.0 was tagged");

      const staged = await notesRepo();
      await writeFile(join(staged, note), edited);
      await $`git -C ${staged} add -A`.quiet();
      expect(check(staged).exitCode).toBe(1);

      const committed = await notesRepo();
      await writeFile(join(committed, note), edited);
      await $`git -C ${committed} commit -qam ${"edit a released note"}`.quiet();
      expect(check(committed).exitCode).toBe(1);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "fails when a released note no longer matches its tag",
    async () => {
      const note = "docs/release-notes/release-notes-1.0.0.md";

      // The failure must survive the edit being committed, since the contract
      // is the tagged tree.
      const repo = await notesRepo();
      await writeFile(
        join(repo, note),
        "# 1.0.0\n\n- rewritten after release\n",
      );
      await $`git -C ${repo} commit -qam ${"rewrite a shipped note"}`.quiet();
      await writeFile(join(repo, "unrelated.txt"), "later work\n");
      await $`git -C ${repo} add -A`.quiet();
      await $`git -C ${repo} commit -qm ${"unrelated later commit"}`.quiet();

      const drifted = check(repo);
      expect(drifted.exitCode).toBe(1);
      expect(drifted.stdout).toContain("has changed since v1.0.0 was tagged");

      await $`git -C ${repo} checkout v1.0.0 -- ${note}`.quiet();
      await $`git -C ${repo} commit -qam ${"restore the shipped note"}`.quiet();
      expect(check(repo).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses a restore too, because there is no legitimate edit",
    async () => {
      const note = "docs/release-notes/release-notes-1.0.0.md";
      const repo = await notesRepo();
      await writeFile(join(repo, note), "# 1.0.0\n\n- rewritten\n");
      await $`git -C ${repo} commit -qam ${"rewrite a shipped note"}`.quiet();
      expect(check(repo).exitCode).toBe(1);

      // A restore still counts as an edit: an unpushed mistake is fixed by
      // amending the commit, and a pushed one is already live.
      await $`git -C ${repo} checkout v1.0.0 -- ${note}`.quiet();
      const restored = check(repo);
      expect(restored.exitCode).toBe(1);
      expect(restored.stdout).toContain(`${note} modified`);

      await $`git -C ${repo} reset -q --soft HEAD~1`.quiet();
      await $`git -C ${repo} reset -q`.quiet();
      expect(check(repo).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "still freezes an untagged draft note once it is committed",
    async () => {
      const repo = await notesRepo();
      const draft = "docs/release-notes/release-notes-9.9.9.md";
      await writeFile(join(repo, draft), "# 9.9.9\n");
      await $`git -C ${repo} add -A`.quiet();
      await $`git -C ${repo} commit -qm ${"add 9.9.9 draft"}`.quiet();

      await writeFile(join(repo, draft), "# 9.9.9\n\n- edited\n");
      const edited = check(repo);
      expect(edited.exitCode).toBe(1);
      expect(edited.stdout).toContain(`${draft} modified`);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "fails when a released note is deleted outright",
    async () => {
      const repo = await notesRepo();
      await $`git -C ${repo} rm -q docs/release-notes/release-notes-1.0.0.md`.quiet();
      await $`git -C ${repo} commit -qm ${"delete a shipped note"}`.quiet();
      const result = check(repo);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("shipped in v1.0.0");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "freezes the What's New page on the same terms as the release note",
    async () => {
      const page = "docs/whats-new-1.0.md";
      const repo = await notesRepo();
      await writeFile(join(repo, page), "# 1.0\n\nDetail.\n\n## Added later\n");
      await $`git -C ${repo} commit -qam ${"extend a shipped page"}`.quiet();

      const drifted = check(repo);
      expect(drifted.exitCode).toBe(1);
      expect(drifted.stdout).toContain(`${page} has changed since v1.0.0`);

      await $`git -C ${repo} reset -q --hard HEAD~1`.quiet();
      expect(check(repo).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "grandfathers What's New pages from before the policy",
    async () => {
      // Pre-0.6 pages were revised after tagging and can't be fixed, so
      // freezing them would leave the gate permanently red; release notes are
      // enforced from the first.
      const repo = await notesRepo();
      await mkdir(join(repo, "docs", "release-notes"), { recursive: true });
      await writeFile(join(repo, "docs", "whats-new-0.5.md"), "# 0.5\n");
      await writeFile(
        join(repo, "docs", "release-notes", "release-notes-0.5.0.md"),
        "# 0.5.0\n",
      );
      await $`git -C ${repo} add -A`.quiet();
      await $`git -C ${repo} commit -qm ${"add 0.5 release docs"}`.quiet();
      await $`git -C ${repo} tag v0.5.0`.quiet();

      await writeFile(
        join(repo, "docs", "whats-new-0.5.md"),
        "# 0.5\n\nlater\n",
      );
      await $`git -C ${repo} commit -qam ${"revise an old page"}`.quiet();
      expect(check(repo).exitCode).toBe(0);

      await writeFile(
        join(repo, "docs", "release-notes", "release-notes-0.5.0.md"),
        "# 0.5.0\n\nlater\n",
      );
      await $`git -C ${repo} commit -qam ${"revise an old note"}`.quiet();
      const result = check(repo);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("release-notes-0.5.0.md has changed");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses removing the notes directory wholesale",
    async () => {
      // The check reads from tags, not the worktree, so a deleted notes
      // directory must still fail.
      const repo = await notesRepo();
      await rm(join(repo, "docs", "release-notes"), { recursive: true });
      const result = check(repo);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("is missing but shipped in v1.0.0");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "audit reports post-creation edits and says which landed after the tag",
    async () => {
      const repo = await notesRepo();
      const note = "docs/release-notes/release-notes-1.0.0.md";

      await writeFile(join(repo, note), "# 1.0.0\n\n- drafted\n");
      await $`git -C ${repo} commit -qam ${"draft edit"}`.quiet();
      await $`git -C ${repo} tag -f v1.0.0`.quiet();
      await writeFile(join(repo, note), "# 1.0.0\n\n- late edit\n");
      await $`git -C ${repo} commit -qam ${"late edit"}`.quiet();

      const audit = check(repo, ["--audit"]);
      expect(audit.exitCode).toBe(1);
      expect(audit.stdout).toContain(note);
      expect(audit.stdout).toContain("before v1.0.0 was tagged");
      expect(audit.stdout).toContain("after v1.0.0 was tagged");

      const untagged = await notesRepo();
      const draft = "docs/release-notes/release-notes-9.9.9.md";
      await writeFile(join(untagged, draft), "# 9.9.9\n");
      await $`git -C ${untagged} add -A`.quiet();
      await $`git -C ${untagged} commit -qm ${"add 9.9.9"}`.quiet();
      await writeFile(join(untagged, draft), "# 9.9.9\n\n- more\n");
      await $`git -C ${untagged} commit -qam ${"edit 9.9.9"}`.quiet();
      const draftAudit = check(untagged, ["--audit"]);
      expect(draftAudit.exitCode).toBe(1);
      expect(draftAudit.stdout).toContain("version never tagged");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "passes an audit when no frozen document was ever edited",
    async () => {
      const repo = await notesRepo();
      const clean = check(repo, ["--audit"]);
      expect(clean.exitCode).toBe(0);
      expect(clean.stdout).toContain(
        "no frozen release document has been edited",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
