import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CommandResult } from "./command";
import type { CommandOptions, WorldRunner } from "./world";

export interface BareRemote {
  /** Path of the bare repository on disk. */
  path: string;
  /** Transport URL for `cloneViaTransport`. */
  url: string;
}

export interface CommitOptions {
  /** Fixed author and committer timestamp, for example "2026-01-02T03:04:05Z". */
  date?: string;
  /** Add these paths only. Defaults to every change in the worktree. */
  paths?: readonly string[];
}

export interface DataRepoOptions {
  name?: string;
  /** Portable upstream identity. `null` creates a repository with no origin. */
  origin: string | null;
  /** `skills/<name>/SKILL.md` content, keyed by item name. */
  skills?: Readonly<Record<string, string>>;
  /** Arbitrary repository-relative files, for example `mcp/x/claude.json`. */
  files?: Readonly<Record<string, string>>;
  message?: string;
  branch?: string;
}

export interface GitWorld {
  /** Run git inside a repository and return the raw result. */
  run(
    repo: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  /** Run git and fail the test with full diagnostics on any non-zero result. */
  ok(
    repo: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  init(
    path: string,
    options?: { bare?: boolean; branch?: string },
  ): Promise<string>;
  setIdentity(repo: string, name?: string, email?: string): Promise<void>;
  config(repo: string, key: string, value: string): Promise<void>;
  createRepo(
    name: string,
    options?: { origin?: string | null; branch?: string },
  ): Promise<string>;
  createProject(
    name: string,
    options?: { origin?: string | null },
  ): Promise<string>;
  createBareRemote(name: string, branch?: string): Promise<BareRemote>;
  createDataRepo(options: DataRepoOptions): Promise<string>;
  writeFiles(
    repo: string,
    files: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Fixture control: write files and commit them. Returns the new commit. */
  writeAndCommit(
    repo: string,
    files: Readonly<Record<string, string>>,
    message: string,
    options?: CommitOptions,
  ): Promise<string>;
  commit(
    repo: string,
    message: string,
    options?: CommitOptions,
  ): Promise<string>;
  /**
   * Clone a remote URL through Git transport. A fresh-machine or CI
   * reachability claim must use this: a local *path* clone can copy objects no
   * advertised ref reaches, so it cannot prove what a new machine receives.
   */
  cloneViaTransport(remoteUrl: string, destination: string): Promise<string>;
  /**
   * Clone a local path with Git's local optimization left on. Only for a test
   * whose subject is local-path cloning; it never supports a fresh-machine
   * claim.
   */
  cloneFromLocalPath(source: string, destination: string): Promise<string>;
  head(repo: string): Promise<string>;
  porcelain(repo: string): Promise<string>;
  lsTree(repo: string, ref?: string): Promise<string[]>;
  treeEntries(repo: string, ref?: string): Promise<string[]>;
  indexEntries(repo: string): Promise<string[]>;
  refs(repo: string): Promise<string[]>;
  advertisedRefs(remote: string): Promise<string[]>;
  hasCommit(repo: string, commit: string): Promise<boolean>;
  isCleanWorktree(repo: string): Promise<boolean>;
}

/** Path output stays unquoted so a non-ASCII cell reads the same as baseline. */
const READ_CONFIG = ["-c", "core.quotePath=false"];

export function createGitWorld(runner: WorldRunner): GitWorld {
  const run = (
    repo: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> =>
    runner.run(repo, ["git", ...READ_CONFIG, "-C", repo, ...args], options);

  const ok = async (
    repo: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> => {
    const result = await run(repo, args, options);
    if (result.outcome.kind !== "exit" || result.outcome.exitCode !== 0) {
      throw new Error(`git command failed\n${runner.describe(result)}`);
    }
    return result;
  };

  const stdoutOf = async (
    repo: string,
    args: readonly string[],
  ): Promise<string> => (await ok(repo, args)).stdout;

  const splitNul = (text: string): string[] =>
    text.split("\0").filter((entry) => entry.length > 0);

  const resolvePath = (path: string): string =>
    isAbsolute(path) ? path : runner.path(path);

  const writeFiles = async (
    repo: string,
    files: Readonly<Record<string, string>>,
  ): Promise<void> => {
    for (const [relPath, content] of Object.entries(files)) {
      const target = join(repo, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };

  const commit = async (
    repo: string,
    message: string,
    options: CommitOptions = {},
  ): Promise<string> => {
    await ok(
      repo,
      options.paths ? ["add", "--", ...options.paths] : ["add", "-A"],
    );
    const env = options.date
      ? { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date }
      : undefined;
    await ok(repo, ["commit", "-q", "-m", message], env ? { env } : undefined);
    return (await stdoutOf(repo, ["rev-parse", "HEAD"])).trim();
  };

  const init = async (
    path: string,
    options: { bare?: boolean; branch?: string } = {},
  ): Promise<string> => {
    const target = resolvePath(path);
    await mkdir(target, { recursive: true });
    const args = ["init", "-q", "-b", options.branch ?? "main"];
    if (options.bare) args.push("--bare");
    const result = await runner.run(target, ["git", ...args, target]);
    if (result.outcome.kind !== "exit" || result.outcome.exitCode !== 0) {
      throw new Error(`git init failed\n${runner.describe(result)}`);
    }
    return target;
  };

  const setIdentity = async (
    repo: string,
    name = "capshelf e2e",
    email = "e2e@example.invalid",
  ): Promise<void> => {
    await ok(repo, ["config", "user.name", name]);
    await ok(repo, ["config", "user.email", email]);
  };

  const createRepo = async (
    name: string,
    options: { origin?: string | null; branch?: string } = {},
  ): Promise<string> => {
    const repo = await init(name, { branch: options.branch });
    await setIdentity(repo);
    const origin =
      options.origin === undefined
        ? `https://example.invalid/${name.replace(/[^A-Za-z0-9._-]/g, "-")}.git`
        : options.origin;
    if (origin !== null) await ok(repo, ["remote", "add", "origin", origin]);
    return repo;
  };

  const clone = async (
    source: string,
    destination: string,
    extraArgs: readonly string[],
  ): Promise<string> => {
    const target = resolvePath(destination);
    const result = await runner.run(runner.stage, [
      "git",
      ...READ_CONFIG,
      "clone",
      "-q",
      ...extraArgs,
      source,
      target,
    ]);
    if (result.outcome.kind !== "exit" || result.outcome.exitCode !== 0) {
      throw new Error(`git clone failed\n${runner.describe(result)}`);
    }
    await setIdentity(target);
    return target;
  };

  return {
    run,
    ok,
    init,
    setIdentity,
    config: async (repo, key, value) => {
      await ok(repo, ["config", key, value]);
    },
    createRepo,
    createProject: async (name, options = {}) => {
      const repo = await createRepo(name, { origin: options.origin ?? null });
      await writeFiles(repo, { "README.md": `${name}\n` });
      await commit(repo, "seed project");
      return repo;
    },
    createBareRemote: async (name, branch = "main") => {
      const path = await init(name, { bare: true, branch });
      return { path, url: `file://${path}` };
    },
    createDataRepo: async (options) => {
      const name = options.name ?? "shelf";
      const repo = await createRepo(name, {
        origin: options.origin,
        branch: options.branch,
      });
      const files: Record<string, string> = { ...(options.files ?? {}) };
      for (const [skill, content] of Object.entries(options.skills ?? {})) {
        files[`skills/${skill}/SKILL.md`] = content;
      }
      if (Object.keys(files).length === 0) files["README.md"] = `${name}\n`;
      await writeFiles(repo, files);
      await commit(repo, options.message ?? "seed shelf");
      return repo;
    },
    writeFiles,
    writeAndCommit: async (repo, files, message, options) => {
      await writeFiles(repo, files);
      return await commit(repo, message, options);
    },
    commit,
    cloneViaTransport: async (remoteUrl, destination) => {
      if (!/^[a-z][a-z0-9+.-]*:\/\//.test(remoteUrl)) {
        throw new Error(
          `cloneViaTransport needs a remote URL, got a path: ${remoteUrl}. ` +
            "Use cloneFromLocalPath when local-path cloning is the subject of the test.",
        );
      }
      // --no-local is redundant for a URL and cheap insurance: it is the
      // documented switch that stops Git from copying objects no advertised
      // ref reaches.
      return await clone(remoteUrl, destination, ["--no-local"]);
    },
    cloneFromLocalPath: async (source, destination) => {
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(source)) {
        throw new Error(
          `cloneFromLocalPath needs a path, got a URL: ${source}`,
        );
      }
      return await clone(source, destination, []);
    },
    head: async (repo) => (await stdoutOf(repo, ["rev-parse", "HEAD"])).trim(),
    porcelain: async (repo) =>
      (await stdoutOf(repo, ["status", "--porcelain=v1"])).trim(),
    lsTree: async (repo, ref = "HEAD") =>
      splitNul(
        await stdoutOf(repo, ["ls-tree", "-r", "-z", "--name-only", ref]),
      ).sort(),
    treeEntries: async (repo, ref = "HEAD") =>
      splitNul(await stdoutOf(repo, ["ls-tree", "-r", "-z", ref]))
        .map((line) => line.replace(/\t/, " "))
        .sort(),
    indexEntries: async (repo) =>
      splitNul(await stdoutOf(repo, ["ls-files", "--stage", "-z"])).sort(),
    refs: async (repo) => {
      const result = await run(repo, ["show-ref"]);
      // An empty repository has no refs; show-ref reports that with exit 1.
      if (result.outcome.kind !== "exit") {
        throw new Error(`git show-ref failed\n${runner.describe(result)}`);
      }
      return result.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .sort();
    },
    advertisedRefs: async (remote) => {
      const result = await runner.run(runner.stage, [
        "git",
        ...READ_CONFIG,
        "ls-remote",
        remote,
      ]);
      if (result.outcome.kind !== "exit" || result.outcome.exitCode !== 0) {
        throw new Error(`git ls-remote failed\n${runner.describe(result)}`);
      }
      return result.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .sort();
    },
    hasCommit: async (repo, commitish) => {
      const result = await run(repo, [
        "cat-file",
        "-e",
        `${commitish}^{commit}`,
      ]);
      return result.outcome.kind === "exit" && result.outcome.exitCode === 0;
    },
    isCleanWorktree: async (repo) =>
      (await stdoutOf(repo, ["status", "--porcelain=v1"])).trim().length === 0,
  };
}
