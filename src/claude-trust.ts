import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isConfigObject } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";

/**
 * Whether Claude Code has trusted a project's workspace (spec M8). Claude
 * Code loads a skills-dir plugin only in a trusted workspace, so a plugin
 * row needs this fact.
 */
export type ClaudeTrust = "trusted" | "untrusted" | "unknown";

/**
 * Reads `~/.claude.json`, read-only, and reports the trust state for
 * `project`. The file is Claude Code's, never written here.
 *
 * A missing, unreadable, or non-object file reports `"unknown"`: there is no
 * claim either way. Otherwise the project is looked up by its resolved path,
 * then by its real path (so a project reached through a symlink still
 * matches the entry Claude Code recorded). A found entry with
 * `hasTrustDialogAccepted === true` is `"trusted"`; a found entry with any
 * other value, or no entry at all, is `"untrusted"`.
 */
export function claudeTrustFor(
  project: string,
  home: string = homedir(),
): ClaudeTrust {
  let parsed: ConfigValue;
  try {
    parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  } catch {
    return "unknown";
  }
  if (!isConfigObject(parsed)) return "unknown";
  const projects = isConfigObject(parsed.projects) ? parsed.projects : {};
  const entry = projectEntry(projects, project);
  return isConfigObject(entry) && entry.hasTrustDialogAccepted === true
    ? "trusted"
    : "untrusted";
}

function projectEntry(
  projects: ConfigObject,
  project: string,
): ConfigValue | undefined {
  const resolved = resolve(project);
  if (Object.hasOwn(projects, resolved)) return projects[resolved];
  const real = realPathOrNull(project);
  return real !== null && Object.hasOwn(projects, real)
    ? projects[real]
    : undefined;
}

function realPathOrNull(project: string): string | null {
  try {
    return realpathSync(project);
  } catch {
    return null;
  }
}
