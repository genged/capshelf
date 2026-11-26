import { gitObjectReadKey, type GitReadMemo } from "./git-read-memo";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { CliError, ExitCode, PreconditionError } from "./errors";
import { isErrno } from "./fs-utils";
import { recordGitRead } from "./git-measure";
import { ignoredPublicationMessage } from "./publication-ignore";

const GIT_MISSING_MESSAGE =
  "git is required but was not found on PATH\n  install Git, then retry";

/**
 * `git check-attr --source=<tree-ish>` needs Git 2.40.0, and there is no
 * worktree fallback because machine-local attributes would decide whether a pin
 * is portable.
 */
export const MIN_GIT_VERSION: readonly [number, number, number] = [2, 40, 0];

export class GitUnavailableError extends CliError {
  constructor() {
    super(GIT_MISSING_MESSAGE, { exitCode: ExitCode.GitUnavailable });
  }
}

export class GitTooOldError extends CliError {
  constructor(found: string) {
    super(
      `git ${MIN_GIT_VERSION.join(".")} or newer is required; found git ${found}\n  upgrade Git, then retry`,
      { exitCode: ExitCode.GitUnavailable },
    );
  }
}

/**
 * One nullable repo argument cannot express the Git policy each use needs:
 * replacement refs, project config, index and hook policy, and no external diff
 * helper. Every wrapper therefore names exactly one profile and no profile is
 * the default. The `isolated-merge` caller supplies its own repo or cwd and its
 * own environment.
 */
type GitBinding =
  | { profile: "source-read"; repo: string }
  | { profile: "source-write"; repo: string }
  | { profile: "project-policy"; repo: string }
  | { profile: "repository-free"; cwd: string }
  | { profile: "isolated-diff"; cwd: string }
  | { profile: "isolated-merge"; repo?: string; cwd?: string };

let checkedPath: string | undefined;
let checkedVersion: string | undefined;

export async function assertGitAvailable(): Promise<void> {
  const pathEnv = process.env.PATH ?? "";
  if (checkedPath === pathEnv && checkedVersion !== undefined) return;
  if (!(await commandExistsOnPath("git", pathEnv))) {
    checkedPath = undefined;
    checkedVersion = undefined;
    throw new GitUnavailableError();
  }
  const reported = await reportedGitVersion();
  const parsed = parseGitVersion(reported);
  if (parsed === null || compareVersions(parsed, MIN_GIT_VERSION) < 0) {
    checkedPath = undefined;
    checkedVersion = undefined;
    throw new GitTooOldError(reported);
  }
  checkedPath = pathEnv;
  checkedVersion = reported;
}

export function resetGitVersionCache(): void {
  checkedPath = undefined;
  checkedVersion = undefined;
}

