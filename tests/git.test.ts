import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitUnavailableError,
  aheadBehind,
  assertIsGitRepo,
  assertPathClean,
  assertRepoClean,
  assertRepoCleanOutsidePath,
  commitExistingPaths,
  commitInRepo,
  commitParents,
  currentBranch,
  fastForwardTo,
  fetchOrigin,
  sourceWriteBuffer,
  sourceVisibleFilesUnderPath,
  headSha,
  isPathClean,
  isRepoClean,
  lastTouchingCommit,
  lastTouchingContentCommit,
  lsTreeAtCommit,
  normalizeRemoteUrl,
  showAtCommit,
  statusPorcelainOutsidePath,
  statusPorcelainRecords,
  trackingRef,
} from "../src/git";

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-git-"));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("git cleanliness helpers", () => {
  test("assertIsGitRepo reports missing git before repo validity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-no-git-"));
    const oldPath = process.env.PATH;
    const emptyPath = await mkdtemp(join(tmpdir(), "capshelf-empty-path-"));
    process.env.PATH = emptyPath;
    try {
      await assertIsGitRepo(dir);
      throw new Error("expected assertIsGitRepo to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GitUnavailableError);
      expect((err as GitUnavailableError).exitCode).toBe(7);
      expect((err as Error).message).toMatch(
        /git is required but was not found on PATH/,
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("assertIsGitRepo rejects non-repos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-not-git-"));
    await expect(assertIsGitRepo(dir)).rejects.toThrow(/not a git repository/);
  });

  test("detect clean repos and dirty item paths", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(repo, "baseline");

    expect(await isRepoClean(repo)).toBe(true);
    expect(await isPathClean(repo, "skills/hello")).toBe(true);

    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "dirty\n");

    expect(await isRepoClean(repo)).toBe(false);
    expect(await isPathClean(repo, "skills/hello")).toBe(false);
    await expect(assertPathClean(repo, "skills/hello")).rejects.toThrow(
      /under skills\/hello/,
    );
    await expect(assertRepoClean(repo)).rejects.toThrow(/uncommitted changes/);
  });

  test("allows unrelated dirty files inside the promoted path", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(join(repo, "README.md"), "readme\n");
    await commitAll(repo, "baseline");

    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "dirty\n");

    await expect(
      assertRepoCleanOutsidePath(repo, "skills/hello"),
    ).resolves.toBe(undefined);
  });

  test("detects changes outside a promoted path", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(join(repo, "README.md"), "readme\n");
    await commitAll(repo, "baseline");

    await writeFile(join(repo, "README.md"), "dirty\n");

    const outside = await statusPorcelainOutsidePath(repo, "skills/hello");
    expect(outside).toContain("README.md");
    await expect(
      assertRepoCleanOutsidePath(repo, "skills/hello"),
    ).rejects.toThrow(/outside skills\/hello/);
  });

  test("commitInRepo commits only requested paths", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(join(repo, "README.md"), "readme\n");
    await commitAll(repo, "baseline");

    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello v2\n");
    await writeFile(join(repo, "README.md"), "staged unrelated\n");
    await $`git -C ${repo} add README.md`.quiet();

    const commit = await commitInRepo(repo, ["skills/hello"], "update hello");

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await file(join(repo, "skills", "hello", "SKILL.md")).text()).toBe(
      "hello v2\n",
    );

    const status = await $`git -C ${repo} status --porcelain`.quiet().text();
    expect(status).toContain("README.md");

    const committedFiles =
      await $`git -C ${repo} diff-tree --no-commit-id --name-only -r HEAD`
        .quiet()
        .text();
    expect(committedFiles.trim()).toBe("skills/hello/SKILL.md");
  });

  test("sourceVisibleFilesUnderPath returns tracked and untracked non-ignored files", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), "*.local\nignored-dir/\n");
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(join(repo, "skills", "hello", ".env.1password"), "op\n");
    await writeFile(join(repo, "skills", "hello", ".env.local"), "secret\n");
    await mkdir(join(repo, "skills", "hello", "ignored-dir"), {
      recursive: true,
    });
    await writeFile(join(repo, "skills", "hello", "ignored-dir", "x"), "x\n");
    await commitAll(repo, "baseline");

    await writeFile(join(repo, "skills", "hello", "notes.md"), "notes\n");

    expect(await sourceVisibleFilesUnderPath(repo, "skills/hello")).toEqual([
      ".env.1password",
      "SKILL.md",
      "notes.md",
    ]);
  });

  test("sourceVisibleFilesUnderPath excludes deleted tracked files from the working snapshot", async () => {
    const repo = await tempRepo();
    const item = join(repo, "skills", "hello");
    await mkdir(item, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "*.ignored\n");
    await writeFile(join(item, "keep.txt"), "base\n");
    await writeFile(join(item, "deleted.txt"), "delete me\n");
    await commitAll(repo, "baseline");

    await writeFile(join(item, "keep.txt"), "modified\n");
    await rm(join(item, "deleted.txt"));
    await writeFile(join(item, "new.txt"), "untracked\n");
    await writeFile(join(item, "secret.ignored"), "ignored\n");

    expect(await sourceVisibleFilesUnderPath(repo, "skills/hello")).toEqual([
      "keep.txt",
      "new.txt",
    ]);
  });
});

