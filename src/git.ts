import { $ } from "bun";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { CliError, ExitCode } from "./errors";

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

export async function assertIsGitRepo(path: string): Promise<void> {
  await assertGitAvailable();
  if (await isGitRepo(path)) return;
  throw new Error(
    `not a git repository: ${path}\n  initialize with: git -C ${path} init && git -C ${path} add -A && git -C ${path} commit -m "baseline"`,
  );
}

export async function originRemoteUrl(repo: string): Promise<string | null> {
  await assertGitAvailable();
  try {
    return await $`git -C ${repo} remote get-url origin`.quiet().text();
  } catch {
    return null;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  await assertGitAvailable();
  try {
    await $`git -C ${path} rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
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
  await assertGitAvailable();
  if (relPaths.length === 0) {
    throw new Error(
      "cannot compute last touching commit for an empty path list",
    );
  }
  let out: string;
  try {
    out = await $`git -C ${repo} log -1 --format=%H -- ${relPaths}`
      .quiet()
      .text();
  } catch {
    out = "";
  }
  const sha = out.trim();
  if (!sha) {
    const relPathLabel = relPaths.join(", ");
    throw new Error(
      `no commit touches ${relPathLabel} in ${repo}\n  commit it first: git -C ${repo} add ${relPaths.join(" ")} && git -C ${repo} commit`,
    );
  }
  return sha;
}

export async function showAtCommit(
  repo: string,
  commit: string,
  relPath: string,
): Promise<Buffer> {
  await assertGitAvailable();
  const result = await $`git -C ${repo} show ${commit}:${relPath}`
    .quiet()
    .arrayBuffer();
  return Buffer.from(result);
}

export async function commitExists(
  repo: string,
  commit: string,
): Promise<boolean> {
  await assertGitAvailable();
  try {
    await $`git -C ${repo} cat-file -e ${commit}^{commit}`.quiet();
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
  await assertGitAvailable();
  const out = await $`git -C ${repo} ls-tree -r ${commit} -- ${relPath}`
    .quiet()
    .text();
  return out
    .trim()
    .split("\n")
    .filter((s) => s.length > 0)
    .map((line) => {
      const match = /^(\d{6})\s+(\S+)\s+([0-9a-f]+)\t(.+)$/.exec(line);
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
  await assertGitAvailable();
  const normalized = normalizeGitPath(relPath);
  const out =
    await $`git -C ${repo} ls-files -z --cached --others --exclude-standard -- ${normalized}`
      .quiet()
      .text();
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
  await assertGitAvailable();
  if (relPath) {
    return await $`git -C ${repo} status --porcelain -- ${relPath}`
      .quiet()
      .text();
  }
  return await $`git -C ${repo} status --porcelain`.quiet().text();
}

export async function isRepoClean(repo: string): Promise<boolean> {
  const out = await statusPorcelain(repo);
  return out.trim().length === 0;
}

export async function assertRepoClean(repo: string): Promise<void> {
  if (await isRepoClean(repo)) return;
  throw new Error(
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
  await assertGitAvailable();
  const excludes = relPaths.map((relPath) => `:(exclude)${relPath}`);
  return await $`git -C ${repo} status --porcelain -- . ${excludes}`
    .quiet()
    .text();
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
  throw new Error(
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
  if (await isPathClean(repo, relPath)) return;
  throw new Error(
    `data repo has uncommitted changes under ${relPath}\n  the recorded sha would not match its source commit. Commit first:\n    git -C ${repo} add ${relPath} && git -C ${repo} commit -m "..."`,
  );
}

export async function commitInRepo(
  repo: string,
  relPaths: string[],
  message: string,
): Promise<string> {
  await assertGitAvailable();
  await $`git -C ${repo} add ${relPaths}`.quiet();
  await $`git -C ${repo} commit -m ${message} -- ${relPaths}`.quiet();
  const out = await $`git -C ${repo} rev-parse HEAD`.quiet().text();
  return out.trim();
}

export function normalizeRemoteUrl(url: string): string | null {
  const input = url.replace(/\r?\n$/, "").trim();
  if (input.length === 0) return null;

  const githubMatch = /^github:([^/]+\/.+)$/i.exec(input);
  if (githubMatch) {
    return normalizeUrlLike(`https://github.com/${githubMatch[1]!}`);
  }

  const scpLikeMatch = /^git@([^:]+):(.+)$/.exec(input);
  if (scpLikeMatch) {
    return normalizeUrlLike(`https://${scpLikeMatch[1]!}/${scpLikeMatch[2]!}`);
  }

  const sshMatch = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(input);
  if (sshMatch) {
    return normalizeUrlLike(`https://${sshMatch[1]!}/${sshMatch[2]!}`);
  }

  return normalizeUrlLike(input);
}

function normalizeUrlLike(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.pathname === "/" || parsed.pathname === "") {
    return null;
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const host = parsed.hostname.toLowerCase();
  let path = parsed.pathname;
  path = path.replace(/\/+$/, "");
  path = path.replace(/\.git$/, "");
  path = path.replace(/^\/+/, "");
  if (path.length === 0) return null;

  return `${scheme}://${host}/${path}`;
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