async function reportedGitVersion(): Promise<string> {
  const proc = Bun.spawn(["git", "--version"], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  recordGitRead("--version", "", ["--version"], exitCode === 0, true);
  return stdout.trim().replace(/^git version /, "") || "(unknown)";
}

/**
 * Vendor builds append suffixes (`2.39.5 (Apple Git-154)`, `2.40.0.windows.1`)
 * that must not affect the comparison.
 */
export function parseGitVersion(
  reported: string,
): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(reported.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

export interface GitInvocation {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
}

/**
 * An ambient GIT_DIR or GIT_ALTERNATE_OBJECT_DIRECTORIES silently defeats `-C
 * <repo>`, so fixed-binding profiles strip these.
 */
const REPOSITORY_SELECTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  // These four change how Git reads every pathspec. capshelf writes its own
  // `:(literal)` magic, so an ambient value would change which paths match.
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
] as const;

const DIFF_HELPER_ENV = [
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

function withoutVariables(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete out[name];
  return out;
}

function environmentFor(
  binding: GitBinding,
  options: GitRunOptions,
): NodeJS.ProcessEnv {
  if (options.env) return options.env;
  switch (binding.profile) {
    case "source-read":
      return {
        ...withoutVariables(process.env, REPOSITORY_SELECTING_ENV),
        // Replacement refs are ignored so the lock never records an object id
        // that resolves differently in other clones.
        GIT_NO_REPLACE_OBJECTS: "1",
      };
    case "source-write":
    case "project-policy":
    case "repository-free":
      return withoutVariables(process.env, REPOSITORY_SELECTING_ENV);
    case "isolated-diff":
      return {
        ...withoutVariables(process.env, [
          ...REPOSITORY_SELECTING_ENV,
          ...DIFF_HELPER_ENV,
        ]),
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_NOSYSTEM: "1",
      };
    case "isolated-merge":
      throw new Error("isolated-merge requires an explicit environment");
  }
}

function argvFor(binding: GitBinding, args: string[]): string[] {
  switch (binding.profile) {
    case "source-read":
      // `core.fsmonitor` names a program that `git status` runs. A `-c` value
      // beats the repository's own configuration.
      return [
        "git",
        "-C",
        binding.repo,
        "-c",
        "core.fsmonitor=false",
        "--no-replace-objects",
        ...args,
      ];
    case "source-write":
    case "project-policy":
      return ["git", "-C", binding.repo, ...args];
    case "repository-free":
    case "isolated-diff":
      return ["git", ...args];
    case "isolated-merge":
      return binding.repo === undefined
        ? ["git", ...args]
        : ["git", "-C", binding.repo, ...args];
  }
}

function cwdFor(binding: GitBinding): string | undefined {
  switch (binding.profile) {
    case "repository-free":
    case "isolated-diff":
      return binding.cwd;
    case "isolated-merge":
      return binding.cwd;
    default:
      return undefined;
  }
}

// Use Bun.spawn with an argv array, never `$`: its shell-escape layer
// mis-serializes some non-Latin1 strings, corrupting pathspecs and refs for
// non-ASCII names.
async function runGit(
  binding: GitBinding,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitInvocation> {
  await assertGitAvailable();
  const cwd = cwdFor(binding);
  const proc = Bun.spawn(argvFor(binding, args), {
    env: environmentFor(binding, options),
    ...(cwd !== undefined && { cwd }),
    stdout: "pipe",
    stderr: "pipe",
    stdin:
      options.stdin === undefined
        ? "ignore"
        : options.stdin instanceof Uint8Array
          ? options.stdin
          : new Blob([options.stdin]),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => Buffer.from(b)),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const operation =
    args.find((arg) =>
      ["show", "cat-file", "ls-tree", "rev-parse", "check-attr"].includes(arg),
    ) ?? args[0]!;
  recordGitRead(
    operation === "cat-file" ? `${operation} ${args[1]}` : operation,
    "repo" in binding ? (binding.repo ?? cwd ?? "") : (cwd ?? ""),
    binding.profile === "source-read" ? args : [],
    exitCode === 0,
    true,
  );
  return { exitCode, stdout, stderr: stderr.trim() };
}

async function sourceReadUntil(
  repo: string,
  args: string[],
  consume: (chunk: Buffer) => boolean,
): Promise<boolean> {
  await assertGitAvailable();
  const binding: GitBinding = { profile: "source-read", repo };
  const proc = Bun.spawn(argvFor(binding, args), {
    env: environmentFor(binding, {}),
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  let stopped = false;
  let ended = false;
  const reader = proc.stdout.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (consume(Buffer.from(value))) {
        stopped = true;
        break;
      }
    }
  } finally {
    if (!ended) {
      proc.kill();
      await reader.cancel();
    }
  }
  const exitCode = await proc.exited;
  const complete = stopped || exitCode === 0;
  recordGitRead(args[0]!, repo, args, complete, true);
  return complete;
}

function throwOnFailure(result: GitInvocation, args: string[]): Buffer {
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || `git ${args.join(" ")} exited ${result.exitCode}`,
    );
  }
  return result.stdout;
}

export async function sourceRead(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitInvocation> {
  return await runGit({ profile: "source-read", repo }, args, options);
}

export async function sourceReadBuffer(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<Buffer> {
  return throwOnFailure(await sourceRead(repo, args, options), args);
}

export async function sourceReadText(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return (await sourceReadBuffer(repo, args, options)).toString("utf-8");
}

export async function sourceWrite(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitInvocation> {
  return await runGit({ profile: "source-write", repo }, args, options);
}

export async function sourceWriteBuffer(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<Buffer> {
  return throwOnFailure(await sourceWrite(repo, args, options), args);
}

export async function sourceWriteText(
  repo: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return (await sourceWriteBuffer(repo, args, options)).toString("utf-8");
}

export async function projectPolicy(
  repo: string,
  args: string[],
  options: Pick<GitRunOptions, "stdin"> = {},
): Promise<GitInvocation> {
  return await runGit({ profile: "project-policy", repo }, args, options);
}

export async function projectPolicyText(
  repo: string,
  args: string[],
): Promise<string> {
  return throwOnFailure(await projectPolicy(repo, args), args).toString(
    "utf-8",
  );
}

export async function repositoryFree(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitInvocation> {
  return await runGit({ profile: "repository-free", cwd }, args, options);
}

export async function isolatedMerge(
  binding: { repo?: string; cwd?: string },
  args: string[],
  env: Record<string, string>,
): Promise<GitInvocation> {
  return await runGit(
    {
      profile: "isolated-merge",
      ...(binding.repo !== undefined && { repo: binding.repo }),
      ...(binding.cwd !== undefined && { cwd: binding.cwd }),
    },
    args,
    { env },
  );
}

export async function isolatedMergeText(
  binding: { repo?: string; cwd?: string },
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  return throwOnFailure(await isolatedMerge(binding, args, env), args).toString(
    "utf-8",
  );
}

/**
 * The argv is fixed so the bytes answer, not the machine configuration.
 * --no-ext-diff blocks external diff helpers, --no-textconv blocks attribute
 * drivers, --text ignores Git's binary heuristic, and the -c settings stop
 * core.autocrlf, core.eol, and attributes from normalizing the difference.
 */
export async function isolatedNoIndexDiff(
  cwd: string,
  oldPath: string,
  newPath: string,
  unified = 3,
): Promise<GitInvocation> {
  return await runGit({ profile: "isolated-diff", cwd }, [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "diff.external=",
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    `--unified=${unified}`,
    "--",
    oldPath,
    newPath,
  ]);
}

export async function assertIsGitRepo(path: string): Promise<void> {
  await assertGitAvailable();
  if (await isGitRepo(path)) return;
  throw new PreconditionError(
    `not a git repository: ${path}\n  initialize with: git -C ${path} init && git -C ${path} add -A && git -C ${path} commit -m "baseline"`,
  );
}

export async function assertDataRepoRoot(path: string): Promise<void> {
  await assertGitAvailable();
  const root = await gitWorkTreeRoot(path);
  if (root === null) {
    throw new PreconditionError(
      `not a git repository: ${path}\n  initialize with: git -C ${path} init && git -C ${path} add -A && git -C ${path} commit -m "baseline"`,
    );
  }
  const [boundPath, worktreeRoot] = await Promise.all([
    realpath(path),
    realpath(root),
  ]);
  if (boundPath === worktreeRoot) return;
  throw new PreconditionError(
    `data repo binding must point at the Git worktree root\n  supplied: ${path}\n  worktree root: ${root}`,
  );
}

export async function originRemoteUrl(repo: string): Promise<string | null> {
  const result = await sourceRead(repo, ["remote", "get-url", "origin"]);
  return result.exitCode === 0 ? result.stdout.toString("utf-8") : null;
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await sourceRead(path, ["rev-parse", "--git-dir"])).exitCode === 0;
}

export async function gitWorkTreeRoot(path: string): Promise<string | null> {
  const result = await sourceRead(path, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.toString("utf-8").trim();
  return out ? resolve(out) : null;
}

export async function isGitWorkTreeRoot(path: string): Promise<boolean> {
  const root = await gitWorkTreeRoot(path);
  if (root === null) return false;
  if (root === resolve(path)) return true;
  // git prints the physical top-level path; compare against the realpath so a
  // worktree reached through a symlinked parent still counts as its root.
  try {
    return root === (await realpath(path));
  } catch {
    return false;
  }
}

/**
 * Project policy, not identity: capshelf writes this file so `--local` items
 * stay out of the project's history.
 */
export async function gitInfoExcludePath(
  project: string,
): Promise<string | null> {
  const root = await projectWorkTreeRoot(project);
  if (root === null) return null;
  const out = await projectPolicyText(project, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  return resolve(project, out.trim());
}

export async function isProjectWorkTreeRoot(project: string): Promise<boolean> {
  return (await projectWorkTreeRoot(project)) !== null;
}

async function projectWorkTreeRoot(project: string): Promise<string | null> {
  const result = await projectPolicy(project, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.toString("utf-8").trim();
  if (!out) return null;
  const root = resolve(out);
  if (root === resolve(project)) return root;
  try {
    return root === (await realpath(project)) ? root : null;
  } catch {
    return null;
  }
}

/**
 * A caller-supplied `head` makes one command pass see one history for all
 * items, and a full commit id's history is immutable so `memo` can keep the
 * answer.
 */
export interface LastTouchingOptions {
  head?: string;
  memo?: GitReadMemo;
}

export async function lastTouchingCommit(
  repo: string,
  relPath: string,
  options: LastTouchingOptions = {},
): Promise<string> {
  return await lastTouchingCommitForPaths(repo, [relPath], options);
}

export async function lastTouchingCommitForPaths(
  repo: string,
  relPaths: string[],
  options: LastTouchingOptions = {},
): Promise<string> {
  const sha = await tryLastTouchingCommitForPathspecs(
    repo,
    relPaths.map(literalPathspec),
    options,
  );
  if (!sha) {
    const relPathLabel = relPaths.join(", ");
    throw new Error(
      `no commit touches ${relPathLabel} in ${repo}\n  commit it first: git -C ${repo} add ${relPaths.join(" ")} && git -C ${repo} commit`,
    );
  }
  return sha;
}

/**
 * Excludes the item's `.capshelf.yml` sidecar, so a metadata-only commit never
 * moves sourceCommit and `update` stays a no-op. Falls back to the unfiltered
 * commit if only the sidecar was ever committed under the path.
 */
export async function lastTouchingContentCommit(
  repo: string,
  relPath: string,
  options: LastTouchingOptions = {},
): Promise<string> {
  const sha = await tryLastTouchingCommitForPathspecs(
    repo,
    contentCommitPathspecs(relPath),
    options,
  );
  if (sha) return sha;
  return await lastTouchingCommit(repo, relPath, options);
}

export function contentCommitPathspecs(relPath: string): string[] {
  return [
    literalPathspec(relPath),
    excludePathspec(`${relPath}/.capshelf.yml`),
  ];
}

interface WalkRequest {
  key: string;
  include: string[];
  exclude: string[];
}

function walkRequestOf(
  key: string,
  pathspecs: readonly string[],
): WalkRequest | null {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const pathspec of pathspecs) {
    const excluded = pathspec.startsWith(":(literal,exclude)");
    const paths = literalPathsOf([
      excluded
        ? `:(literal)${pathspec.slice(":(literal,exclude)".length)}`
        : pathspec,
    ]);
    if (paths === null) return null;
    (excluded ? exclude : include).push(paths[0]!);
  }
  return include.length === 0 ? null : { key, include, exclude };
}

/**
 * One union `log --name-only` walk answers every list only for linear history
 * (at a merge `log` follows a parent that can depend on paths), so merges,
 * single-pathspec lists, and overlapping exclusions fall back to per-item `log
 * -1`.
 */
export async function prefetchLastTouchingCommits(
  repo: string,
  head: string,
  pathspecLists: ReadonlyArray<readonly string[]>,
  memo: GitReadMemo,
): Promise<void> {
  const candidates: WalkRequest[] = [];
  for (const pathspecs of pathspecLists) {
    if (pathspecs.length < 2) continue;
    const key = gitObjectReadKey(repo, head, [...pathspecs]);
    if (key === undefined || memo.lastTouching.has(key)) continue;
    if (candidates.some((candidate) => candidate.key === key)) continue;
    const request = walkRequestOf(key, pathspecs);
    if (request !== null) candidates.push(request);
  }
  const overlaps = (paths: readonly string[], other: readonly string[]) =>
    paths.some((path) =>
      other.some((root) => isAtOrUnder(path, root) || isAtOrUnder(root, path)),
    );
  const requests = candidates.filter((request) =>
    candidates.every(
      (other) => other === request || !overlaps(request.include, other.exclude),
    ),
  );
  if (requests.length < 2) return;

  const union = [
    ...new Set(
      requests.flatMap((request) => [
        ...request.include.map((path) => `:(literal)${path}`),
        ...request.exclude.map((path) => `:(literal,exclude)${path}`),
      ]),
    ),
  ];
  const reader = new LogWalkReader(requests);
  const complete = await sourceReadUntil(
    repo,
    logWalkArgs(head, union),
    (chunk) => reader.feed(chunk),
  );
  if (!complete) return;
  const answers = reader.finish();
  if (answers === null) return;
  // The answers hold only when no merge lies between `head` and the oldest
  // commit the walk read. When every list has its commit, only that range is
  // checked, and the oldest commit is excluded. If it is a merge, it was listed
  // with no path and `finish` already refused the walk. A list with no commit
  // depends on the whole history, so all of it is checked.
  const oldest = reader.lastCommit();
  const range =
    [...answers.values()].every((commit) => commit !== null) &&
    oldest !== undefined
      ? [head, `^${oldest}`]
      : [head];
  const merge = await sourceRead(repo, [
    "rev-list",
    "--min-parents=2",
    "--max-count=1",
    ...range,
  ]);
  if (merge.exitCode !== 0 || merge.stdout.toString("utf-8").trim() !== "") {
    return;
  }
  for (const [key, commit] of answers) memo.lastTouching.set(key, commit);
}

export function logWalkArgs(head: string, union: readonly string[]): string[] {
  return [
    "log",
    "-z",
    "--no-renames",
    "--name-only",
    "--root",
    "--no-relative",
    "--no-show-signature",
    // `diff.ignoreSubmodules` and a `.gitmodules` `ignore` setting hide a
    // gitlink change from the listing, but not from the commit selection.
    "--ignore-submodules=none",
    "--format=%x00%H",
    head,
    "--",
    ...union,
  ];
}

/**
 * `%x00%H` with `-z` yields an empty field, then the commit id; a changed path
 * is never empty, so an empty field always precedes a commit id.
 */
export class LogWalkReader {
  private readonly requests: ReadonlyArray<{ key: string; include: string[] }>;
  private readonly answers = new Map<string, string>();
  private rest = Buffer.alloc(0);
  private commit: string | undefined;
  private names = 0;
  private afterId = false;
  private afterEmpty = false;
  /**
   * A commit that `log` selects but lists with no changed path means the
   * listing hid a change, so no answer from this walk is trusted.
   */
  private hiddenChange = false;

  constructor(requests: ReadonlyArray<{ key: string; include: string[] }>) {
    this.requests = requests;
  }

  done(): boolean {
    return this.hiddenChange || this.answers.size === this.requests.length;
  }

  feed(chunk: Buffer): boolean {
    const buffer = Buffer.concat([this.rest, chunk]);
    const last = buffer.lastIndexOf(0);
    if (last === -1) {
      this.rest = buffer;
      return false;
    }
    this.rest = buffer.subarray(last + 1);
    for (const field of buffer
      .subarray(0, last)
      .toString("utf-8")
      .split("\0")) {
      this.take(field);
      if (this.done()) return true;
    }
    return false;
  }

  lastCommit(): string | undefined {
    return this.commit;
  }

  finish(): Map<string, string | null> | null {
    if (!this.done()) {
      if (this.rest.length > 0) this.take(this.rest.toString("utf-8"));
      if (this.commit !== undefined && this.names === 0) {
        this.hiddenChange = true;
      }
    }
    if (this.hiddenChange) return null;
    return new Map(
      this.requests.map((request) => [
        request.key,
        this.answers.get(request.key) ?? null,
      ]),
    );
  }

  private take(input: string): void {
    let field = input;
    if (this.afterEmpty) {
      this.afterEmpty = false;
      if (/^[0-9a-f]{40,64}$/.test(field)) {
        if (this.commit !== undefined && this.names === 0) {
          this.hiddenChange = true;
        }
        this.commit = field;
        this.names = 0;
        this.afterId = true;
        return;
      }
    }
    if (field === "") {
      this.afterEmpty = true;
      return;
    }
    if (this.afterId) {
      this.afterId = false;
      if (field.startsWith("\n")) field = field.slice(1);
      if (field === "") return;
    }
    const commit = this.commit;
    if (commit === undefined) return;
    this.names += 1;
    // The union applies every exclusion, so an excluded path is never listed.
    for (const request of this.requests) {
      if (this.answers.has(request.key)) continue;
      if (request.include.some((root) => isAtOrUnder(field, root))) {
        this.answers.set(request.key, commit);
      }
    }
  }
}

async function tryLastTouchingCommitForPathspecs(
  repo: string,
  pathspecs: string[],
  { head, memo }: LastTouchingOptions,
): Promise<string | null> {
  if (pathspecs.length === 0) {
    throw new Error(
      "cannot compute last touching commit for an empty path list",
    );
  }
  const key =
    head === undefined ? undefined : gitObjectReadKey(repo, head, pathspecs);
  if (head !== undefined && key === undefined) {
    throw new Error(`last touching commit needs a full commit id, got ${head}`);
  }
  const cached = key === undefined ? undefined : memo?.lastTouching.get(key);
  if (cached !== undefined) return cached;
  const result = await sourceRead(repo, [
    "log",
    "-1",
    "--format=%H",
    ...(head === undefined ? [] : [head]),
    "--",
    ...pathspecs,
  ]);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.toString("utf-8").trim() || null;
  if (key !== undefined) memo?.lastTouching.set(key, sha);
  return sha;
}

export async function showAtCommit(
  repo: string,
  commit: string,
  relPath: string,
  memo?: GitReadMemo,
): Promise<Buffer> {
  const key = gitObjectReadKey(repo, commit, [relPath]);
  const cached = key === undefined ? undefined : memo?.shows.get(key);
  if (cached !== undefined) return Buffer.from(cached);
  const bytes = await sourceReadBuffer(repo, ["show", `${commit}:${relPath}`]);
  if (key !== undefined) memo?.shows.set(key, Buffer.from(bytes));
  return bytes;
}

export async function commitExists(
  repo: string,
  commit: string,
  memo?: GitReadMemo,
): Promise<boolean> {
  const key = gitObjectReadKey(repo, commit);
  if (key !== undefined && memo?.commits.has(key)) return true;
  const present =
    (await sourceRead(repo, ["cat-file", "-e", `${commit}^{commit}`]))
      .exitCode === 0;
  if (present && key !== undefined) memo?.commits.add(key);
  return present;
}

export async function resolveCommit(
  repo: string,
  commit: string,
): Promise<string | null> {
  const result = await sourceRead(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${commit}^{commit}`,
  ]);
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await sourceRead(repo, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    result.stderr || `git merge-base --is-ancestor exited ${result.exitCode}`,
  );
}

export async function objectTypeAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<string | null> {
  const result = await sourceRead(repo, [
    "cat-file",
    "-t",
    `${commit}:${relPath}`,
  ]);
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

export interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

export class UnsupportedGitEntryError extends PreconditionError {}

export function assertRegularBlobEntries(
  entries: GitTreeEntry[],
  itemPath: string,
): void {
  for (const entry of entries) {
    if (
      entry.type === "blob" &&
      (entry.mode === "100644" || entry.mode === "100755")
    ) {
      continue;
    }
    throw new UnsupportedGitEntryError(
      `${itemPath} contains an unsupported Git entry: ${entry.path} (mode ${entry.mode}, type ${entry.type}); copy items support regular files only`,
    );
  }
}

export async function lsTreeAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<string[]> {
  return (await lsTreeEntriesAtCommit(repo, commit, relPath)).map(
    (entry) => entry.path,
  );
}

export async function lsTreeEntriesAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<GitTreeEntry[]> {
  return await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec(relPath),
  ]);
}

/**
 * Must stay one call, so item identity sees one repository state and no missing
 * path is dropped. `-z` emits pathnames verbatim, without octal-quoting of
 * non-ASCII, control, or quote characters.
 */
export async function lsTreeEntriesForPathspecs(
  repo: string,
  commit: string,
  pathspecs: string[],
  options: { includeTrees?: boolean; memo?: GitReadMemo } = {},
): Promise<GitTreeEntry[]> {
  if (pathspecs.length === 0) return [];
  const args = [
    "ls-tree",
    "-r",
    ...(options.includeTrees === true ? ["-t"] : []),
    "-z",
    commit,
    "--",
    ...pathspecs,
  ];
  const key = gitObjectReadKey(repo, commit, args);
  const cached = key === undefined ? undefined : options.memo?.trees.get(key);
  if (cached !== undefined) return cached.map((entry) => ({ ...entry }));
  const literalPaths = literalPathsOf(pathspecs);
  const batch =
    key === undefined || options.memo === undefined || literalPaths === null
      ? undefined
      : await batchTreeAtCommit(repo, commit, options.memo, literalPaths);
  const entries =
    batch !== undefined && literalPaths !== null
      ? entriesUnderLiteralPaths(
          batch,
          literalPaths,
          options.includeTrees === true,
        )
      : parseLsTree(await sourceReadText(repo, args));
  if (key !== undefined)
    options.memo?.trees.set(
      key,
      entries.map((entry) => ({ ...entry })),
    );
  return entries;
}

function parseLsTree(out: string): GitTreeEntry[] {
  return out
    .split("\0")
    .filter((s) => s.length > 0)
    .map((line) => {
      const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error(`unexpected git ls-tree output: ${line}`);
      return {
        mode: match[1]!,
        type: match[2]!,
        object: match[3]!,
        path: match[4]!,
      };
    });
}

function literalPathsOf(pathspecs: readonly string[]): string[] | null {
  const paths: string[] = [];
  for (const pathspec of pathspecs) {
    if (!pathspec.startsWith(":(literal)")) return null;
    const path = pathspec.slice(":(literal)".length);
    if (!isNormalRelPath(path)) return null;
    paths.push(path);
  }
  return paths;
}

/**
 * A tree can hold entries named `.` or `..` and Git refuses paths climbing out
 * of the repo, so only normal paths are batched.
 */
function isNormalRelPath(path: string): boolean {
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * With `-t` Git also prints each tree entered on the way to a selected path;
 * each is a parent of or under a covering path, so the batch listing holds it.
 */
function entriesUnderLiteralPaths(
  whole: readonly GitTreeEntry[],
  paths: readonly string[],
  includeTrees: boolean,
): GitTreeEntry[] {
  const out: GitTreeEntry[] = [];
  for (const entry of whole) {
    const selected = paths.some(
      (path) =>
        isAtOrUnder(entry.path, path) ||
        (entry.type === "tree" && isAtOrUnder(path, entry.path)),
    );
    if (!selected) continue;
    if (entry.type === "tree" && !includeTrees) continue;
    out.push({ ...entry });
  }
  return out;
}

function batchKey(repo: string, commit: string): string | undefined {
  return gitObjectReadKey(repo, commit, ["batch"]);
}

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function registerBatchReads(
  memo: GitReadMemo,
  repo: string,
  commit: string,
  pathspecs: readonly string[],
): void {
  const key = batchKey(repo, commit);
  const paths = literalPathsOf(pathspecs);
  if (key === undefined || paths === null) return;
  const registered = memo.batchPaths.get(key) ?? [];
  const grown = [...new Set([...registered, ...paths])];
  if (grown.length === registered.length) return;
  memo.batchPaths.set(key, grown);
  memo.batchTrees.delete(key);
}

/**
 * A failed read returns undefined and leaves nothing cached, so the caller asks
 * Git with its own arguments and reports its own error.
 */
async function batchTreeAtCommit(
  repo: string,
  commit: string,
  memo: GitReadMemo,
  requested: readonly string[],
): Promise<GitTreeEntry[] | undefined> {
  const key = batchKey(repo, commit);
  const registered = key === undefined ? undefined : memo.batchPaths.get(key);
  if (key === undefined || registered === undefined) return undefined;
  if (
    !requested.every((path) =>
      registered.some((root) => isAtOrUnder(path, root)),
    )
  )
    return undefined;
  const cached = memo.batchTrees.get(key);
  if (cached !== undefined) return cached;
  const result = await sourceRead(repo, [
    "ls-tree",
    "-r",
    "-t",
    "-z",
    commit,
    "--",
    ...registered.map((path) => `:(literal)${path}`),
  ]);
  if (result.exitCode !== 0) return undefined;
  const entries = parseLsTree(result.stdout.toString("utf-8"));
  memo.batchTrees.set(key, entries);
  return entries;
}

/**
 * `cat-file` applies no smudge filter and ignores the working tree, so the
 * bytes match what every clone of the commit produces.
 */
export class GitBlobReadError extends Error {
  readonly blobId: string;

  constructor(blobId: string, message: string) {
    super(message);
    this.blobId = blobId;
  }
}

function assertValidObjectNames(ids: readonly string[]): void {
  for (const id of ids) {
    if (!/^[0-9a-f]{40,64}$/.test(id)) {
      throw new Error(`invalid git object name: ${id}`);
    }
  }
}

/**
 * Large blobs (e.g. images in a skill) are re-read instead of memoized so the
 * memo never holds a second copy of large content.
 */
export const MEMO_BLOB_LIMIT = 1024 * 1024;

export async function catFileBlobs(
  repo: string,
  blobIds: Iterable<string>,
  memo?: GitReadMemo,
  keep = true,
): Promise<Map<string, Buffer>> {
  const requestedIds = [...blobIds];
  const out = new Map<string, Buffer>();
  const ids: string[] = [];
  for (const id of new Set(requestedIds)) {
    const key = gitObjectReadKey(repo, id);
    const cached = key === undefined ? undefined : memo?.blobs.get(key);
    if (cached === undefined) ids.push(id);
    else out.set(id, Buffer.from(cached));
  }
  if (ids.length === 0) return out;
  assertValidObjectNames(ids);
  try {
    const stdout = await sourceReadBuffer(repo, ["cat-file", "--batch"], {
      stdin: `${ids.join("\n")}\n`,
    });

    let offset = 0;
    for (const requested of ids) {
      const newline = stdout.indexOf(0x0a, offset);
      if (newline === -1) {
        throw new GitBlobReadError(
          requested,
          `unexpected end of git cat-file output for ${requested}`,
        );
      }
      const header = stdout.toString("utf-8", offset, newline);
      const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
      if (!match) {
        throw new GitBlobReadError(
          requested,
          `git cat-file could not read ${requested}: ${header}`,
        );
      }
      if (match[2] !== "blob") {
        throw new GitBlobReadError(
          requested,
          `${requested} is a ${match[2]}, not a blob`,
        );
      }
      const size = Number(match[3]);
      const start = newline + 1;
      const end = start + size;
      if (end > stdout.length) {
        throw new GitBlobReadError(
          requested,
          `truncated git cat-file output for ${requested}`,
        );
      }
      const content = stdout.subarray(start, end);
      out.set(match[1]!, content);
      const key = gitObjectReadKey(repo, requested);
      if (keep && key !== undefined && content.length <= MEMO_BLOB_LIMIT) {
        memo?.blobs.set(key, Buffer.from(content));
      }
      // Git writes a single LF after each object's contents.
      offset = end + 1;
    }
    return out;
  } finally {
    const readIds = new Set(ids);
    for (const id of requestedIds) {
      if (!readIds.has(id)) continue;
      recordGitRead("batch-blob", repo, [id], out.has(id), false);
    }
  }
}

/**
 * Sizes are read first because `catFileBlobs` buffers the whole batch output,
 * so a size limit applied after reading limits nothing.
 */
export async function catFileSizes(
  repo: string,
  blobIds: Iterable<string>,
): Promise<Map<string, number>> {
  const ids = [...new Set(blobIds)];
  const sizes = new Map<string, number>();
  if (ids.length === 0) return sizes;
  assertValidObjectNames(ids);
  const out = await sourceReadText(repo, ["cat-file", "--batch-check"], {
    stdin: `${ids.join("\n")}\n`,
  });
  for (const line of out.split("\n")) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (match) sizes.set(match[1]!, Number(match[2]));
  }
  return sizes;
}

export interface CheckAttrResult {
  path: string;
  attribute: string;
  value: string;
}

/**
 * Attributes come only from the commit's own .gitattributes, never from
 * machine-local sources. GIT_ATTR_NOSYSTEM and --source do not disable
 * $GIT_DIR/info/attributes, which still beats the committed .gitattributes. So
 * the query runs in a throwaway bare repository that has no info/attributes and
 * reaches the real objects through objects/info/alternates.
 */
export async function repositoryObjectsDirectory(
  repo: string,
): Promise<string> {
  return resolve(
    repo,
    (
      await sourceReadText(repo, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ])
    ).trim(),
  );
}

/**
 * A successful answer is kept in `memo` for the rest of the command. The query
 * reads only the commit's own `.gitattributes`, because the shadow repository
 * has no `info/attributes` and the system and global files are disabled. So the
 * answer for one full commit id, path, and attribute list cannot change, and it
 * does not depend on the other paths in the query. A query at a registered
 * commit therefore also asks for the files of every registered item.
 */
export async function checkAttrAtCommit(
  repo: string,
  commit: string,
  paths: string[],
  attributes: string[],
  observeObjectsDir?: () => Promise<string>,
  memo?: GitReadMemo,
): Promise<CheckAttrResult[]> {
  if (paths.length === 0 || attributes.length === 0) return [];
  for (const path of paths) {
    if (path.includes("\0")) {
      throw new Error(`invalid path for git check-attr: ${path}`);
    }
  }
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) {
    throw new Error(
      `checkAttrAtCommit needs a full object name, got ${commit}`,
    );
  }
  const cacheKey = gitObjectReadKey(repo, commit, [
    "check-attr",
    ...attributes,
  ]);
  if (
    memo === undefined ||
    cacheKey === undefined ||
    new Set(attributes).size !== attributes.length
  ) {
    return await runCheckAttr(
      repo,
      commit,
      paths,
      attributes,
      observeObjectsDir,
    );
  }
  const byPath = memo.attributesByPath.get(cacheKey);
  const own = new Set(paths.filter((path) => !byPath?.has(path)));
  const wanted = new Set(own);
  const registered = memo.batchPaths.get(batchKey(repo, commit) ?? "");
  if (wanted.size > 0 && registered !== undefined) {
    const batch = await batchTreeAtCommit(repo, commit, memo, registered);
    for (const entry of batch ?? []) {
      if (
        entry.type === "blob" &&
        !byPath?.has(entry.path) &&
        isNormalRelPath(entry.path)
      ) {
        wanted.add(entry.path);
      }
    }
  }
  if (wanted.size === 0) return answersFor(byPath, paths);
  let objectsDir: string | undefined;
  const observe = async (): Promise<string> =>
    (objectsDir ??= await (observeObjectsDir
      ? observeObjectsDir()
      : repositoryObjectsDirectory(repo)));
  await observe();
  const query = [...wanted];
  // Other items' files must not fail this caller's query; a failed batch keeps
  // nothing and the retry reports the caller's own error.
  const results =
    query.length === own.size
      ? await runCheckAttr(repo, commit, query, attributes, observe)
      : await runCheckAttr(repo, commit, query, attributes, observe).catch(
          () => [],
        );
  const answered = new Map<string, CheckAttrResult[]>();
  for (const result of results) {
    const list = answered.get(result.path) ?? [];
    list.push(result);
    answered.set(result.path, list);
  }
  const kept = byPath ?? new Map<string, CheckAttrResult[]>();
  for (const path of query) {
    const list = answered.get(path);
    if (
      list !== undefined &&
      list.length === attributes.length &&
      list.every((result, index) => result.attribute === attributes[index])
    ) {
      kept.set(path, list);
    }
  }
  memo.attributesByPath.set(cacheKey, kept);
  if (!paths.every((path) => kept.has(path))) {
    return await runCheckAttr(repo, commit, paths, attributes, observe);
  }
  return answersFor(kept, paths);
}

function answersFor(
  byPath: ReadonlyMap<string, CheckAttrResult[]> | undefined,
  paths: readonly string[],
): CheckAttrResult[] {
  return paths.flatMap((path) =>
    (byPath?.get(path) ?? []).map((result) => ({ ...result })),
  );
}

async function runCheckAttr(
  repo: string,
  commit: string,
  paths: string[],
  attributes: string[],
  observeObjectsDir?: () => Promise<string>,
): Promise<CheckAttrResult[]> {
  const objectsDir = await (observeObjectsDir
    ? observeObjectsDir()
    : repositoryObjectsDirectory(repo));
  const shadow = await mkdtemp(join(tmpdir(), "capshelf-attrs-"));
  try {
    await mkdir(join(shadow, "objects", "info"), { recursive: true });
    await mkdir(join(shadow, "refs"), { recursive: true });
    // Hash width selects the repository format, so no `rev-parse
    // --show-object-format` call or cached repository state is needed.
    const sha256 = commit.length === 64;
    await Promise.all([
      writeFile(join(shadow, "HEAD"), "ref: refs/heads/main\n"),
      writeFile(
        join(shadow, "config"),
        `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = true\n` +
          (sha256 ? "[extensions]\n\tobjectformat = sha256\n" : ""),
      ),
      writeFile(
        join(shadow, "objects", "info", "alternates"),
        `${objectsDir}\n`,
      ),
    ]);
    const result = await runGit(
      { profile: "repository-free", cwd: shadow },
      [
        `--git-dir=${shadow}`,
        "-c",
        "core.attributesFile=/dev/null",
        "check-attr",
        "-z",
        "--stdin",
        `--source=${commit}`,
        ...attributes,
      ],
      {
        env: {
          ...withoutVariables(process.env, REPOSITORY_SELECTING_ENV),
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ATTR_NOSYSTEM: "1",
        },
        stdin: `${paths.join("\0")}\0`,
      },
    );
    const fields = throwOnFailure(result, ["check-attr"])
      .toString("utf-8")
      .split("\0");
    const results: CheckAttrResult[] = [];
    for (let index = 0; index + 2 < fields.length; index += 3) {
      results.push({
        path: fields[index]!,
        attribute: fields[index + 1]!,
        value: fields[index + 2]!,
      });
    }
    return results;
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}

export async function sourceVisibleFilesUnderPath(
  repo: string,
  relPath: string,
): Promise<string[]> {
  const normalized = normalizeGitPath(relPath);
  const out = await sourceReadText(repo, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    literalPathspec(normalized),
  ]);
  return await presentFilesRelativeTo(repo, normalized, out);
}

export type VisibleFilesLister = (relPath: string) => Promise<string[]>;

export async function sourceVisibleFilesLister(
  repo: string,
  relPaths: readonly string[],
): Promise<VisibleFilesLister> {
  const paths = [...new Set(relPaths.map(normalizeGitPath))].filter(
    (path) => path.length > 0,
  );
  const result =
    paths.length < 2
      ? undefined
      : await sourceRead(repo, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ...paths.map(literalPathspec),
        ]).catch(() => undefined);
  const listed =
    result === undefined || result.exitCode !== 0
      ? undefined
      : result.stdout
          .toString("utf-8")
          .split("\0")
          .filter((path) => path.length > 0);
  return async (relPath) => {
    const normalized = normalizeGitPath(relPath);
    if (listed === undefined || !paths.includes(normalized)) {
      return await sourceVisibleFilesUnderPath(repo, relPath);
    }
    const own = listed.filter((path) => isAtOrUnder(path, normalized));
    return await presentFilesRelativeTo(
      repo,
      normalized,
      own.map((path) => `${path}\0`).join(""),
    );
  };
}

export async function projectVisibleFilesUnderPath(
  project: string,
  relPath: string,
): Promise<string[]> {
  const normalized = normalizeGitPath(relPath);
  const out = await projectPolicyText(project, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    literalPathspec(normalized),
  ]);
  return await presentFilesRelativeTo(project, normalized, out);
}

export interface IgnoreRule {
  source: string;
  line: number;
  pattern: string;
}

/**
 * Diagnosis only: a git failure returns null so it never replaces the caller's
 * original error.
 */
export async function projectIgnoreRule(
  project: string,
  relPath: string,
): Promise<IgnoreRule | null> {
  // `-z` requires `--stdin`. The output is `source NUL line NUL pattern NUL path NUL`.
  const result = await projectPolicy(
    project,
    ["check-ignore", "--verbose", "-z", "--stdin"],
    { stdin: `${normalizeGitPath(relPath)}\0` },
  );
  if (result.exitCode !== 0) return null;
  const [source, line, pattern] = result.stdout.toString("utf-8").split("\0");
  if (!source || !line || pattern === undefined) return null;
  return { source, line: Number(line), pattern };
}

/**
 * `git add -- <dir>` skips untracked files the ignore rules hide and exits 0
 * (verified on git 2.53.0), so a commit that names `relPaths` would omit them
 * silently. Git computes the set with its own rules, so no pattern is parsed
 * here. A Git failure throws.
 */
export async function ignoredUntrackedPaths(
  repo: string,
  relPaths: readonly string[],
): Promise<string[]> {
  if (relPaths.length === 0) return [];
  const out = await sourceReadText(repo, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...relPaths.map(literalPathspec),
  ]);
  return out
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
}

/**
 * `check-ignore --verbose` also prints records for paths a `!` rule
 * re-includes; those patterns start with `!` (an escaped literal prints as
 * `\!`).
 */
export async function sourceIgnoreRules(
  repo: string,
  relPaths: readonly string[],
): Promise<Map<string, IgnoreRule>> {
  const rules = new Map<string, IgnoreRule>();
  if (relPaths.length === 0) return rules;
  // Paths go unchanged: they come from Git or are built with `/`, and a
  // backslash is a valid filename character on Unix, so `normalizeGitPath`
  // would query a different file.
  const result = await sourceRead(
    repo,
    ["check-ignore", "--verbose", "-z", "--stdin"],
    { stdin: relPaths.map((path) => `${path}\0`).join("") },
  ).catch(() => null);
  if (result?.exitCode !== 0) return rules;
  // `-z` records are `source NUL line NUL pattern NUL path NUL`.
  const fields = result.stdout.toString("utf-8").split("\0");
  for (let at = 0; at + 3 < fields.length; at += 4) {
    const [source, line, pattern, path] = fields.slice(at, at + 4);
    if (!source || !line || pattern === undefined || !path) continue;
    if (pattern.startsWith("!")) continue;
    rules.set(path, { source, line: Number(line), pattern });
  }
  return rules;
}

/**
 * Refuse a publication commit that `git add -- <ownedRoots>` would silently
 * shorten because ignore rules skip files. Runs after the files are written and
 * before staging, so it sees the ignore rules the copy left behind.
 * `keptInPlace` names files the caller wrote back unchanged and does not
 * publish, such as a restored upstream sidecar.
 */
export async function assertNoIgnoredPublicationFiles(
  repo: string,
  ownedRoots: readonly string[],
  keptInPlace: readonly string[] = [],
): Promise<void> {
  const kept = new Set(keptInPlace);
  const ignored = (await ignoredUntrackedPaths(repo, ownedRoots)).filter(
    (path) => !kept.has(path),
  );
  if (ignored.length === 0) return;
  const rules = await sourceIgnoreRules(repo, ignored);
  throw new PreconditionError(
    ignoredPublicationMessage(ignored, rules, ownedRoots),
  );
}

/**
 * Repo-relative paths under `relPath` that the project's complete ignore stack
 * treats as visible. It does not `lstat` or reject what it returns, so an
 * ignore rule cannot fail a command about pinned content. The caller intersects
 * the result with a real filesystem inventory.
 */
export async function gitPolicyVisiblePathsUnderPath(
  project: string,
  relPath: string,
): Promise<string[] | null> {
  if (!(await isProjectWorkTreeRoot(project))) return null;
  const normalized = normalizeGitPath(relPath);
  const out = await projectPolicyText(project, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    literalPathspec(normalized),
  ]);
  return out
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => relativeToGitPath(path, normalized))
    .sort();
}

/**
 * Like `gitPolicyVisiblePathsUnderPath`, but without capshelf's own `ownLines`
 * in `.git/info/exclude`, so a local item is not all ignored. The other
 * `info/exclude` lines go in on stdin, because command-line patterns would
 * outrank `.gitignore` files. Null when `project` is not a Git work tree root.
 */
export async function gitPolicyVisiblePathsWithoutExcludes(
  project: string,
  relPath: string,
  ownLines: ReadonlySet<string>,
): Promise<string[] | null> {
  if (!(await isProjectWorkTreeRoot(project))) return null;
  const normalized = normalizeGitPath(relPath);
  const excludePath = await gitInfoExcludePath(project);
  let raw = "";
  if (excludePath !== null) {
    try {
      raw = await readFile(excludePath, "utf-8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  const keptLines = raw
    .split(/\r?\n/)
    .filter((line) => !ownLines.has(line.trim()))
    .join("\n");
  const excludesFile = await userExcludesFile(project);
  const args = [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-per-directory=.gitignore",
    "--exclude-from=/dev/stdin",
    // Git refuses a missing exclude file, so pass it only when it exists.
    ...(excludesFile === null ? [] : [`--exclude-from=${excludesFile}`]),
    "--",
    literalPathspec(normalized),
  ];
  const out = throwOnFailure(
    await projectPolicy(project, args, { stdin: `${keptLines}\n` }),
    args,
  ).toString("utf-8");
  return out
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => relativeToGitPath(path, normalized))
    .sort();
}

async function userExcludesFile(project: string): Promise<string | null> {
  const configured = await projectPolicy(project, [
    "config",
    "--path",
    "--get",
    "core.excludesFile",
  ]);
  const fromConfig = configured.stdout.toString("utf-8").trim();
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  const candidate =
    configured.exitCode === 0 && fromConfig.length > 0
      ? resolve(project, fromConfig)
      : xdg
        ? join(xdg, "git", "ignore")
        : home
          ? join(home, ".config", "git", "ignore")
          : null;
  if (candidate === null) return null;
  try {
    await access(candidate, constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function presentFilesRelativeTo(
  repo: string,
  normalized: string,
  lsFilesOutput: string,
): Promise<string[]> {
  const candidates = lsFilesOutput.split("\0").filter((p) => p.length > 0);
  const present = await Promise.all(
    candidates.map(async (path) => {
      try {
        const info = await lstat(join(repo, ...path.split("/")));
        if (info.isFile()) return path;
        const type = info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "directory or Git link"
            : "non-regular filesystem object";
        throw new PreconditionError(
          `${normalized} contains an unsupported ${type}: ${path}; copy items support regular files only`,
          info.isSymbolicLink()
            ? {
                hint: "Dependency installs create symlinks, for example node_modules from pnpm. Delete the path, or cover it with a .gitignore rule.",
              }
            : {},
        );
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return null;
        }
        throw error;
      }
    }),
  );
  return present
    .filter((path): path is string => path !== null)
    .map((path) => relativeToGitPath(path, normalized))
    .sort();
}

export interface StatusPorcelainRecord {
  code: string;
  path: string;
  origPath?: string;
}

/**
 * Keep `-z`: without it Git quotes paths with non-ASCII, control, quote, or
 * backslash characters, path comparisons stop matching, and dirty-state guards
 * fail open. R/C records need the next field because it holds the original
 * path without a status prefix.
 */
export async function statusPorcelainRecords(
  repo: string,
  relPaths: string[] = [],
  options: { untrackedFiles?: "all" } = {},
): Promise<StatusPorcelainRecord[]> {
  const args = [
    "status",
    "--porcelain",
    "-z",
    `--untracked-files=${options.untrackedFiles ?? "normal"}`,
  ];
  if (relPaths.length > 0) args.push("--", ...relPaths.map(literalPathspec));
  const out = await sourceReadText(repo, args);
  const fields = out.split("\0");
  const records: StatusPorcelainRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length === 0) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const origPath = fields[index + 1];
      index += 1;
      const record: StatusPorcelainRecord = { code, path };
      if (origPath !== undefined && origPath.length > 0) {
        record.origPath = origPath;
      }
      records.push(record);
      continue;
    }
    records.push({ code, path });
  }
  return records;
}

export interface IndexEntryFlags {
  path: string;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
}

/**
 * Git skips the worktree comparison for assume-unchanged/skip-worktree paths,
 * so `status` and `add` miss real edits; `ls-files -v` reports those bits
 * directly, whereas comparing bytes false-positives under clean filters or
 * autocrlf.
 */
export async function indexEntryFlags(
  repo: string,
  relPaths: string[],
): Promise<IndexEntryFlags[]> {
  if (relPaths.length === 0) return [];
  const out = await sourceReadText(repo, [
    "ls-files",
    "-v",
    "-z",
    "--",
    ...relPaths.map(literalPathspec),
  ]);
  const entries = new Map<string, IndexEntryFlags>();
  for (const record of out.split("\0")) {
    if (record.length < 3) continue;
    const tag = record.charAt(0);
    const assumeUnchanged = tag !== tag.toUpperCase();
    const path = record.slice(2);
    const existing = entries.get(path);
    entries.set(path, {
      path,
      assumeUnchanged: assumeUnchanged || existing?.assumeUnchanged === true,
      skipWorktree:
        tag.toUpperCase() === "S" || existing?.skipWorktree === true,
    });
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Raw porcelain text. Callers must only test this for emptiness — parsing
 * paths out of it is unsafe without `-z`; use `statusPorcelainRecords`.
 * Git's untracked-file setting must not change capshelf's cleanliness checks.
 */
export async function statusPorcelain(
  repo: string,
  relPath?: string,
): Promise<string> {
  if (relPath) {
    return await sourceReadText(repo, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      literalPathspec(relPath),
    ]);
  }
  return await sourceReadText(repo, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
}

export async function isRepoClean(repo: string): Promise<boolean> {
  const out = await statusPorcelain(repo);
  return out.trim().length === 0;
}

export async function assertRepoClean(repo: string): Promise<void> {
  if (await isRepoClean(repo)) return;
  throw new PreconditionError(
    `data repo has uncommitted changes\n  commit or stash them first: git -C ${repo} status --short`,
  );
}

export async function statusPorcelainOutsidePath(
  repo: string,
  relPath: string,
): Promise<string> {
  return await statusPorcelainOutsidePaths(repo, [relPath]);
}

export async function statusPorcelainOutsidePaths(
  repo: string,
  relPaths: string[],
): Promise<string> {
  return await sourceReadText(repo, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--",
    ".",
    ...relPaths.map(excludePathspec),
  ]);
}

export async function assertRepoCleanOutsidePath(
  repo: string,
  relPath: string,
): Promise<void> {
  await assertRepoCleanOutsidePaths(repo, [relPath]);
}

export async function assertRepoCleanOutsidePaths(
  repo: string,
  relPaths: string[],
): Promise<void> {
  const out = await statusPorcelainOutsidePaths(repo, relPaths);
  if (out.trim().length === 0) return;
  const label = relPaths.join(", ");
  throw new PreconditionError(
    `data repo has uncommitted changes outside ${label}\n  commit or stash unrelated changes first: git -C ${repo} status --short`,
  );
}

export async function isPathClean(
  repo: string,
  relPath: string,
): Promise<boolean> {
  const out = await statusPorcelain(repo, relPath);
  return out.trim().length === 0;
}

export type PathCleanCheck = (relPath: string) => Promise<boolean>;

/**
 * One `git status` of the whole repository answers for many paths. A path is
 * dirty when a record, or the original path of a rename, is the path itself or
 * lies under it. `--untracked-files=all` lists each file, so a collapsed
 * untracked directory cannot mark a path dirty that holds no file. The snapshot
 * is one observation: use it for one report, never for a plan that a later pass
 * revalidates.
 */
export async function worktreeCleanSnapshot(
  repo: string,
): Promise<PathCleanCheck> {
  const records = await statusPorcelainRecords(repo, [], {
    untrackedFiles: "all",
  });
  const changed = records.flatMap((record) =>
    record.origPath === undefined
      ? [record.path]
      : [record.path, record.origPath],
  );
  return async (relPath) => !changed.some((path) => isAtOrUnder(path, relPath));
}

/**
 * Authoring check only: the pin comes from the commit, but a dirty item means
 * the pinned commit is stale relative to what the author sees.
 */
export async function assertPathClean(
  repo: string,
  relPath: string,
): Promise<void> {
  const records = await statusPorcelainRecords(repo, [relPath]);
  if (records.length === 0) return;
  const sidecarPath = `${relPath}/.capshelf.yml`;
  // A rename of the sidecar moved content, so it must fall through to the
  // strict branch.
  if (records.every((record) => record.path === sidecarPath)) {
    throw new PreconditionError(
      `data repo has uncommitted metadata changes: ${sidecarPath}\n  no item content is at risk — commit the sidecar in the data repo first:\n    git -C ${repo} add ${sidecarPath} && git -C ${repo} commit -m "..."`,
    );
  }
  throw new PreconditionError(
    `data repo has uncommitted changes under ${relPath}\n  the recorded sha would not match its source commit. Commit first:\n    git -C ${repo} add ${relPath} && git -C ${repo} commit -m "..."`,
  );
}

export interface FetchResult {
  ok: boolean;
  stderr: string;
}

/**
 * Failures are returned, not thrown, so `sync-data` can include git's stderr in
 * its `fetch_failed` state.
 */
/**
 * Prune is opt-in: only the capshelf-owned clone cache wants it, and pruning a
 * user's data-repo clone with `--prune-tags` would delete their local tags.
 */
export async function fetchOrigin(
  repo: string,
  opts: { prune?: boolean } = {},
): Promise<FetchResult> {
  const result = await sourceWrite(repo, [
    "fetch",
    ...(opts.prune === true ? ["--prune", "--prune-tags"] : []),
    "origin",
  ]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr,
  };
}

export async function currentBranch(repo: string): Promise<string | null> {
  const result = await sourceRead(repo, [
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  if (result.exitCode !== 0) return null;
  const branch = result.stdout.toString().trim();
  return branch || null;
}

export async function trackingRef(
  repo: string,
  branch: string,
): Promise<string | null> {
  const upstream = await sourceRead(repo, [
    "rev-parse",
    "--abbrev-ref",
    `${branch}@{upstream}`,
  ]);
  if (upstream.exitCode === 0) {
    const ref = upstream.stdout.toString().trim();
    if (ref) return ref;
  }
  const fallback = `origin/${branch}`;
  const exists = await sourceRead(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${fallback}`,
  ]);
  return exists.exitCode === 0 ? fallback : null;
}

export async function aheadBehind(
  repo: string,
  ref: string,
): Promise<{ ahead: number; behind: number }> {
  const out = await sourceReadText(repo, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${ref}`,
  ]);
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  if (
    ahead === undefined ||
    behind === undefined ||
    Number.isNaN(ahead) ||
    Number.isNaN(behind)
  ) {
    throw new Error(`unexpected git rev-list output: ${out.trim()}`);
  }
  return { ahead, behind };
}

export async function fastForwardTo(repo: string, ref: string): Promise<void> {
  await sourceWriteBuffer(repo, ["merge", "--ff-only", ref]);
}

export async function headSha(repo: string): Promise<string> {
  const out = await sourceReadText(repo, ["rev-parse", "HEAD"]);
  return out.trim();
}

export async function commitInRepo(
  repo: string,
  relPaths: string[],
  message: string,
): Promise<string> {
  return await commitLiteralPathsInRepo(repo, relPaths, message);
}

/**
 * Commit exactly the supplied repository-relative paths. Literal pathspecs stop
 * metacharacters in paths that can originate in user data from widening the
 * staged set.
 */
export async function commitLiteralPathsInRepo(
  repo: string,
  relPaths: string[],
  message: string,
): Promise<string> {
  const pathspecs = relPaths.map(literalPathspec);
  await sourceWriteBuffer(repo, ["add", "--", ...pathspecs]);
  await sourceWriteBuffer(repo, ["commit", "-m", message, "--", ...pathspecs]);
  return (await sourceReadText(repo, ["rev-parse", "HEAD"])).trim();
}

export interface CommitExistingPathsInput {
  repo: string;
  relPaths: string[];
  message: string;
  expectedHead: string;
  verify?: (commit: string) => Promise<void>;
}

/**
 * The canonical files are the user's own edits, so rollback must not restore
 * the working tree or undo another writer's HEAD change. Hooks can add paths
 * to a partial commit, so the resulting commit must be checked against the
 * paths this operation may publish.
 */
export async function commitExistingPaths(
  input: CommitExistingPathsInput,
): Promise<string> {
  const { repo, relPaths, message, expectedHead, verify } = input;
  if (relPaths.length === 0) {
    throw new Error("commitExistingPaths needs at least one path");
  }
  if ((await headSha(repo)) !== expectedHead) {
    throw new PreconditionError("data repo HEAD changed during the commit");
  }
  await assertRepoCleanOutsidePaths(repo, relPaths);
  await assertNoIgnoredPublicationFiles(repo, relPaths);

  const indexPath = resolve(
    repo,
    (await sourceReadText(repo, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const backupRoot = await mkdtemp(join(tmpdir(), "capshelf-commit-"));
  const backupIndex = join(backupRoot, "index");
  let hadIndex = true;
  try {
    await copyFile(indexPath, backupIndex);
  } catch (error) {
    if (isErrno(error, "ENOENT")) hadIndex = false;
    else throw error;
  }
  let createdCommit: string | null = null;
  let createdParent: string | null = null;
  try {
    createdCommit = await commitLiteralPathsInRepo(repo, relPaths, message);
    createdParent = (await commitParents(repo, createdCommit))[0] ?? null;
    // Checking the commit's parent catches another writer advancing HEAD after
    // the `expectedHead` check, which would publish unreviewed work.
    if (createdParent !== expectedHead) {
      throw new PreconditionError("data repo HEAD changed during the commit");
    }
    await assertCommitTouchedOnly(repo, expectedHead, createdCommit, relPaths);
    await verify?.(createdCommit);
    return createdCommit;
  } catch (error) {
    const current = await headSha(repo).catch(() => null);
    if (createdCommit !== null && current === createdCommit) {
      // Revert to this commit's own parent, not `expectedHead`, so a commit
      // another writer landed is never deleted.
      const reverted =
        createdParent === null
          ? false
          : await sourceWriteBuffer(repo, [
              "update-ref",
              "HEAD",
              createdParent,
              createdCommit,
            ])
              .then(() => true)
              .catch(() => false);
      if (!reverted) throw error;
    } else if (current !== expectedHead) {
      // Skip index restore when something else moved HEAD; its index state
      // isn't ours.
      throw error;
    }
    if (hadIndex) await copyFile(backupIndex, indexPath).catch(() => {});
    else await rm(indexPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function commitParents(
  repo: string,
  commit: string,
): Promise<string[]> {
  const out = await sourceReadText(repo, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    commit,
  ]);
  return out.trim().split(/\s+/).slice(1);
}

async function assertCommitTouchedOnly(
  repo: string,
  base: string,
  commit: string,
  relPaths: string[],
): Promise<void> {
  const out = await sourceReadText(repo, [
    "diff-tree",
    "-r",
    "--name-only",
    "-z",
    base,
    commit,
    "--",
    ".",
    ...relPaths.map(excludePathspec),
  ]);
  const stray = out.split("\0").filter((path) => path.length > 0);
  if (stray.length === 0) return;
  throw new PreconditionError(
    [
      `not publishing ${relPaths.join(", ")}`,
      "  the commit changed paths this operation does not own",
      "",
      ...stray.map((path) => `    ${path}`),
      "",
      "  something between staging and the commit added them — a pre-commit hook",
      "  the data repo was rolled back; nothing was published",
    ].join("\n"),
  );
}

export async function cloneRepository(
  cwd: string,
  url: string,
  destination: string,
): Promise<GitInvocation> {
  return await repositoryFree(cwd, ["clone", "--", url, destination]);
}

export interface NormalizeRemoteUrlOptions {
  /**
   * Only the remote bootstrap path opts in; elsewhere a machine-local file://
   * path is not a portable upstream and is rejected.
   */
  allowFileUrls?: boolean;
}

export function normalizeRemoteUrl(
  url: string,
  options: NormalizeRemoteUrlOptions = {},
): string | null {
  const input = url.replace(/\r?\n$/, "").trim();
  if (input.length === 0) return null;

  const githubMatch = /^github:([^/]+\/.+)$/i.exec(input);
  if (githubMatch) {
    return normalizeUrlLike(`https://github.com/${githubMatch[1]!}`, options);
  }

  const scpLikeMatch = /^git@([^:]+):(.+)$/.exec(input);
  if (scpLikeMatch) {
    return normalizeUrlLike(
      `https://${scpLikeMatch[1]!}/${scpLikeMatch[2]!}`,
      options,
    );
  }

  const sshMatch = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(input);
  if (sshMatch) {
    return normalizeUrlLike(`https://${sshMatch[1]!}/${sshMatch[2]!}`, options);
  }

  return normalizeUrlLike(input, options);
}

function normalizeUrlLike(
  input: string,
  options: NormalizeRemoteUrlOptions,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (parsed.protocol === "file:") {
    if (!options.allowFileUrls) return null;
    // For `file://` remotes, keep a trailing `.git`: the path names a real
    // directory, and /tmp/repo.git and /tmp/repo are distinct directories.
    const host = parsed.hostname.toLowerCase();
    if (host && host !== "localhost") return null;
    const path = normalizeRemotePath(parsed.pathname, { stripDotGit: false });
    if (!path) return null;
    return `file:///${path}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.pathname === "/" || parsed.pathname === "") {
    return null;
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  // host (not hostname) keeps a non-default port: github.com:8443 and
  // github.com are different upstream identities.
  const host = parsed.host.toLowerCase();
  const path = normalizeRemotePath(parsed.pathname, { stripDotGit: true });
  if (!path) return null;

  return `${scheme}://${host}/${path}`;
}

function normalizeRemotePath(
  pathname: string,
  opts: { stripDotGit: boolean },
): string {
  // Strip until stable so normalization is idempotent (e.g.
  // `owner/repo/.git/`).
  let path = pathname;
  let previous: string;
  do {
    previous = path;
    path = path.replace(/\/+$/, "");
    if (opts.stripDotGit) path = path.replace(/\.git$/, "");
  } while (path !== previous);
  return path.replace(/^\/+/, "");
}

function normalizeGitPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}

export function literalPathspec(path: string): string {
  return `:(literal)${normalizeGitPath(path)}`;
}

/**
 * `literal` stops glob/magic in user-supplied item names from widening or
 * narrowing the exclusion.
 */
export function excludePathspec(path: string): string {
  return `:(literal,exclude)${normalizeGitPath(path)}`;
}

function relativeToGitPath(path: string, root: string): string {
  if (!root) return path;
  if (path === root) return basename(root);
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function commandExistsOnPath(
  command: string,
  pathEnv: string,
): Promise<boolean> {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of commandCandidateNames(command)) {
      try {
        await access(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

function commandCandidateNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  if (/\.[^\\/]+$/.test(command)) return [command];
  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .filter(Boolean)
    .flatMap((ext) => [`${command}${ext}`, `${command}${ext.toLowerCase()}`]);
}
