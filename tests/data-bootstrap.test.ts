import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultClonePath,
  ensureClone,
  isRemoteDataUrl,
  resolveDataInput,
} from "../src/data-bootstrap";
import { CliError, PreconditionError } from "../src/errors";
import { normalizeRemoteUrl } from "../src/git";

const env = { XDG_DATA_HOME: "/xdg" };

function clonePath(...segments: string[]): string {
  return join("/xdg", "capshelf", "data", ...segments);
}

describe("isRemoteDataUrl", () => {
  test("matches supported git remote URL forms", () => {
    expect(isRemoteDataUrl("https://github.com/org/repo")).toBe(true);
    expect(isRemoteDataUrl("https://github.com/org/repo.git")).toBe(true);
    expect(isRemoteDataUrl("http://example.com/org/repo")).toBe(true);
    expect(isRemoteDataUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isRemoteDataUrl("ssh://git@github.com/org/repo.git")).toBe(true);
    expect(isRemoteDataUrl("file:///tmp/data")).toBe(true);
  });

  test("does not match local paths or shorthand", () => {
    expect(isRemoteDataUrl("/abs/path")).toBe(false);
    expect(isRemoteDataUrl("~/code/data")).toBe(false);
    expect(isRemoteDataUrl("../data")).toBe(false);
    expect(isRemoteDataUrl("owner/repo")).toBe(false);
    expect(isRemoteDataUrl("github:owner/repo")).toBe(false);
  });
});

