/**
 * The clone cache for skills pulled from repositories outside the shelf.
 *
 * `$XDG_DATA_HOME/capshelf/remote/<host>/<owner…>/<repo>`, beside the existing
 * `data/` bootstrap cache and built from the same segment rule. The path is
 * derived from the upstream on every read and is never stored: a recorded
 * absolute path would let stale machine state decide which objects a pin reads.
 *
 * Only `add <url>`, `add --list`, and `status --check-upstream` reach the
 * network through this module. `apply`, `update`, and `rm` read whatever the
 * cache already holds.
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
  /** False when the path holds no clone. */
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
  /** True when this call created the clone. */
  cloned: boolean;
}

/** Clone when absent, validate when present. Network on the clone path only. */
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
  /** HEAD of the ref after the fetch, or null when the ref does not resolve. */
  head: string | null;
  /** Commits the ref gained since `since`, or null when it is not computable. */
  ahead: number | null;
}

/** `git fetch origin` in the cache, then resolve `ref`. Network. */
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
 * Resolve `ref` in the cache without any network.
 *
 * Remote-tracking first: the cache clone's own local branch is whatever `git
 * clone` checked out and never moves again, so it would answer with the
 * install-time commit forever.
 */
export async function resolveCachedRef(
  cachePath: string,
  ref: string,
): Promise<string | null> {
  // Every ref reaching here came through the URL parser or the remotes-lock
  // schema, both of which refuse an option-shaped name. A ref that did not is
  // simply unresolvable, which is what the callers already handle.
  if (!isSafeGitRef(ref)) return null;
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`]) {
    const resolved = await resolveCommit(cachePath, candidate);
    if (resolved !== null) return resolved;
  }
  // The bare name last, and never when it would resolve the clone's own local
  // branch. `git clone` checks one out and it never moves again, so a branch
  // deleted upstream would keep resolving from it forever — reported as a
  // healthy ref, and pinned from by a later update. This fallback exists for a
  // raw commit id, which no local branch can shadow.
  if ((await resolveCommit(cachePath, `refs/heads/${ref}`)) !== null) {
    return null;
  }
  return await resolveCommit(cachePath, ref);
}

/** The cache clone's own default branch, which `git clone` took from origin. */
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
