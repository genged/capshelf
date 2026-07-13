import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { CliError, ExitCode, PreconditionError } from "./errors";

const GIT_MISSING_MESSAGE =
  "git is required but was not found on PATH\n  install Git, then retry";

export class GitUnavailableError extends CliError {
  constructor() {
    super(GIT_MISSING_MESSAGE, { exitCode: ExitCode.GitUnavailable });
  }
}

let checkedPath: string | undefined;
let checkedAvailable = false;

export async function assertGitAvailable(): Promise<void> {
  const pathEnv = process.env.PATH ?? "";
  if (checkedPath === pathEnv && checkedAvailable) return;
  checkedPath = pathEnv;
  checkedAvailable = await commandExistsOnPath("git", pathEnv);
  if (!checkedAvailable) throw new GitUnavailableError();
}

export interface GitInvocation {
  exitCode: number;
  stdout: Buffer;
  /** trimmed */
  stderr: string;
}

// Execute git with args as an explicit argv array — never a shell string. This
// is the ONLY way capshelf runs git: Bun's `$` applies a shell-escape layer
// that also mis-serializes some non-Latin1 strings when building argv,
// corrupting pathspecs/refs for non-ASCII item names. Bun.spawn takes argv
// directly and bypasses that layer. Pass repo=null for commands without -C
// (e.g. `git clone`, `git diff --no-index`). Never throws on nonzero exit —
// callers decide how to treat exit codes.
export async function gitTry(
  repo: string | null,
  args: string[],
): Promise<GitInvocation> {
  await assertGitAvailable();
  const argv = repo === null ? ["git", ...args] : ["git", "-C", repo, ...args];
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => Buffer.from(b)),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr: stderr.trim() };
}

// Run git and throw on nonzero exit (message = git's stderr). Returns raw
// stdout bytes.
export async function gitBuffer(
  repo: string | null,
  args: string[],
): Promise<Buffer> {
  const r = await gitTry(repo, args);
  if (r.exitCode !== 0) {
    throw new Error(r.stderr || `git ${args.join(" ")} exited ${r.exitCode}`);
  }
  return r.stdout;
}

// Same, decoding stdout as UTF-8 text.
export async function gitText(
  repo: string | null,
  args: string[],
): Promise<string> {
  return (await gitBuffer(repo, args)).toString("utf-8");
}

export async function assertIsGitRepo(path: string): Promise<void> {
  await assertGitAvailable();
  if (await isGitRepo(path)) return;
  throw new PreconditionError(
    `not a git repository: ${path}\n  initialize with: git -C ${path} init && git -C ${path} add -A && git -C ${path} commit -m "baseline"`,
  );
}

export async function originRemoteUrl(repo: string): Promise<string | null> {
  try {
    return await gitText(repo, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await gitBuffer(path, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export async function gitWorkTreeRoot(path: string): Promise<string | null> {
  try {
    const out = await gitText(path, ["rev-parse", "--show-toplevel"]);
    return resolve(out.trim());
  } catch {
    return null;
  }
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

export async function gitInfoExcludePath(repo: string): Promise<string | null> {
  if (!(await isGitWorkTreeRoot(repo))) return null;
  const out = await gitText(repo, ["rev-parse", "--git-path", "info/exclude"]);
  return resolve(repo, out.trim());
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
  const sha = await tryLastTouchingCommitForPaths(repo, relPaths);
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
  // `literal` disables glob interpretation so item names containing pathspec
  // metacharacters cannot widen the exclusion (git accepts combined magic
  // words, verified). The non-literal include pathspec shares
  // lastTouchingCommit's pre-existing exposure and stays consistent with it.
  const sha = await tryLastTouchingCommitForPaths(repo, [
    relPath,
    `:(literal,exclude)${relPath}/.capshelf.yml`,
  ]);
  if (sha) return sha;
  return await lastTouchingCommit(repo, relPath);
}

async function tryLastTouchingCommitForPaths(
  repo: string,
  relPaths: string[],
): Promise<string | null> {
  if (relPaths.length === 0) {
    throw new Error(
      "cannot compute last touching commit for an empty path list",
    );
  }
  let out: string;
  try {
    out = await gitText(repo, ["log", "-1", "--format=%H", "--", ...relPaths]);
  } catch {
    out = "";
  }
  const sha = out.trim();
  return sha || null;
}

export async function showAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<Buffer> {
  return await gitBuffer(repo, ["show", `${commit}:${relPath}`]);
}

export async function commitExists(
  repo: string,
  commit: string,
): Promise<boolean> {
  try {
    await gitBuffer(repo, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
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
  // -z terminates records with NUL and, crucially, emits pathnames verbatim
  // instead of git's default octal-quoting. Without it, filenames with
  // non-ASCII/control/quote characters come back quoted (e.g. "caf\303\251")
  // and every downstream `git show <commit>:<path>` fails to find them.
  const out = await gitText(repo, [
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    relPath,
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
 * Files under relPath that git would treat as owned working-tree content:
 * tracked files plus untracked files that are not ignored by .gitignore,
 * .git/info/exclude, or global excludes.
 */
export async function gitVisibleFilesUnderPath(
  repo: string,
  relPath: string,
): Promise<string[]> {
  const normalized = normalizeGitPath(relPath);
  const out = await gitText(repo, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    normalized,
  ]);
  return out
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => relativeToGitPath(path, normalized))
    .sort();
}

export async function statusPorcelain(
  repo: string,
  relPath?: string,
): Promise<string> {
  if (relPath) {
    return await gitText(repo, ["status", "--porcelain", "--", relPath]);
  }
  return await gitText(repo, ["status", "--porcelain"]);
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
  const excludes = relPaths.map((relPath) => `:(exclude)${relPath}`);
  return await gitText(repo, ["status", "--porcelain", "--", ".", ...excludes]);
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
 * Throws if the path has uncommitted changes. Used by `add`/`update`/`promote`
 * to guarantee the recorded sha and sourceCommit refer to the same content.
 */
export async function assertPathClean(
  repo: string,
  relPath: string,
): Promise<void> {
  const out = await statusPorcelain(repo, relPath);
  if (out.trim().length === 0) return;
  const sidecarPath = `${relPath}/.capshelf.yml`;
  if (dirtyPathsFromPorcelain(out).every((path) => path === sidecarPath)) {
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

function dirtyPathsFromPorcelain(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const path = line.slice(3);
      // Renames are reported as "XY old -> new"; the new path is what counts.
      const arrow = path.lastIndexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    });
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
  const result = await gitTry(repo, ["fetch", "origin"]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr,
  };
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(repo: string): Promise<string | null> {
  const result = await gitTry(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
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
  const upstream = await gitTry(repo, [
    "rev-parse",
    "--abbrev-ref",
    `${branch}@{upstream}`,
  ]);
  if (upstream.exitCode === 0) {
    const ref = upstream.stdout.toString().trim();
    if (ref) return ref;
  }
  const fallback = `origin/${branch}`;
  const exists = await gitTry(repo, [
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
  const out = await gitText(repo, [
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
  await gitBuffer(repo, ["merge", "--ff-only", ref]);
}

export async function headSha(repo: string): Promise<string> {
  const out = await gitText(repo, ["rev-parse", "HEAD"]);
  return out.trim();
}

export async function commitInRepo(
  repo: string,
  relPaths: string[],
  message: string,
): Promise<string> {
  await gitBuffer(repo, ["add", ...relPaths]);
  await gitBuffer(repo, ["commit", "-m", message, "--", ...relPaths]);
  const out = await gitText(repo, ["rev-parse", "HEAD"]);
  return out.trim();
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