describe("resolveDataInput", () => {
  test("detects HTTPS remote URLs and derives the clone path", () => {
    expect(
      resolveDataInput("https://github.com/genged/agent-shared", { env }),
    ).toEqual({
      kind: "remote-bootstrap",
      url: "https://github.com/genged/agent-shared",
      upstream: "https://github.com/genged/agent-shared",
      clonePath: clonePath("github.com", "genged", "agent-shared"),
    });
  });

  test("strips one trailing .git from the clone path", () => {
    const resolved = resolveDataInput(
      "https://github.com/genged/agent-shared.git",
      { env },
    );
    expect(resolved).toMatchObject({
      kind: "remote-bootstrap",
      upstream: "https://github.com/genged/agent-shared",
      clonePath: clonePath("github.com", "genged", "agent-shared"),
    });
  });

  test("detects scp-like SSH remotes", () => {
    expect(
      resolveDataInput("git@github.com:genged/agent-shared.git", { env }),
    ).toEqual({
      kind: "remote-bootstrap",
      url: "git@github.com:genged/agent-shared.git",
      upstream: "https://github.com/genged/agent-shared",
      clonePath: clonePath("github.com", "genged", "agent-shared"),
    });
  });

  test("supports GitLab nested groups over ssh", () => {
    const resolved = resolveDataInput(
      "ssh://git@gitlab.com/acme/platform/agent-shared.git",
      { env },
    );
    expect(resolved).toMatchObject({
      kind: "remote-bootstrap",
      upstream: "https://gitlab.com/acme/platform/agent-shared",
      clonePath: clonePath("gitlab.com", "acme", "platform", "agent-shared"),
    });
  });

  test("strips credentials from identity and clone path", () => {
    const resolved = resolveDataInput(
      "https://user:token@example.com/team/repo.git",
      { env },
    );
    expect(resolved).toMatchObject({
      kind: "remote-bootstrap",
      upstream: "https://example.com/team/repo",
      clonePath: clonePath("example.com", "team", "repo"),
    });
  });

  test("keeps non-default ports distinct in identity and clone path", () => {
    const resolved = resolveDataInput("https://github.com:8443/org/repo", {
      env,
    });
    expect(resolved).toMatchObject({
      kind: "remote-bootstrap",
      upstream: "https://github.com:8443/org/repo",
      clonePath: clonePath("github.com_8443", "org", "repo"),
    });
    expect(
      resolveDataInput("https://github.com/org/repo", { env }),
    ).toMatchObject({
      clonePath: clonePath("github.com", "org", "repo"),
    });
  });

  test("supports file:// remotes for local bootstrap", () => {
    expect(resolveDataInput("file:///tmp/shared/data", { env })).toEqual({
      kind: "remote-bootstrap",
      url: "file:///tmp/shared/data",
      upstream: "file:///tmp/shared/data",
      clonePath: clonePath("localhost", "tmp", "shared", "data"),
    });
  });

  test("uses --data-dir as the bootstrap clone path", () => {
    const resolved = resolveDataInput("https://github.com/org/repo", {
      env,
      cwd: "/work",
      dataDir: "clones/repo",
    });
    expect(resolved).toMatchObject({
      kind: "remote-bootstrap",
      clonePath: "/work/clones/repo",
    });
  });

  test("treats explicit path prefixes as local paths", () => {
    expect(resolveDataInput("/abs/data", { env })).toEqual({
      kind: "local-path",
      path: "/abs/data",
    });
    expect(resolveDataInput("../data", { env, cwd: "/work/project" })).toEqual({
      kind: "local-path",
      path: "/work/data",
    });
    expect(resolveDataInput("~/code/data", { env })).toEqual({
      kind: "local-path",
      path: join(homedir(), "code", "data"),
    });
  });

  test("treats an existing relative directory as a local path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "capshelf-data-input-"));
    await mkdir(join(cwd, "data"), { recursive: true });
    expect(resolveDataInput("data", { env, cwd })).toEqual({
      kind: "local-path",
      path: join(cwd, "data"),
    });
  });

  test("rejects owner/repo shorthand", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "capshelf-data-input-"));
    expect(() => resolveDataInput("owner/repo", { env, cwd })).toThrow(
      "data must be a local path or supported git remote URL: owner/repo",
    );
    try {
      resolveDataInput("owner/repo", { env, cwd });
    } catch (err) {
      expect(err).toBeInstanceOf(PreconditionError);
      expect((err as PreconditionError).exitCode).toBe(3);
    }
  });

  test("rejects github:owner/repo shorthand", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "capshelf-data-input-"));
    expect(() => resolveDataInput("github:owner/repo", { env, cwd })).toThrow(
      "data must be a local path or supported git remote URL",
    );
  });

  test("rejects URL-shaped input that does not normalize", () => {
    expect(() => resolveDataInput("ssh://git@github.com/", { env })).toThrow(
      "data must be a local path or supported git remote URL",
    );
  });
});

async function tempSourceRepo(): Promise<{ repo: string; url: string }> {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-clone-src-"));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await mkdir(join(repo, "skills", "hello"), { recursive: true });
  await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello\n");
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm baseline`.quiet();
  return { repo, url: `file://${repo}` };
}

