import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitUnavailableError,
  assertIsGitRepo,
  assertPathClean,
  assertRepoClean,
  assertRepoCleanOutsidePath,
  commitInRepo,
  gitVisibleFilesUnderPath,
  isPathClean,
  isRepoClean,
  lastTouchingCommit,
  lastTouchingContentCommit,
  lsTreeAtCommit,
  normalizeRemoteUrl,
  showAtCommit,
  statusPorcelainOutsidePath,
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

  test("gitVisibleFilesUnderPath returns tracked and untracked non-ignored files", async () => {
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

    expect(await gitVisibleFilesUnderPath(repo, "skills/hello")).toEqual([
      ".env.1password",
      "SKILL.md",
      "notes.md",
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

  test("lastTouchingCommit rejects uncommitted paths", async () => {
    const repo = await tempRepo();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");

    await expect(lastTouchingCommit(repo, "skills/hello")).rejects.toThrow(
      /no commit touches/,
    );
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
