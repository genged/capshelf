import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { CliError, ExitCode, PreconditionError } from "./errors";

const GIT_MISSING_MESSAGE =
  "git is required but was not found on PATH\n  install Git, then retry";

/**
 * `git check-attr --source=<tree-ish>` arrived in Git 2.40.0, and PIN-9 has no
 * working-tree fallback: reading attributes from the worktree would let a
 * machine-local file decide whether a pin is portable, which is the class of
 * failure this design exists to remove.
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

/*
 * THE EXECUTION PROFILES (PIN-4)
 *
 * A repository path is not a complete Git safety policy. A read from the data
 * repo must ignore replacement refs. A project ignore query must use the
 * project's own configuration. A commit must keep the transaction's index and
 * hook policy. A no-index diff must not run an external helper. One nullable
 * `repo` argument cannot express those differences — and could not: `null`
 * meant both "no repository needed" and "use whatever repository the process
 * working directory happens to be in", which is what made `status --diff`
 * render its answer under the user's own `core.autocrlf`.
 *
 * | profile          | binding                | policy                                                              |
 * | ---------------- | ---------------------- | ------------------------------------------------------------------- |
 * | source-read      | -C <dataRepo>          | replacement refs disabled; repository-selecting environment stripped  |
 * | source-write     | -C <dataRepo>          | fixed binding; index/hook policy owned by the caller's transaction    |
 * | project-policy   | -C <project>           | fixed binding; project ignore and tracking configuration retained     |
 * | repository-free  | explicit cwd           | repository-selecting environment stripped; transport config retained  |
 * | isolated-diff    | disposable directory   | neutral attributes and line endings; no external diff or textconv     |
 * | isolated-merge   | disposable repository  | neutral config, hooks, attributes, and environment                    |
 *
 * Every wrapper below names exactly one. There is no default and no fallback
 * to the process working directory.
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

/** Test seam: forget the cached `git --version` answer for this process. */
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
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return stdout.trim().replace(/^git version /, "") || "(unknown)";
}

/**
 * The leading numeric triple of a `git --version` string. Vendor builds append
 * their own suffix (`2.39.5 (Apple Git-154)`, `2.40.0.windows.1`), which must
 * not change the comparison.
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
  /** trimmed */
  stderr: string;
}

export interface GitRunOptions {
  /**
   * Replaces the profile's environment entirely. Only `source-write` and
   * `isolated-merge` use it — a transaction supplies its own `GIT_INDEX_FILE`,
   * and the merge sandbox supplies a whole neutral environment.
   */
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
}

/**
 * Variables that redefine which repository, index, or object store a git
 * command actually touches. An ambient `GIT_DIR` or
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` silently makes `-C <repo>` a lie, so any
 * profile whose whole point is a fixed binding removes them.
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
] as const;

/** Command-line config injection and diff helper selection. */
const DIFF_HELPER_ENV = [
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

function withoutVariables(
  env: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of names) delete out[name];
  return out;
}

function environmentFor(
  binding: GitBinding,
  options: GitRunOptions,
): Record<string, string | undefined> {
  if (options.env) return options.env;
  switch (binding.profile) {
    case "source-read":
      return {
        ...withoutVariables(process.env, REPOSITORY_SELECTING_ENV),
        // Replacement refs are honored by default, so `log`, `ls-tree`, and
        // `cat-file` would agree with each other on a rewritten history while
        // the lock recorded an object id that resolves differently in every
        // other clone. They are a legitimate local tool, so they are ignored
        // here rather than refused.
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
      return ["git", "-C", binding.repo, "--no-replace-objects", ...args];
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

// Execute git with args as an explicit argv array — never a shell string. This
// is the ONLY way capshelf runs git: Bun's `$` applies a shell-escape layer
// that also mis-serializes some non-Latin1 strings when building argv,
// corrupting pathspecs/refs for non-ASCII item names. Bun.spawn takes argv
// directly and bypasses that layer. Never throws on nonzero exit — callers
// decide how to treat exit codes.
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
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => Buffer.from(b)),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr: stderr.trim() };
}

function throwOnFailure(result: GitInvocation, args: string[]): Buffer {
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || `git ${args.join(" ")} exited ${result.exitCode}`,
    );
  }
  return result.stdout;
}

