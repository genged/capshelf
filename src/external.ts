import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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

interface SkillsShEntry {
  source?: string;
}

interface SkillsShLock {
  skills?: Record<string, SkillsShEntry>;
}

interface ClaudeSettings {
  enabledPlugins?: unknown;
}

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

  const parsed = JSON.parse(await readFile(path, "utf-8")) as SkillsShLock;
  return Object.entries(parsed.skills ?? {})
    .map(([name, entry]) => ({
      name,
      source: entry.source ?? "(unknown)",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillsShLock(project: string): Promise<Set<string>> {
  return new Set((await listSkillsShSkills(project)).map((skill) => skill.name));
}

export async function findSkillsShSkill(
  project: string,
  name: string,
): Promise<ExternalSkill | null> {
  return (await listSkillsShSkills(project)).find((s) => s.name === name) ?? null;
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

  const parsed = JSON.parse(
    await readFile(settings.path, "utf-8"),
  ) as ClaudeSettings;
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