describe("git historical content helpers", () => {
  test("reads last-touching commits and content at a commit", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello v1\n");
    await commitAll(repo, "baseline");
    const firstCommit = await lastTouchingCommit(repo, "skills/hello");

    await writeFile(join(repo, "README.md"), "unrelated\n");
    await commitAll(repo, "unrelated");

    expect(await lastTouchingCommit(repo, "skills/hello")).toBe(firstCommit);
    expect(
      (await showAtCommit(repo, firstCommit, "skills/hello/SKILL.md")).toString(
        "utf-8",
      ),
    ).toBe("hello v1\n");
    expect(await lsTreeAtCommit(repo, firstCommit, "skills/hello")).toEqual([
      "skills/hello/SKILL.md",
    ]);
  });

  test("ls-tree returns non-ASCII filenames verbatim (not octal-quoted)", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    // With git's default core.quotepath=true and no -z, this path comes back as
    // "skills/hello/caf\303\251.md" and breaks every downstream `git show`.
    await writeFile(join(repo, "skills", "hello", "café.md"), "unicode\n");
    await commitAll(repo, "unicode name");
    const commit = await lastTouchingCommit(repo, "skills/hello");

    expect(await lsTreeAtCommit(repo, commit, "skills/hello")).toEqual([
      "skills/hello/café.md",
    ]);
    expect(
      (await showAtCommit(repo, commit, "skills/hello/café.md")).toString(
        "utf-8",
      ),
    ).toBe("unicode\n");
  });

  test("lastTouchingContentCommit ignores sidecar-only commits", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello v1\n");
    await commitAll(repo, "content v1");
    const contentCommit = await lastTouchingCommit(repo, "skills/hello");

    await writeFile(
      join(repo, "skills", "hello", ".capshelf.yml"),
      "tags: [a]\n",
    );
    await commitAll(repo, "sidecar only");

    // The naive lastTouchingCommit moves; the content commit does not.
    expect(await lastTouchingCommit(repo, "skills/hello")).not.toBe(
      contentCommit,
    );
    expect(await lastTouchingContentCommit(repo, "skills/hello")).toBe(
      contentCommit,
    );

    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello v2\n");
    await commitAll(repo, "content v2");
    const v2 = await lastTouchingCommit(repo, "skills/hello");
    expect(await lastTouchingContentCommit(repo, "skills/hello")).toBe(v2);
  });

  test("lastTouchingContentCommit hashes nested sidecars as content", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello", "sub"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(repo, "content");

    await writeFile(
      join(repo, "skills", "hello", "sub", ".capshelf.yml"),
      "content\n",
    );
    await commitAll(repo, "nested sidecar is content");
    const nested = await lastTouchingCommit(repo, "skills/hello");

    expect(await lastTouchingContentCommit(repo, "skills/hello")).toBe(nested);
  });

  test("lastTouchingContentCommit falls back when only the sidecar was ever committed", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(repo, "skills", "hello", ".capshelf.yml"),
      "tags: [a]\n",
    );
    await commitAll(repo, "sidecar only history");
    const onlyCommit = await lastTouchingCommit(repo, "skills/hello");

    expect(await lastTouchingContentCommit(repo, "skills/hello")).toBe(
      onlyCommit,
    );
  });

  test("lastTouchingContentCommit handles glob metacharacters in item names", async () => {
    const repo = await tempRepo();
    // "[ab]" would be a character class if the exclude pathspec were
    // glob-interpreted; :(literal,exclude) keeps it a literal path.
    await mkdir(join(repo, "skills", "x[ab]y"), { recursive: true });
    await writeFile(join(repo, "skills", "x[ab]y", "SKILL.md"), "hello\n");
    await commitAll(repo, "content");
    const contentCommit = await lastTouchingCommit(repo, "skills/x[ab]y");

    await writeFile(
      join(repo, "skills", "x[ab]y", ".capshelf.yml"),
      "tags: [a]\n",
    );
    await commitAll(repo, "sidecar only");

    expect(await lastTouchingContentCommit(repo, "skills/x[ab]y")).toBe(
      contentCommit,
    );
  });

  test("assertPathClean names the sidecar when it is the only dirty path", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(repo, "baseline");

    await writeFile(
      join(repo, "skills", "hello", ".capshelf.yml"),
      "tags: [a]\n",
    );
    await expect(assertPathClean(repo, "skills/hello")).rejects.toThrow(
      /uncommitted metadata changes: skills\/hello\/\.capshelf\.yml/,
    );

    // With content dirty too, the generic message wins.
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "dirty\n");
    await expect(assertPathClean(repo, "skills/hello")).rejects.toThrow(
      /uncommitted changes under skills\/hello/,
    );
  });

  test("assertPathClean diagnoses a non-ASCII item path like its ASCII twin", async () => {
    const repo = await tempRepo();
    for (const name of ["café", "cafe"]) {
      await mkdir(join(repo, "skills", name), { recursive: true });
      await writeFile(join(repo, "skills", name, "SKILL.md"), "hello\n");
    }
    await commitAll(repo, "baseline");
    for (const name of ["café", "cafe"]) {
      await writeFile(
        join(repo, "skills", name, ".capshelf.yml"),
        "tags: []\n",
      );
    }

    // Without -z git returns "skills/caf\303\251/.capshelf.yml", which never
    // matches the expected sidecar path and takes the strict content branch.
    await expect(assertPathClean(repo, "skills/café")).rejects.toThrow(
      /uncommitted metadata changes: skills\/café\/\.capshelf\.yml/,
    );
    await expect(assertPathClean(repo, "skills/cafe")).rejects.toThrow(
      /uncommitted metadata changes: skills\/cafe\/\.capshelf\.yml/,
    );
  });

  test("statusPorcelainRecords survives quoting, renames, and literal arrows", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "d"), { recursive: true });
    await writeFile(join(repo, "d", "café.txt"), "one\n");
    await writeFile(join(repo, "d", "a -> b.txt"), "two\n");
    await commitAll(repo, "baseline");
    // Bun's `$` mis-serializes some non-Latin1 argv strings, which is why
    // capshelf runs git through Bun.spawn — see the note on gitTry.
    await sourceWriteBuffer(repo, ["mv", "d/café.txt", "d/rénamed.txt"]);
    await writeFile(join(repo, "d", "a -> b.txt"), "edited\n");
    await writeFile(join(repo, "d", 'qu"ote.txt'), "three\n");

    const records = await statusPorcelainRecords(repo, ["d"], {
      untrackedFiles: "all",
    });
    expect(
      records.map(({ code, ...rest }) => ({ code: code.trim(), ...rest })),
    ).toEqual([
      // A path containing a literal " -> " must not be mis-split.
      { code: "M", path: "d/a -> b.txt" },
      // -z puts the new path first and the original in a bare follow-on
      // record with no status prefix.
      { code: "R", path: "d/rénamed.txt", origPath: "d/café.txt" },
      { code: "??", path: 'd/qu"ote.txt' },
    ]);
  });

  test("lastTouchingCommit rejects uncommitted paths", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");

    await expect(lastTouchingCommit(repo, "skills/hello")).rejects.toThrow(
      /no commit touches/,
    );
  });
});