/* ---------------------------------------------------------------- profiles */

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
): Promise<GitInvocation> {
  return await runGit({ profile: "project-policy", repo }, args);
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
 * Render a diff between two files that are already on disk in `cwd`.
 *
 * The argv is fixed, not composed by the caller, because every one of these
 * flags closes a way for the machine's configuration to answer instead of the
 * bytes: `--no-ext-diff` blocks `diff.external` and `GIT_EXTERNAL_DIFF`,
 * `--no-textconv` blocks a driver selected through attributes, `--text` makes
 * the output independent of Git's binary heuristic, and the two `-c` settings
 * stop `core.autocrlf` and `.gitattributes` from normalizing the very
 * difference the user is trying to see. Before this, `git diff --no-index` ran
 * in the user's own directory under their global config, so a CRLF-versus-LF
 * difference reported *nothing* on a machine with `core.autocrlf=input` — the
 * one command run to investigate shared the defect it was meant to expose.
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

/* ------------------------------------------------------- repository facts */

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
 * Where the project's own `.git/info/exclude` lives. Project policy, not
 * identity: capshelf writes this file so a `--local` item stays out of the
 * project's history (PIN-5's second retained job).
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

/** `isGitWorkTreeRoot`, bound to the consuming project instead of a data repo. */
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
 * The commit whose tree at `relPath` matches the current HEAD content.
 * Used as the `sourceCommit` recorded in lock entries.
 */
export async function lastTouchingCommit(
  repo: string,
  relPath: string,
): Promise<string> {
  return await lastTouchingCommitForPaths(repo, [relPath]);
}

