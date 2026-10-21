import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isConfigObject } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { lstatOrNull } from "./fs-utils";

/**
 * Whether Claude Code has trusted a project's workspace (spec M8). Claude
 * Code loads a skills-dir plugin only in a trusted workspace, so a plugin
 * row needs this fact.
 */
export type ClaudeTrust = "trusted" | "untrusted" | "unknown";

export interface ClaudeTrustOptions {
  /** The directory that holds `.claude.json`. The default is the home directory. */
  home?: string;
  /** The environment to read `CLAUDE_CODE_SANDBOXED` from. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Reports the trust state for `project` the way Claude Code looks it up.
 * Read-only and synchronous: `~/.claude.json` is Claude Code's file, never
 * written here.
 *
 * Claude Code treats a sandboxed session (`CLAUDE_CODE_SANDBOXED`) as
 * trusted, so that reports `"trusted"` before any file is read. Otherwise a
 * missing, unreadable, or non-object file reports `"unknown"`: there is no
 * claim either way.
 *
 * The project is then trusted when one of these keys of `projects` has
 * `hasTrustDialogAccepted === true`, in this order: the resolved path, the
 * real path (a project reached through a symlink), the Git root (Claude Code
 * keys a project by its Git root), and each directory from the real path up
 * to the Git root. With no Git root, the walk goes up to the filesystem
 * root. Claude Code stops the walk at the Git root, so a trusted directory
 * above the repository does not trust a project inside it. No such key is
 * `"untrusted"`.
 */
export function claudeTrustFor(
  project: string,
  opts: ClaudeTrustOptions = {},
): ClaudeTrust {
  if (isSandboxed((opts.env ?? process.env).CLAUDE_CODE_SANDBOXED)) {
    return "trusted";
  }
  let parsed: ConfigValue;
  try {
    parsed = JSON.parse(
      readFileSync(join(opts.home ?? homedir(), ".claude.json"), "utf-8"),
    );
  } catch {
    return "unknown";
  }
  if (!isConfigObject(parsed)) return "unknown";
  const projects = isConfigObject(parsed.projects) ? parsed.projects : {};
  return trustKeys(project).some((key) => isAccepted(projects, key))
    ? "trusted"
    : "untrusted";
}

/** Set, and not a word that says "off". */
function isSandboxed(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

function isAccepted(projects: ConfigObject, key: string): boolean {
  if (!Object.hasOwn(projects, key)) return false;
  const entry = projects[key];
  return isConfigObject(entry) && entry.hasTrustDialogAccepted === true;
}

/** The `projects` keys Claude Code checks for `project`, in its order. */
function trustKeys(project: string): string[] {
  const resolved = resolve(project);
  const real = realPathOrNull(project) ?? resolved;
  const gitRoot = gitRootOf(real);
  const keys = [resolved, real, ...(gitRoot === null ? [] : [gitRoot])];
  let dir = real;
  for (;;) {
    keys.push(dir);
    if (dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return keys;
}

/**
 * The nearest directory at or above `start` that holds `.git` as a directory
 * or a file (a worktree or a submodule), or null. Claude Code finds the Git
 * root the same way, without running Git, and so does this: a status run
 * stays synchronous here. A symlinked `.git` ends the search with no root,
 * as it does in Claude Code.
 */
function gitRootOf(start: string): string | null {
  let dir = start;
  for (;;) {
    const info = lstatOrNullSafe(join(dir, ".git"));
    if (info !== null) {
      return info.isDirectory() || info.isFile() ? dir : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `lstatOrNull`, with any other error (no permission, say) read as absent. */
function lstatOrNullSafe(
  path: string,
): NonNullable<ReturnType<typeof lstatOrNull>> | null {
  try {
    return lstatOrNull(path) ?? null;
  } catch {
    return null;
  }
}

function realPathOrNull(project: string): string | null {
  try {
    return realpathSync(project);
  } catch {
    return null;
  }
}
