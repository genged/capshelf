import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isConfigObject } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { lstatOrNull } from "./fs-utils";

/**
 * Claude Code loads a skills-dir plugin only in a trusted workspace, so a
 * plugin row needs this fact.
 */
export type ClaudeTrust = "trusted" | "untrusted" | "unknown";

export interface ClaudeTrustOptions {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Mirrors Claude Code's lookup: sandboxed sessions count as trusted, and the
 * key walk stops at the Git root so a trusted directory above the repo does not
 * trust a project inside it.
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

function isSandboxed(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

function isAccepted(projects: ConfigObject, key: string): boolean {
  if (!Object.hasOwn(projects, key)) return false;
  const entry = projects[key];
  return isConfigObject(entry) && entry.hasTrustDialogAccepted === true;
}

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
 * Finds the Git root by walking for `.git` (dir or file) without running Git,
 * as Claude Code does, to stay synchronous; a symlinked `.git` ends the search.
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
