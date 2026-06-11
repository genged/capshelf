import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, PreconditionError } from "./errors";
import {
  assertGitAvailable,
  isGitWorkTreeRoot,
  normalizeRemoteUrl,
  originRemoteUrl,
} from "./git";
import { PRODUCT_NAME } from "./identity";
import { homeRelative, normalizePath } from "./paths";

/**
 * Classification of the `--data` input for `init`. A remote data repo URL is
 * bootstrap input only: it is cloned to `clonePath` once and every later
 * command operates on that local clone (the runtime invariant stays "local,
 * writable git working tree").
 */
export type ResolvedDataInput =
  | { kind: "local-path"; path: string }
  | {
      kind: "remote-bootstrap";
      url: string;
      upstream: string;
      clonePath: string;
    };

export interface ResolveDataInputOptions {
  /** Base directory for relative local paths (defaults to process.cwd()). */
  cwd?: string;
  /** Explicit clone destination (`init --data-dir`) for remote bootstrap. */
  dataDir?: string;
  /** Environment override for tests (XDG_DATA_HOME lookup). */
  env?: Record<string, string | undefined>;
}

const REMOTE_URL_SCHEMES = /^(https?|ssh|git|file):\/\//i;
const SCP_LIKE_REMOTE = /^git@[^:/]+:.+/;

/**
 * True when the input is shaped like a git remote URL rather than a local
 * filesystem path. Shorthand such as `owner/repo` or `github:owner/repo` is
 * deliberately not matched; it is rejected by `resolveDataInput`.
 */
export function isRemoteDataUrl(input: string): boolean {
  const trimmed = input.trim();
  return SCP_LIKE_REMOTE.test(trimmed) || REMOTE_URL_SCHEMES.test(trimmed);
}

export function resolveDataInput(
  input: string,
  opts: ResolveDataInputOptions = {},
): ResolvedDataInput {
  const cwd = opts.cwd ?? process.cwd();
  const trimmed = input.trim();
  if (trimmed.length === 0) throw rejectDataInput(input);

  if (isRemoteDataUrl(trimmed)) {
    const upstream = normalizeRemoteUrl(trimmed, { allowFileUrls: true });
    if (!upstream) throw rejectDataInput(input);
    const clonePath = opts.dataDir
      ? normalizePath(opts.dataDir, cwd)
      : defaultClonePath(upstream, opts.env ?? process.env);
    return { kind: "remote-bootstrap", url: trimmed, upstream, clonePath };
  }

  if (
    hasExplicitPathPrefix(trimmed) ||
    existsSync(normalizePath(trimmed, cwd))
  ) {
    return { kind: "local-path", path: normalizePath(trimmed, cwd) };
  }

  throw rejectDataInput(input);
}

/**
 * Default bootstrap clone destination:
 *   $XDG_DATA_HOME/capshelf/data/<host>/<owner-path>/<repo>
 * falling back to ~/.local/share when XDG_DATA_HOME is unset. Derived from the
 * normalized remote identity, so credentials and one trailing `.git` are
 * already stripped.
 */
export function defaultClonePath(
  upstream: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, PRODUCT_NAME, "data", ...cloneRelativeSegments(upstream));
}

function cloneRelativeSegments(upstream: string): string[] {
  const url = new URL(upstream);
  // host keeps a non-default port; sanitize ":" so the cache segment is a
  // plain directory name (github.com:8443 -> github.com_8443).
  const host = (url.host.toLowerCase() || "localhost").replace(":", "_");
  const segments = url.pathname.split("/").filter(Boolean);
  return [host, ...segments];
}

function hasExplicitPathPrefix(input: string): boolean {
  if (input.startsWith("/") || input === "~" || input.startsWith("~/")) {
    return true;
  }
  return (
    input === "." ||
    input === ".." ||
    input.startsWith("./") ||
    input.startsWith("../")
  );
}

