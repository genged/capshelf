import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, PreconditionError } from "./errors";
import {
  cloneRepository,
  sourceRead,
  isGitWorkTreeRoot,
  normalizeRemoteUrl,
  originRemoteUrl,
} from "./git";
import { PRODUCT_NAME } from "./identity";
import { homeRelative, normalizePath } from "./paths";

/**
 * For `init`, a remote `--data` URL is bootstrap input only: it is cloned once,
 * and every later command uses the local writable clone.
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
  cwd?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
}

const REMOTE_URL_SCHEMES = /^(https?|ssh|git|file):\/\//i;
const SCP_LIKE_REMOTE = /^git@[^:/]+:.+/;

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

export function defaultClonePath(
  upstream: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, PRODUCT_NAME, "data", ...cloneRelativeSegments(upstream));
}

/**
 * Shared with the remote-skill cache so one upstream never lands in two
 * differently shaped paths.
 */
export function cloneRelativeSegments(upstream: string): string[] {
  const url = new URL(upstream);
  // Sanitize `:` from a non-default port so the segment is a plain directory
  // name.
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
  cloned: boolean;
}

/**
 * Wording travels as labels because the validator is shared with the
 * remote-skill cache but the repair advice differs.
 */
export interface ClonePathLabels {
  subject: string;
  repair: string;
  partialClone: string;
}

const DATA_REPO_CLONE_LABELS: ClonePathLabels = {
  subject: "data repo cache path",
  repair: `use an explicit local path with:\n  ${PRODUCT_NAME} init --data <local-path>`,
  partialClone:
    "the clone may be partial or corrupted; remove it and retry, or",
};

/** Never fetches or pulls: after bootstrap the clone is user-owned state. */
export async function ensureClone(
  url: string,
  clonePath: string,
  upstream: string,
  labels: Partial<ClonePathLabels> = {},
): Promise<EnsureCloneResult> {
  const { subject, repair, partialClone } = {
    ...DATA_REPO_CLONE_LABELS,
    ...labels,
  };
  if (await cloneTargetAbsent(clonePath)) {
    await mkdir(dirname(clonePath), { recursive: true });
    const clone = await cloneRepository(dirname(clonePath), url, clonePath);
    if (clone.exitCode !== 0) {
      throw new CliError(cloneFailedMessage(url, clone.stderr), {});
    }
    return { cloned: true };
  }

  if (!(await isGitWorkTreeRoot(clonePath))) {
    throw new PreconditionError(
      `${subject} already exists but is not a git working tree.\n\n` +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        repair,
    );
  }

  const origin = await originRemoteUrl(clonePath);
  const normalizedOrigin = origin
    ? normalizeRemoteUrl(origin, { allowFileUrls: true })
    : null;
  if (normalizedOrigin !== upstream) {
    const found = normalizedOrigin ?? origin?.trim() ?? "(no origin remote)";
    throw new PreconditionError(
      `${subject} already exists but points at a different upstream.\n\n` +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        "expected:\n" +
        `  ${upstream}\n\n` +
        "found:\n" +
        `  ${found}\n\n` +
        repair,
    );
  }

  // A killed clone can leave origin configured with no commit checked out.
  const head = await sourceRead(clonePath, ["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) {
    throw new PreconditionError(
      `${subject} already exists but has no usable HEAD commit.\n\n` +
        "path:\n" +
        `  ${homeRelative(clonePath)}\n\n` +
        `${partialClone}\n` +
        repair,
    );
  }

  return { cloned: false };
}

/** `git clone` accepts an existing empty directory, so it counts as absent. */
async function cloneTargetAbsent(clonePath: string): Promise<boolean> {
  if (!existsSync(clonePath)) return true;
  try {
    return (await readdir(clonePath)).length === 0;
  } catch {
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
