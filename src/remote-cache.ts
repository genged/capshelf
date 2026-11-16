/**
 * The path is derived from the upstream on every read and never stored, so
 * stale machine state cannot decide which objects a pin reads.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSafeGitRef } from "./assert";
import { cloneRelativeSegments, ensureClone } from "./data-bootstrap";
import { fetchOrigin, resolveCommit, sourceRead } from "./git";
import { PRODUCT_NAME } from "./identity";
import { homeRelative } from "./paths";

export function remoteCachePath(
  upstream: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, PRODUCT_NAME, "remote", ...cloneRelativeSegments(upstream));
}

export interface RemoteCacheState {
  path: string;
  present: boolean;
}

export function remoteCacheState(
  upstream: string,
  env?: Record<string, string | undefined>,
): RemoteCacheState {
  const path = remoteCachePath(upstream, env);
  return { path, present: existsSync(join(path, ".git")) };
}

export interface EnsureRemoteCacheResult {
  path: string;
  cloned: boolean;
}

export async function ensureRemoteCache(
  cloneUrl: string,
  upstream: string,
  env?: Record<string, string | undefined>,
): Promise<EnsureRemoteCacheResult> {
  const path = remoteCachePath(upstream, env);
  const result = await ensureClone(cloneUrl, path, upstream, {
    subject: "remote skill cache path",
    partialClone: "the clone may be partial or corrupted.",
    repair: `remove the cache and retry:\n  rm -rf ${homeRelative(path)}`,
  });
  return { path, cloned: result.cloned };
}

export interface RemoteFetchResult {
  ok: boolean;
  stderr: string;
  head: string | null;
  ahead: number | null;
}

export async function fetchRemoteCache(
  cachePath: string,
  ref: string,
  since: string | null,
): Promise<RemoteFetchResult> {
  // A failed fetch is reported, never thrown: one unreachable repository must
  // not stop the check for every other row.
  const fetched = await fetchOrigin(cachePath, { prune: true });
  const head = await resolveCachedRef(cachePath, ref);
  return {
    ok: fetched.ok,
    stderr: fetched.stderr,
    head,
    ahead:
      head === null || since === null
        ? null
        : await countCommitsAhead(cachePath, since, head),
  };
}

/**
 * Remote-tracking refs come first: the clone's local branch never moves after
 * `git clone`, so it would answer with the install-time commit forever.
 */
export async function resolveCachedRef(
  cachePath: string,
  ref: string,
): Promise<string | null> {
  // Reject unsafe Git ref syntax here even when callers have already validated
  // it.
  if (!isSafeGitRef(ref)) return null;
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`]) {
    const resolved = await resolveCommit(cachePath, candidate);
    if (resolved !== null) return resolved;
  }
  // Bare name is tried last and never when it matches the clone's local branch:
  // `git clone` checks one out that never moves, so a branch deleted upstream
  // would still resolve. The fallback exists for raw commit ids.
  if ((await resolveCommit(cachePath, `refs/heads/${ref}`)) !== null) {
    return null;
  }
  return await resolveCommit(cachePath, ref);
}

export async function defaultCachedBranch(
  cachePath: string,
): Promise<string | null> {
  const result = await sourceRead(cachePath, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]);
  if (result.exitCode === 0) {
    const value = result.stdout.toString().trim();
    const short = value.replace(/^origin\//, "");
    if (short.length > 0) return short;
  }
  const local = await sourceRead(cachePath, [
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  if (local.exitCode !== 0) return null;
  return local.stdout.toString().trim() || null;
}

async function countCommitsAhead(
  repo: string,
  since: string,
  head: string,
): Promise<number | null> {
  const result = await sourceRead(repo, [
    "rev-list",
    "--count",
    `${since}..${head}`,
  ]);
  if (result.exitCode !== 0) return null;
  const count = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isFinite(count) ? count : null;
}