export interface EnsureCloneResult {
  /** True when a fresh clone was created; false when a matching clone existed. */
  cloned: boolean;
}

/**
 * Make sure `clonePath` holds a usable clone of `url`. Clones when the path is
 * absent; when it exists, verifies it is a git working tree whose `origin`
 * normalizes to `upstream`. Never fetches or pulls — after bootstrap the clone
 * is user-owned state.
 */
export async function ensureClone(
  url: string,
  clonePath: string,
  upstream: string,
): Promise<EnsureCloneResult> {
  await assertGitAvailable();

  if (await cloneTargetAbsent(clonePath)) {
    await mkdir(dirname(clonePath), { recursive: true });
    try {
      await $`git clone -- ${url} ${clonePath}`.quiet();
    } catch (err) {
      throw new CliError(cloneFailedMessage(url, cloneStderr(err)), {
        cause: err,
      });
    }
    return { cloned: true };
  }

  if (!(await isGitWorkTreeRoot(clonePath))) {
    throw new PreconditionError(
      "data repo cache path already exists but is not a git working tree.\n\n" +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        "use an explicit local path with:\n" +
        `  ${PRODUCT_NAME} init --data <local-path>`,
    );
  }

  const origin = await originRemoteUrl(clonePath);
  const normalizedOrigin = origin
    ? normalizeRemoteUrl(origin, { allowFileUrls: true })
    : null;
  if (normalizedOrigin !== upstream) {
    const found = normalizedOrigin ?? origin?.trim() ?? "(no origin remote)";
    throw new PreconditionError(
      "data repo cache path already exists but points at a different upstream.\n\n" +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        "expected:\n" +
        `  ${upstream}\n\n` +
        "found:\n" +
        `  ${found}\n\n` +
        "use an explicit local path with:\n" +
        `  ${PRODUCT_NAME} init --data <local-path>`,
    );
  }

  // Guard against a partial clone (e.g. a killed clone process): origin can
  // already be configured while no commit was ever checked out.
  try {
    await $`git -C ${clonePath} rev-parse --verify HEAD`.quiet();
  } catch (err) {
    throw new PreconditionError(
      "data repo cache path already exists but has no usable HEAD commit.\n\n" +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        "the clone may be partial or corrupted; remove it and retry, or\n" +
        "use an explicit local path with:\n" +
        `  ${PRODUCT_NAME} init --data <local-path>`,
      { cause: err },
    );
  }

  return { cloned: false };
}

/**
 * `git clone` accepts an existing empty directory, so treat one the same as
 * an absent path.
 */
async function cloneTargetAbsent(clonePath: string): Promise<boolean> {
  if (!existsSync(clonePath)) return true;
  try {
    return (await readdir(clonePath)).length === 0;
  } catch {
    // Not a directory: fall through to the existing-path validation, which
    // reports it as "not a git working tree".
    return false;
  }
}

function cloneFailedMessage(url: string, stderr: string): string {
  const reported = stderr.length > 0 ? stderr : "(no output)";
  const indented = reported
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return (
    "failed to clone data repo:\n" +
    `  ${url}\n\n` +
    "git reported:\n" +
    `${indented}\n\n` +
    "fix the URL, authenticate with Git, or clone manually and run:\n" +
    `  ${PRODUCT_NAME} init --data <local-path>`
  );
}

function cloneStderr(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (stderr instanceof Uint8Array) {
    return Buffer.from(stderr).toString("utf-8").trim();
  }
  if (typeof stderr === "string") return stderr.trim();
  return "";
}

function rejectDataInput(input: string): PreconditionError {
  return new PreconditionError(
    `data must be a local path or supported git remote URL: ${input}`,
    {
      hint:
        "shorthand like owner/repo or github:owner/repo is not supported; " +
        "pass a full remote data repo URL such as https://github.com/owner/repo, " +
        "git@github.com:owner/repo.git, or ssh://git@github.com/owner/repo.git",
    },
  );
}