describe("ensureClone", () => {
  test("clones when the path is absent", async () => {
    const { url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "nested", "clone");

    expect(await ensureClone(url, clonePath, upstream)).toEqual({
      cloned: true,
    });
    expect(existsSync(join(clonePath, ".git"))).toBe(true);
    expect(existsSync(join(clonePath, "skills", "hello", "SKILL.md"))).toBe(
      true,
    );
  });

  test("reuses an existing matching clone without fetching", async () => {
    const { repo, url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    await ensureClone(url, clonePath, upstream);

    // Advance the source; a reuse must not pick this commit up.
    await writeFile(join(repo, "skills", "hello", "SKILL.md"), "hello v2\n");
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -qm v2`.quiet();
    const sourceHead = (
      await $`git -C ${repo} rev-parse HEAD`.quiet().text()
    ).trim();

    expect(await ensureClone(url, clonePath, upstream)).toEqual({
      cloned: false,
    });
    const cloneHead = (
      await $`git -C ${clonePath} rev-parse HEAD`.quiet().text()
    ).trim();
    expect(cloneHead).not.toBe(sourceHead);
  });

  test("clones into an existing empty directory", async () => {
    const { url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    await mkdir(clonePath, { recursive: true });

    expect(await ensureClone(url, clonePath, upstream)).toEqual({
      cloned: true,
    });
    expect(existsSync(join(clonePath, "skills", "hello", "SKILL.md"))).toBe(
      true,
    );
  });

  test("reuses a matching clone reached through a symlinked parent", async () => {
    const { url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    await mkdir(join(base, "real"), { recursive: true });
    const clonePath = join(base, "real", "clone");
    await ensureClone(url, clonePath, upstream);
    await symlink(join(base, "real"), join(base, "link"));

    expect(
      await ensureClone(url, join(base, "link", "clone"), upstream),
    ).toEqual({ cloned: false });
  });

  test("fails when the existing clone has no usable HEAD commit", async () => {
    const { url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    // Simulate a partial clone: origin configured, no commit checked out.
    await mkdir(clonePath, { recursive: true });
    await $`git -C ${clonePath} init -q`.quiet();
    await $`git -C ${clonePath} remote add origin ${url}`.quiet();

    expect(ensureClone(url, clonePath, upstream)).rejects.toThrow(
      "data repo cache path already exists but has no usable HEAD commit.",
    );
  });

  test("fails when the existing clone points at a different upstream", async () => {
    const { url } = await tempSourceRepo();
    const other = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    await ensureClone(
      other.url,
      clonePath,
      normalizeRemoteUrl(other.url, { allowFileUrls: true })!,
    );

    try {
      await ensureClone(url, clonePath, upstream);
      throw new Error("expected ensureClone to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(PreconditionError);
      const message = (err as Error).message;
      expect(message).toContain(
        "data repo cache path already exists but points at a different upstream.",
      );
      expect(message).toContain(`expected:\n  ${upstream}`);
      expect(message).toContain(
        `found:\n  ${normalizeRemoteUrl(other.url, { allowFileUrls: true })}`,
      );
      expect(message).toContain("capshelf init --data <local-path>");
    }
  });

  test("fails when the existing path is a non-empty non-git directory", async () => {
    const { url } = await tempSourceRepo();
    const upstream = normalizeRemoteUrl(url, { allowFileUrls: true })!;
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    await mkdir(clonePath, { recursive: true });
    await writeFile(join(clonePath, "unrelated.txt"), "not a repo\n");

    expect(ensureClone(url, clonePath, upstream)).rejects.toThrow(
      "data repo cache path already exists but is not a git working tree.",
    );
  });

  test("reports git stderr when the clone fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "capshelf-clone-dst-"));
    const clonePath = join(base, "clone");
    const missing = join(base, "no-such-repo");
    const url = `file://${missing}`;

    try {
      await ensureClone(
        url,
        clonePath,
        normalizeRemoteUrl(url, { allowFileUrls: true })!,
      );
      throw new Error("expected ensureClone to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(1);
      const message = (err as Error).message;
      expect(message).toContain(`failed to clone data repo:\n  ${url}`);
      expect(message).toContain("git reported:");
      expect(message).toContain(
        "fix the URL, authenticate with Git, or clone manually and run:",
      );
      expect(message).toContain("capshelf init --data <local-path>");
    }
  });
});

describe("defaultClonePath", () => {
  test("prefers XDG_DATA_HOME", () => {
    expect(
      defaultClonePath("https://github.com/genged/agent-shared", {
        XDG_DATA_HOME: "/custom/xdg",
      }),
    ).toBe(
      join(
        "/custom/xdg",
        "capshelf",
        "data",
        "github.com",
        "genged",
        "agent-shared",
      ),
    );
  });

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    expect(defaultClonePath("https://github.com/genged/agent-shared", {})).toBe(
      join(
        homedir(),
        ".local",
        "share",
        "capshelf",
        "data",
        "github.com",
        "genged",
        "agent-shared",
      ),
    );
  });
});