export async function lastTouchingCommitForPaths(
  repo: string,
  relPaths: string[],
): Promise<string> {
  const sha = await tryLastTouchingCommitForPathspecs(
    repo,
    relPaths.map(literalPathspec),
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
 * The `sourceCommit` for a copy item: the last commit touching the item path
 * with the root metadata sidecar excluded via a git pathspec. A
 * `.capshelf.yml`-only commit therefore never moves the result, so `update`
 * after a metadata-only data-repo commit stays a true no-op (no lock rewrite
 * in any consuming project). Falls back to the unfiltered commit for the
 * degenerate history where only the sidecar has ever been committed under
 * the path.
 */
export async function lastTouchingContentCommit(
  repo: string,
  relPath: string,
): Promise<string> {
  const sha = await tryLastTouchingCommitForPathspecs(repo, [
    literalPathspec(relPath),
    excludePathspec(`${relPath}/.capshelf.yml`),
  ]);
  if (sha) return sha;
  return await lastTouchingCommit(repo, relPath);
}

async function tryLastTouchingCommitForPathspecs(
  repo: string,
  pathspecs: string[],
): Promise<string | null> {
  if (pathspecs.length === 0) {
    throw new Error(
      "cannot compute last touching commit for an empty path list",
    );
  }
  const result = await sourceRead(repo, [
    "log",
    "-1",
    "--format=%H",
    "--",
    ...pathspecs,
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString("utf-8").trim() || null;
}

export async function showAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<Buffer> {
  return await sourceReadBuffer(repo, ["show", `${commit}:${relPath}`]);
}

export async function commitExists(
  repo: string,
  commit: string,
): Promise<boolean> {
  return (
    (await sourceRead(repo, ["cat-file", "-e", `${commit}^{commit}`]))
      .exitCode === 0
  );
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
    throw new PreconditionError(
      `${itemPath} contains an unsupported Git entry: ${entry.path} (mode ${entry.mode}, type ${entry.type}); copy items support regular files only`,
    );
  }
}

/**
 * List files in a directory at a specific commit. Returns paths relative to
 * the repo root. Used by `apply` to enumerate what to restore.
 */
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
 * One `ls-tree -r -z` over an explicit pathspec list. PIN-1 takes item
 * identity from exactly this output, so it must stay one call: two calls could
 * observe two different repository states, and a per-path call would let a
 * missing path be silently dropped.
 *
 * `-z` terminates records with NUL and, crucially, emits pathnames verbatim
 * instead of git's default octal-quoting. Without it, filenames with
 * non-ASCII/control/quote characters come back quoted (e.g. `"caf\303\251"`)
 * and every downstream read fails to find them.
 */
export async function lsTreeEntriesForPathspecs(
  repo: string,
  commit: string,
  pathspecs: string[],
): Promise<GitTreeEntry[]> {
  if (pathspecs.length === 0) return [];
  const out = await sourceReadText(repo, [
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    ...pathspecs,
  ]);
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

/**
 * Read blobs straight out of the object database, in one subprocess.
 *
 * `cat-file` applies no smudge filter and consults no working tree, so what
 * this returns is exactly what the commit holds — the same bytes every `git
 * clone` of that repository produces. That is the whole of PIN-3: `add` used
 * to copy the data repo's *working tree* while `apply` read the commit, and
 * the two disagreeing is what let a lock be written that no later command
 * could satisfy.
 */
export async function catFileBlobs(
  repo: string,
  blobIds: Iterable<string>,
): Promise<Map<string, Buffer>> {
  const ids = [...new Set(blobIds)];
  const out = new Map<string, Buffer>();
  if (ids.length === 0) return out;
  for (const id of ids) {
    if (!/^[0-9a-f]{40,64}$/.test(id)) {
      throw new Error(`invalid git object name: ${id}`);
    }
  }
  const stdout = await sourceReadBuffer(repo, ["cat-file", "--batch"], {
    stdin: `${ids.join("\n")}\n`,
  });

  let offset = 0;
  for (const requested of ids) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) {
      throw new Error(`unexpected end of git cat-file output for ${requested}`);
    }
    const header = stdout.toString("utf-8", offset, newline);
    const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
    if (!match) {
      throw new Error(`git cat-file could not read ${requested}: ${header}`);
    }
    if (match[2] !== "blob") {
      throw new Error(`${requested} is a ${match[2]}, not a blob`);
    }
    const size = Number(match[3]);
    const start = newline + 1;
    const end = start + size;
    if (end > stdout.length) {
      throw new Error(`truncated git cat-file output for ${requested}`);
    }
    out.set(match[1]!, stdout.subarray(start, end));
    // Git writes a single LF after each object's contents.
    offset = end + 1;
  }
  return out;
}

export interface CheckAttrResult {
  path: string;
  attribute: string;
  /** `unspecified`, `unset`, `set`, or the attribute's string value. */
  value: string;
}

/**
 * Read attributes as the *commit* declares them (PIN-9).
 *
 * `check-attr` resolves a stack of sources, three of which are machine-local:
 * `$GIT_DIR/info/attributes`, `core.attributesFile`, and the system-wide
 * `gitattributes`. Letting any of them decide would make the same commit
 * portable on one machine and not on another — a machine-local identity input
 * reintroduced through the back door, which is the failure this whole design
 * removes.
 *
 * **Correction to the spec's stated mechanism.** The design says the three are
 * neutralized by `GIT_ATTR_NOSYSTEM=1`, `-c core.attributesFile=/dev/null`,
 * and `--source=<commit>`. Those cover only two: `GIT_ATTR_NOSYSTEM` disables
 * the *system* file, and neither it nor `--source` disables
 * `$GIT_DIR/info/attributes`, which still wins over the committed
 * `.gitattributes`. Reproduced here — with `plain.md filter=local-only` in
 * `.git/info/attributes`, `check-attr --source=<commit>` reported
 * `filter: local-only` for a commit that declares nothing for that path.
 *
 * So the query is bound instead to a throwaway bare repository that has no
 * `info/attributes` at all and reaches the real objects through
 * `objects/info/alternates`. It is four small file writes and no extra
 * subprocess, and it makes the local override structurally unable to
 * participate rather than merely unlikely to.
 */
export async function checkAttrAtCommit(
  repo: string,
  commit: string,
  paths: string[],
  attributes: string[],
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
  const objectsDir = resolve(
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
  const shadow = await mkdtemp(join(tmpdir(), "capshelf-attrs-"));
  try {
    await mkdir(join(shadow, "objects", "info"), { recursive: true });
    await mkdir(join(shadow, "refs"), { recursive: true });
    // Hash width selects the repository format, exactly as it selects the
    // digest algorithm in PIN-1 — no `rev-parse --show-object-format` call and
    // no cached repository state.
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

/**
 * Files under relPath that git would treat as owned working-tree content in
 * the *data repo*: tracked files plus untracked files that are not ignored.
 */
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

/** The same question, asked of the consuming project's own Git policy. */
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

/**
 * Repo-relative paths under `relPath` that the project's complete ignore stack
 * treats as visible — `.gitignore` at every level, parent ignore files,
 * `.git/info/exclude`, and `core.excludesFile`.
 *
 * Unlike `projectVisibleFilesUnderPath` this neither `lstat`s nor rejects what
 * it returns: PIN-5 uses it only to classify unpinned extras, and the caller
 * intersects the result with a real filesystem inventory. Rejecting here would
 * make an ignore rule able to fail a command about pinned content, which is
 * exactly the coupling PIN-5 removes.
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
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  /** The two-character XY status code, e.g. `??`, ` M`, `R `. */
  code: string;
  /** Repo-relative path, verbatim. */
  path: string;
  /** For a rename or copy, the path the entry moved from. */
  origPath?: string;
}

/**
 * `git status --porcelain -z`, parsed into records.
 *
 * `-z` is not optional. Without it git octal-quotes any path containing
 * non-ASCII, control, quote, or backslash characters
 * (`"codex/generated/caf\303\251/plugin.json"`), so every caller that
 * compares a parsed path against a real one silently stops matching — which
 * fails open for a dirty-state guard and fails closed for a diagnosis.
 *
 * `-z` also changes the rename encoding, and a naive `split("\0")` gets it
 * wrong: the original path arrives as a **bare follow-on record with no
 * status prefix**, so the parser must consume the next record when the code
 * is `R` or `C` or it will slice a status prefix off a plain path. That is
 * why this is the only place in the codebase that parses porcelain paths.
 */
export async function statusPorcelainRecords(
  repo: string,
  relPaths: string[] = [],
  options: { untrackedFiles?: "all" } = {},
): Promise<StatusPorcelainRecord[]> {
  const args = ["status", "--porcelain", "-z"];
  if (options.untrackedFiles === "all") args.push("--untracked-files=all");
  if (relPaths.length > 0) args.push("--", ...relPaths.map(literalPathspec));
  const out = await sourceReadText(repo, args);
  // The stream is NUL-terminated, so the trailing element is always empty.
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
      records.push({ code, path, ...(origPath ? { origPath } : {}) });
      continue;
    }
    records.push({ code, path });
  }
  return records;
}

/**
 * Raw porcelain text. Callers must only test this for emptiness — parsing
 * paths out of it is unsafe without `-z`; use `statusPorcelainRecords`.
 */
export async function statusPorcelain(
  repo: string,
  relPath?: string,
): Promise<string> {
  if (relPath) {
    return await sourceReadText(repo, [
      "status",
      "--porcelain",
      "--",
      literalPathspec(relPath),
    ]);
  }
  return await sourceReadText(repo, ["status", "--porcelain"]);
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

/**
 * Returns true if the working tree under `relPath` matches HEAD —
 * no modified, staged, or untracked files within that path.
 */
export async function isPathClean(
  repo: string,
  relPath: string,
): Promise<boolean> {
  const out = await statusPorcelain(repo, relPath);
  return out.trim().length === 0;
}

/**
 * Throws if the path has uncommitted changes.
 *
 * Under tree identity this is an *authoring* check, not an identity check:
 * a dirty item means the commit capshelf is about to pin is stale relative to
 * what the author is looking at. The recorded pin comes from the commit either
 * way, so nothing downstream depends on this passing.
 */
export async function assertPathClean(
  repo: string,
  relPath: string,
): Promise<void> {
  const records = await statusPorcelainRecords(repo, [relPath]);
  if (records.length === 0) return;
  const sidecarPath = `${relPath}/.capshelf.yml`;
  // Renames are attributed to the new path; a rename *of* the sidecar moved
  // content and correctly falls through to the strict branch.
  if (records.every((record) => record.path === sidecarPath)) {
    // Metadata-dirty, not content-dirty: the catalog must not be read from
    // limbo, but no item content is at risk — the fix is a one-line commit.
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
  /** git's stderr, trimmed; empty on success */
  stderr: string;
}

/**
 * `git fetch origin`. Fetch is always safe: it only updates remote-tracking
 * refs and never touches the worktree or local branches. Failures (network,
 * auth, missing remote repo) are reported, not thrown, so `sync-data` can
 * include git's stderr in its `fetch_failed` state.
 */
export async function fetchOrigin(repo: string): Promise<FetchResult> {
  const result = await sourceWrite(repo, ["fetch", "origin"]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr,
  };
}

/** Current branch name, or null when HEAD is detached. */
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

/**
 * The integration target for `branch`: its configured `@{upstream}` when set,
 * else `origin/<branch>` when that remote-tracking ref exists, else null.
 * The fallback is transient — this never writes branch config.
 */
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

/** Commit counts on each side of HEAD...<ref> (left = ahead, right = behind). */
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

/** Fast-forward the current branch to `ref`; throws when not a fast-forward. */
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
 * Commit exactly the supplied repository-relative paths with Git pathspec
 * magic disabled. Marketplace transactions use fixed owned roots plus skill
 * paths that can originate in user data; literal mode prevents metacharacters
 * from widening the staged set.
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
  /** Repository-relative paths the user edited where they already live. */
  relPaths: string[];
  message: string;
  expectedHead: string;
}

/**
 * Commit content the user authored in place inside the data repo.
 *
 * The other commit operation, `commitDataRepoMutation`, owns the files it
 * writes and restores them on failure. That is exactly wrong here: the
 * canonical file *is* the user's own edit, and putting back the version
 * capshelf found would throw their work away. So "what it changed" is the index
 * and `HEAD` only (GIT-7); the working tree is never touched.
 *
 * The commit runs the repository's normal hooks (GIT-9), which is the whole
 * point of the rollback — a `pre-commit` hook that rejects used to leave the
 * paths staged in the user's index after a command that failed. A hook can also
 * *add* to a partial commit, because git runs it against the temporary index it
 * built for the named paths, so the resulting commit is checked against the
 * paths this operation was allowed to publish.
 */
export async function commitExistingPaths(
  input: CommitExistingPathsInput,
): Promise<string> {
  const { repo, relPaths, message, expectedHead } = input;
  if (relPaths.length === 0) {
    throw new Error("commitExistingPaths needs at least one path");
  }
  if ((await headSha(repo)) !== expectedHead) {
    throw new PreconditionError("data repo HEAD changed during the commit");
  }
  await assertRepoCleanOutsidePaths(repo, relPaths);

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") hadIndex = false;
    else throw error;
  }
  let createdCommit: string | null = null;
  let createdParent: string | null = null;
  try {
    createdCommit = await commitLiteralPathsInRepo(repo, relPaths, message);
    createdParent = (await commitParents(repo, createdCommit))[0] ?? null;
    // The `expectedHead` check above cannot bind the commit that happens
    // after it. Reading the parent can: if another writer advanced HEAD in
    // between, this commit sits on their work rather than on the state the
    // caller validated, and publishing it would fold an unreviewed advance
    // into the lock.
    if (createdParent !== expectedHead) {
      throw new PreconditionError("data repo HEAD changed during the commit");
    }
    await assertCommitTouchedOnly(repo, expectedHead, createdCommit, relPaths);
    return createdCommit;
  } catch (error) {
    const current = await headSha(repo).catch(() => null);
    if (createdCommit !== null && current === createdCommit) {
      // Back to this commit's own parent, not to `expectedHead`: they are the
      // same in the ordinary case, and where they differ the parent is a
      // commit somebody else landed, which is not this operation's to delete.
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
      // Something outside this operation moved HEAD. Its index state is not
      // ours to put back.
      throw error;
    }
    if (hadIndex) await copyFile(backupIndex, indexPath).catch(() => {});
    else await rm(indexPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** The parent commits of `commit`, in order; empty for a root commit. */
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

/** `git clone`, which by definition does not start inside a repository. */
export async function cloneRepository(
  cwd: string,
  url: string,
  destination: string,
): Promise<GitInvocation> {
  return await repositoryFree(cwd, ["clone", "--", url, destination]);
}

export interface NormalizeRemoteUrlOptions {
  /**
   * Accept file:// URLs. Only the remote bootstrap path opts in, for clone
   * identity and origin comparison; everywhere else (committed manifest
   * upstreams, set-upstream, init origin auto-detection) a machine-local
   * file:// path is not a portable upstream and stays rejected.
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
    // file:// remotes only make sense for the local machine; a non-localhost
    // host would not be resolvable as a git remote here. The path names a
    // real directory, so a trailing .git is kept: /tmp/repo.git and
    // /tmp/repo are distinct directories.
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
  // Strip until stable so normalization is idempotent: a path like
  // "owner/repo/.git" first loses ".git", then the exposed trailing slash.
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
 * The same renderer for the other direction (GIT-4). Item names reach pathspecs
 * from user data, so an exclusion built by string concatenation is a pathspec
 * whose meaning depends on the name — `literal` disables the glob and magic
 * interpretation that would otherwise widen or narrow what is excluded. Git
 * accepts the combined magic words, verified.
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
