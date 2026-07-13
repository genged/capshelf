import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { parseJsonc } from "./json-fragments";

export type ClaudePluginScope = "managed" | "user" | "project" | "local";

export interface ExternalSkill {
  name: string;
  source: string;
}

export interface ExternalClaudePlugin {
  id: string;
  name: string;
  marketplace?: string;
  scope: ClaudePluginScope;
  enabled: boolean;
  settingsPath: string;
}

// skills-lock.json is written by skills.sh; validate only the shape we read
// and let Zod strip any other fields it carries (version, sourceType, …).
const SkillsShLockSchema = z.object({
  skills: z.record(z.object({ source: z.string().optional() })).optional(),
});

// Claude Code settings.json. enabledPlugins is narrowed structurally by
// parseEnabledPlugins below (it accepts both the array and object forms), so
// the schema only needs to assert the top level is an object.
const ClaudeSettingsSchema = z.object({
  enabledPlugins: z.unknown().optional(),
});

interface ClaudePluginSettingsPaths {
  managed?: string[];
  user?: string;
  project?: string;
  local?: string;
}

export async function listSkillsShSkills(
  project: string,
): Promise<ExternalSkill[]> {
  const path = join(project, "skills-lock.json");
  if (!existsSync(path)) return [];

  const parsed = SkillsShLockSchema.parse(
    JSON.parse(await readFile(path, "utf-8")),
  );
  return Object.entries(parsed.skills ?? {})
    .map(([name, entry]) => ({
      name,
      source: entry.source ?? "(unknown)",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillsShLock(project: string): Promise<Set<string>> {
  return new Set(
    (await listSkillsShSkills(project)).map((skill) => skill.name),
  );
}

export async function findSkillsShSkill(
  project: string,
  name: string,
): Promise<ExternalSkill | null> {
  return (
    (await listSkillsShSkills(project)).find((s) => s.name === name) ?? null
  );
}

export function skillsShConflictMessage(skill: ExternalSkill): string {
  return `managed by skills.sh${skill.source ? ` (${skill.source})` : ""}; use skills.sh remove ${skill.name} first`;
}

export async function listClaudePlugins(
  project: string,
  paths: ClaudePluginSettingsPaths = {},
): Promise<ExternalClaudePlugin[]> {
  const settingsPaths: Array<{ scope: ClaudePluginScope; path: string }> = [
    ...(paths.managed ?? defaultManagedClaudeSettingsPaths()).map((path) => ({
      scope: "managed" as const,
      path,
    })),
    {
      scope: "user",
      path: paths.user ?? join(homedir(), ".claude", "settings.json"),
    },
    {
      scope: "project",
      path: paths.project ?? join(project, ".claude", "settings.json"),
    },
    {
      scope: "local",
      path: paths.local ?? join(project, ".claude", "settings.local.json"),
    },
  ];

  const plugins: ExternalClaudePlugin[] = [];
  for (const settings of settingsPaths) {
    plugins.push(...(await readClaudePluginsFromSettings(settings)));
  }
  return plugins.sort(
    (a, b) =>
      scopeSort(a.scope) - scopeSort(b.scope) || a.id.localeCompare(b.id),
  );
}

export async function findClaudePlugin(
  project: string,
  nameOrId: string,
): Promise<ExternalClaudePlugin | null> {
  return (
    (await listClaudePlugins(project)).find(
      (plugin) => plugin.id === nameOrId || plugin.name === nameOrId,
    ) ?? null
  );
}

async function readClaudePluginsFromSettings(settings: {
  scope: ClaudePluginScope;
  path: string;
}): Promise<ExternalClaudePlugin[]> {
  if (!existsSync(settings.path)) return [];

  // settings.json is JSONC — parse tolerantly so a commented file (which Claude
  // Code accepts) doesn't crash status/plugin scanning.
  const parsed = ClaudeSettingsSchema.parse(
    parseJsonc(await readFile(settings.path, "utf-8")),
  );
  return parseEnabledPlugins(parsed.enabledPlugins).map(({ id, enabled }) => {
    const { name, marketplace } = splitPluginId(id);
    return {
      id,
      name,
      ...(marketplace !== undefined && { marketplace }),
      scope: settings.scope,
      enabled,
      settingsPath: settings.path,
    };
  });
}

function parseEnabledPlugins(
  value: unknown,
): Array<{ id: string; enabled: boolean }> {
  if (Array.isArray(value)) {
    return value
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => ({ id, enabled: true }));
  }

  if (!value || typeof value !== "object") return [];

  return Object.entries(value)
    .filter(([id, enabled]) => id.length > 0 && typeof enabled === "boolean")
    .map(([id, enabled]) => ({ id, enabled }));
}

function splitPluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return { name: id };
  return {
    name: id.slice(0, at),
    marketplace: id.slice(at + 1),
  };
}

function defaultManagedClaudeSettingsPaths(): string[] {
  if (process.platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  }
  if (process.platform === "win32") {
    return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

function scopeSort(scope: ClaudePluginScope): number {
  switch (scope) {
    case "managed":
      return 0;
    case "user":
      return 1;
    case "project":
      return 2;
    case "local":
      return 3;
  }
}
