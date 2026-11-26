import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CommandResult } from "./command";
import type { CommandOptions, WorldRunner } from "./world";

export interface BareRemote {
  path: string;
  url: string;
}

export interface CommitOptions {
  date?: string;
  paths?: readonly string[];
}

export interface SeedFiles {
  [relPath: string]: string;
}

export interface DataRepoOptions {
  name?: string;
  origin: string | null;
  skills?: Readonly<Record<string, string>>;
  files?: Readonly<Record<string, string>>;
  message?: string;
  branch?: string;
}

/**
 * Exit code can't show a command stayed offline: capshelf reports a failed
 * fetch instead of throwing, so it exits the same either way.
 */
export interface GitRecorder {
  /**
   * Only commands given this env are recorded, keeping fixture Git out of the
   * log.
   */
  env: { PATH: string };
  invocations(): Promise<string[][]>;
  subcommands(): Promise<string[]>;
}

export const NETWORK_SUBCOMMANDS: readonly string[] = [
  "fetch",
  "clone",
  "ls-remote",
  "pull",
  "push",
];

// ASCII record and unit separators. A path, a ref, or a commit message can
// hold a newline or a tab, and neither of these.

const RECORD_SEPARATOR = "\u001e";
const UNIT_SEPARATOR = "\u001f";

const VALUED_GLOBAL_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/**
 * Global options can precede the subcommand, so the first argument alone
 * cannot identify it.
 */
function gitSubcommand(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.length === 0) continue;
    if (VALUED_GLOBAL_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

export interface GitWorld {
  run(
    repo: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
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
   * Use for fresh-machine claims: a local path clone can copy objects no
   * advertised ref reaches.
   */
  cloneViaTransport(remoteUrl: string, destination: string): Promise<string>;
  /**
   * Only for tests of local-path cloning; it cannot support a fresh-machine
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
  /**
   * The shim logs argv then execs real Git, so the command keeps its own exit
   * code, streams, and signals.
   */
  recordInvocations(name?: string): Promise<GitRecorder>;
}

/** core.quotePath=false keeps non-ASCII paths readable in output. */
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
      const files: SeedFiles = { ...options.files };
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
      // --no-local stops Git copying objects no advertised ref reaches.
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
    recordInvocations: async (name = "git-recorder") => {
      const real = Bun.which("git");
      if (real === null) throw new Error("the git recorder needs git on PATH");
      const dir = runner.path(name);
      const log = join(dir, "invocations");
      await mkdir(dir, { recursive: true });
      // The argv is logged before the exec, so an invocation that fails to
      // start is still recorded.
      await writeFile(
        join(dir, "git"),
        [
          "#!/bin/sh",
          `printf '%s\\037' "$@" >> '${log}'`,
          `printf '\\036' >> '${log}'`,
          `exec '${real}' "$@"`,
          "",
        ].join("\n"),
      );
      await chmod(join(dir, "git"), 0o755);

      const invocations = async (): Promise<string[][]> => {
        const text = await readFile(log, "utf-8").catch(() => "");
        return text
          .split(RECORD_SEPARATOR)
          .filter((record) => record.length > 0)
          .map((record) => {
            const argv = record.split(UNIT_SEPARATOR);
            argv.pop();
            return argv;
          });
      };

      return {
        env: { PATH: `${dir}:${runner.env.PATH ?? ""}` },
        invocations,
        subcommands: async () =>
          (await invocations()).flatMap((argv) => {
            const subcommand = gitSubcommand(argv);
            return subcommand === null ? [] : [subcommand];
          }),
      };
    },
  };
}