/**
 * GIT-7 for a commit of files the user authored in place: the index and HEAD
 * are restored, the working tree is not. Restoring the working tree would
 * discard the edit the command exists to publish.
 */
describe("commitExistingPaths", () => {
  async function fixture(): Promise<{ repo: string; source: string }> {
    const repo = await tempRepo();
    await mkdir(join(repo, "settings", "theme"), { recursive: true });
    const source = join(repo, "settings", "theme", "settings.json");
    await writeFile(source, '{"v":1}\n');
    await writeFile(join(repo, "README.md"), "readme\n");
    await commitAll(repo, "baseline");
    await writeFile(source, '{"v":2}\n');
    // Force any stat-cache refresh to happen before the index is captured.
    await $`git -C ${repo} status --porcelain`.quiet();
    return { repo, source };
  }

  async function writeHook(repo: string, body: string[]): Promise<void> {
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(hook, ["#!/bin/sh", ...body, ""].join("\n"));
    await chmod(hook, 0o755);
  }

  test("commits the edit and leaves nothing staged behind", async () => {
    const { repo, source } = await fixture();
    const before = await headSha(repo);

    const commit = await commitExistingPaths({
      repo,
      relPaths: ["settings/theme/settings.json"],
      message: "theme v2",
      expectedHead: before,
    });

    expect(commit).toBe(await headSha(repo));
    expect(await file(source).text()).toBe('{"v":2}\n');
    expect((await $`git -C ${repo} status --porcelain`.quiet().text()).trim()) //
      .toBe("");
  });

  test("a rejecting hook keeps the edit and puts the index back", async () => {
    const { repo, source } = await fixture();
    const before = await headSha(repo);
    const indexBefore = await readFile(join(repo, ".git", "index"));
    await writeHook(repo, ["echo 'hook says no' >&2", "exit 1"]);

    await expect(
      commitExistingPaths({
        repo,
        relPaths: ["settings/theme/settings.json"],
        message: "theme v2",
        expectedHead: before,
      }),
    ).rejects.toThrow(/hook says no/);

    expect(await headSha(repo)).toBe(before);
    // The user's edit is untouched; the staging capshelf did is not.
    expect(await file(source).text()).toBe('{"v":2}\n');
    expect(await readFile(join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(
      (await $`git -C ${repo} diff --cached --name-only`.quiet().text()).trim(),
    ).toBe("");
  });

  test("refuses a commit a hook widened past the allowed paths", async () => {
    const { repo, source } = await fixture();
    const before = await headSha(repo);
    const indexBefore = await readFile(join(repo, ".git", "index"));
    // git runs pre-commit against the temporary index it builds for a partial
    // commit, so what the hook stages lands in the commit.
    await writeHook(repo, [
      "printf 'sneaked\\n' > sneak.txt",
      "git add sneak.txt",
    ]);

    await expect(
      commitExistingPaths({
        repo,
        relPaths: ["settings/theme/settings.json"],
        message: "theme v2",
        expectedHead: before,
      }),
    ).rejects.toThrow(/does not own[\s\S]*sneak\.txt/);

    expect(await headSha(repo)).toBe(before);
    expect(await file(source).text()).toBe('{"v":2}\n');
    expect(await readFile(join(repo, ".git", "index"))).toEqual(indexBefore);
  });

  test("never clobbers a commit another writer landed during this one", async () => {
    const { repo, source } = await fixture();
    const before = await headSha(repo);
    // Stand in for a concurrent writer: `pre-commit` runs inside `git commit`,
    // which is the narrowest point another commit can land.
    await writeHook(repo, [
      "printf 'theirs\\n' > README.md",
      "git -c core.hooksPath=/dev/null commit -qm 'concurrent user commit' -- README.md",
    ]);

    await expect(
      commitExistingPaths({
        repo,
        relPaths: ["settings/theme/settings.json"],
        message: "theme v2",
        expectedHead: before,
      }),
    ).rejects.toThrow();

    // Their commit is HEAD and intact; ours does not exist; the user's edit
    // is untouched. `git commit` compare-and-swaps HEAD against the value it
    // read, which is what refuses here — the parent check in
    // `commitExistingPaths` covers the remaining window, before that read.
    expect(
      (await $`git -C ${repo} log -1 --format=%s`.quiet().text()).trim(),
    ).toBe("concurrent user commit");
    expect(
      (await $`git -C ${repo} show HEAD:README.md`.quiet().text()).trim(),
    ).toBe("theirs");
    expect(
      (await $`git -C ${repo} log --format=%s`.quiet().text()).includes(
        "theme v2",
      ),
    ).toBe(false);
    expect(await file(source).text()).toBe('{"v":2}\n');
  });

  test("commitParents reports the real parent, and none for a root commit", async () => {
    const { repo } = await fixture();
    const root = (
      await $`git -C ${repo} rev-list --max-parents=0 HEAD`.quiet().text()
    ).trim();
    expect(await commitParents(repo, root)).toEqual([]);

    const before = await headSha(repo);
    const commit = await commitExistingPaths({
      repo,
      relPaths: ["settings/theme/settings.json"],
      message: "theme v2",
      expectedHead: before,
    });
    expect(await commitParents(repo, commit)).toEqual([before]);
  });

  test("refuses when anything outside the allowed paths is dirty", async () => {
    const { repo } = await fixture();
    await writeFile(join(repo, "README.md"), "unrelated edit\n");

    await expect(
      commitExistingPaths({
        repo,
        relPaths: ["settings/theme/settings.json"],
        message: "theme v2",
        expectedHead: await headSha(repo),
      }),
    ).rejects.toThrow(/uncommitted changes outside/);
  });
});

describe("git sync helpers", () => {
  async function bareOrigin(): Promise<string> {
    const origin = await mkdtemp(join(tmpdir(), "capshelf-origin-"));
    await $`git init -q --initial-branch=main --bare ${origin}`.quiet();
    return origin;
  }

  async function cloneOf(origin: string): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-clone-"));
    const repo = join(parent, "clone");
    await $`git clone -q ${origin} ${repo}`.quiet();
    await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
    await $`git -C ${repo} config user.name capshelf`.quiet();
    return repo;
  }

  async function seededOrigin(): Promise<{ origin: string; seed: string }> {
    const origin = await bareOrigin();
    const seed = await cloneOf(origin);
    await writeFile(join(seed, "README.md"), "v1\n");
    await commitAll(seed, "baseline");
    await $`git -C ${seed} push -q origin main`.quiet();
    return { origin, seed };
  }

  test("currentBranch returns the branch and null on detached HEAD", async () => {
    const { seed } = await seededOrigin();
    expect(await currentBranch(seed)).toBe("main");
    await $`git -C ${seed} checkout -q --detach`.quiet();
    expect(await currentBranch(seed)).toBe(null);
  });

  test("trackingRef prefers @{upstream}, falls back to origin/<branch>, else null", async () => {
    const { origin, seed } = await seededOrigin();
    const repo = await cloneOf(origin);
    // Configured upstream wins (clone sets it up).
    expect(await trackingRef(repo, "main")).toBe("origin/main");

    // A branch without upstream config falls back to origin/<branch> when the
    // remote-tracking ref exists — transiently, without writing config.
    await $`git -C ${seed} switch -q -c topic`.quiet();
    await writeFile(join(seed, "topic.md"), "t\n");
    await commitAll(seed, "topic");
    await $`git -C ${seed} push -q origin topic`.quiet();
    await $`git -C ${repo} fetch -q origin`.quiet();
    await $`git -C ${repo} switch -q -c topic origin/topic --no-track`.quiet();
    expect(await trackingRef(repo, "topic")).toBe("origin/topic");
    const config = await $`git -C ${repo} config --list`.quiet().text();
    expect(config).not.toContain("branch.topic.remote");

    // No upstream config and no origin branch of that name.
    await $`git -C ${repo} switch -q -c propose/foo`.quiet();
    expect(await trackingRef(repo, "propose/foo")).toBe(null);
  });

  test("aheadBehind counts each side of HEAD...ref", async () => {
    const { origin, seed } = await seededOrigin();
    const repo = await cloneOf(origin);
    expect(await aheadBehind(repo, "origin/main")).toEqual({
      ahead: 0,
      behind: 0,
    });

    await writeFile(join(repo, "local.md"), "local\n");
    await commitAll(repo, "local 1");
    await writeFile(join(repo, "local.md"), "local 2\n");
    await commitAll(repo, "local 2");
    await writeFile(join(seed, "README.md"), "v2\n");
    await commitAll(seed, "upstream");
    await $`git -C ${seed} push -q origin main`.quiet();
    await $`git -C ${repo} fetch -q origin`.quiet();

    expect(await aheadBehind(repo, "origin/main")).toEqual({
      ahead: 2,
      behind: 1,
    });
  });

  test("fastForwardTo fast-forwards a behind branch and fails on diverged history", async () => {
    const { origin, seed } = await seededOrigin();
    const repo = await cloneOf(origin);
    await writeFile(join(seed, "README.md"), "v2\n");
    await commitAll(seed, "upstream v2");
    await $`git -C ${seed} push -q origin main`.quiet();
    await $`git -C ${repo} fetch -q origin`.quiet();

    await fastForwardTo(repo, "origin/main");
    expect(await headSha(repo)).toBe(await headSha(seed));

    // Diverge and assert ff-only refuses without moving HEAD.
    await writeFile(join(repo, "local.md"), "local\n");
    await commitAll(repo, "local");
    await writeFile(join(seed, "README.md"), "v3\n");
    await commitAll(seed, "upstream v3");
    await $`git -C ${seed} push -q origin main`.quiet();
    await $`git -C ${repo} fetch -q origin`.quiet();
    const before = await headSha(repo);
    await expect(fastForwardTo(repo, "origin/main")).rejects.toThrow();
    expect(await headSha(repo)).toBe(before);
  });

  test("fetchOrigin succeeds against a local bare remote and reports failures", async () => {
    const { origin } = await seededOrigin();
    const repo = await cloneOf(origin);
    expect((await fetchOrigin(repo)).ok).toBe(true);

    await $`git -C ${repo} remote set-url origin /nonexistent/capshelf-bogus`.quiet();
    const failed = await fetchOrigin(repo);
    expect(failed.ok).toBe(false);
    expect(failed.stderr.length).toBeGreaterThan(0);
  });
});

describe("remote URL normalization", () => {
  test("collapses supported equivalence classes", () => {
    const canonical = "https://github.com/mg/agent-shared";
    expect(normalizeRemoteUrl("https://github.com/mg/agent-shared")).toBe(
      canonical,
    );
    expect(normalizeRemoteUrl("https://github.com/mg/agent-shared.git")).toBe(
      canonical,
    );
    expect(normalizeRemoteUrl("https://github.com/mg/agent-shared/")).toBe(
      canonical,
    );
    expect(normalizeRemoteUrl("git@github.com:mg/agent-shared.git")).toBe(
      canonical,
    );
    expect(normalizeRemoteUrl("ssh://git@github.com/mg/agent-shared")).toBe(
      canonical,
    );
    expect(
      normalizeRemoteUrl("https://token@github.com/mg/agent-shared.git"),
    ).toBe(canonical);
    expect(normalizeRemoteUrl("github:mg/agent-shared")).toBe(canonical);
    expect(normalizeRemoteUrl("HTTPS://GitHub.com/mg/agent-shared")).toBe(
      canonical,
    );
  });

  test("lowercases scheme and host but preserves path case", () => {
    expect(normalizeRemoteUrl("HTTPS://GitHub.com/MG/Agent-Shared.git")).toBe(
      "https://github.com/MG/Agent-Shared",
    );
  });

  test("strips embedded credentials", () => {
    expect(
      normalizeRemoteUrl("https://user:token@example.com/team/repo.git"),
    ).toBe("https://example.com/team/repo");
  });

  test("keeps non-default ports in the identity", () => {
    expect(normalizeRemoteUrl("https://github.com:8443/mg/agent-shared")).toBe(
      "https://github.com:8443/mg/agent-shared",
    );
    expect(
      normalizeRemoteUrl("ssh://git@gitlab.com:2222/mg/agent-shared.git"),
    ).toBe("https://gitlab.com:2222/mg/agent-shared");
    expect(
      normalizeRemoteUrl("https://github.com:8443/mg/agent-shared"),
    ).not.toBe(normalizeRemoteUrl("https://github.com/mg/agent-shared"));
    // Default ports collapse into the plain host.
    expect(normalizeRemoteUrl("https://github.com:443/mg/agent-shared")).toBe(
      "https://github.com/mg/agent-shared",
    );
  });

  test("strips trailing .git and slashes until stable", () => {
    expect(normalizeRemoteUrl("https://github.com/mg/agent-shared/.git")).toBe(
      "https://github.com/mg/agent-shared",
    );
    expect(normalizeRemoteUrl("https://github.com/mg/agent-shared.git/")).toBe(
      "https://github.com/mg/agent-shared",
    );
  });

  test("normalization is idempotent over all supported forms", () => {
    const corpus = [
      "https://github.com/mg/agent-shared",
      "https://github.com/mg/agent-shared.git",
      "https://github.com/mg/agent-shared/",
      "https://github.com/mg/agent-shared/.git",
      "https://github.com/mg/agent-shared.git/",
      "git@github.com:mg/agent-shared.git",
      "ssh://git@github.com/mg/agent-shared",
      "ssh://git@gitlab.com:2222/mg/agent-shared.git",
      "https://token@github.com/mg/agent-shared.git",
      "https://github.com:8443/mg/agent-shared",
      "github:mg/agent-shared",
      "HTTPS://GitHub.com/mg/agent-shared",
    ];
    for (const url of corpus) {
      const once = normalizeRemoteUrl(url);
      expect(once).not.toBeNull();
      expect(normalizeRemoteUrl(once!)).toBe(once!);
    }
    for (const url of ["file:///tmp/repo", "file:///tmp/repo.git/"]) {
      const once = normalizeRemoteUrl(url, { allowFileUrls: true });
      expect(once).not.toBeNull();
      expect(normalizeRemoteUrl(once!, { allowFileUrls: true })).toBe(once!);
    }
  });

  test("normalizes local file remotes only when opted in", () => {
    const allow = { allowFileUrls: true };
    expect(normalizeRemoteUrl("file:///tmp/repo", allow)).toBe(
      "file:///tmp/repo",
    );
    // A file path names a real directory; trailing .git is preserved.
    expect(normalizeRemoteUrl("file:///tmp/repo.git", allow)).toBe(
      "file:///tmp/repo.git",
    );
    expect(normalizeRemoteUrl("file:///tmp/repo/", allow)).toBe(
      "file:///tmp/repo",
    );
    expect(normalizeRemoteUrl("file://localhost/tmp/repo", allow)).toBe(
      "file:///tmp/repo",
    );
    // Default behavior rejects file:// — machine-local paths are not
    // portable upstreams.
    expect(normalizeRemoteUrl("file:///tmp/repo")).toBeNull();
  });

  test("returns null for unsupported values", () => {
    expect(normalizeRemoteUrl("not a url")).toBeNull();
    expect(normalizeRemoteUrl("file:///tmp/repo")).toBeNull();
    expect(
      normalizeRemoteUrl("file://server/share/repo", { allowFileUrls: true }),
    ).toBeNull();
    expect(normalizeRemoteUrl("file:///", { allowFileUrls: true })).toBeNull();
    expect(normalizeRemoteUrl("git@example.com")).toBeNull();
  });
});
