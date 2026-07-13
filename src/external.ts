import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Lock } from "./lock";
import { parseLockKey } from "./installed";
import { parseJsonc } from "./json-fragments";

export type UserSkillSurface = "claude" | "codex";

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

export interface UserSkillShadow {
  scope: "project" | "local";
  source: "data" | "system";
}

export interface ExternalUserSkill {
  kind: "skills";
  name: string;
  surface: UserSkillSurface;
  path: string;
  shadows: UserSkillShadow[];
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

interface UserSkillRoot {
  surface: UserSkillSurface;
  path: string;
}

interface UserSkillPaths {
  roots?: UserSkillRoot[];
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

export async function listUserSkills(
  paths: UserSkillPaths = {},
): Promise<ExternalUserSkill[]> {
  const skills: ExternalUserSkill[] = [];
  const seenRoots = new Set<string>();
  for (const root of paths.roots ?? defaultUserSkillRoots()) {
    const rootKey = `${root.surface}\0${root.path}`;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    skills.push(...(await listUserSkillsInRoot(root)));
  }
  return skills.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      surfaceSort(a.surface) - surfaceSort(b.surface) ||
      a.path.localeCompare(b.path),
  );
}

export function withUserSkillShadows(
  skills: ExternalUserSkill[],
  projectLock: Lock,
  localLock: Lock,
): ExternalUserSkill[] {
  return skills.map((skill) => ({
    ...skill,
    shadows: userSkillShadows(skill.name, projectLock, localLock),
  }));
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

async function listUserSkillsInRoot(
  root: UserSkillRoot,
): Promise<ExternalUserSkill[]> {
  if (!existsSync(root.path)) return [];
  const entries = await readdir(root.path, { withFileTypes: true });
  const skills: ExternalUserSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = join(root.path, entry.name);
    const skillFile = join(skillPath, "SKILL.md");
    if (!(await isFile(skillFile))) continue;
    skills.push({
      kind: "skills",
      name: entry.name,
      surface: root.surface,
      path: skillPath,
      shadows: [],
    });
  }
  return skills;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function userSkillShadows(
  name: string,
  projectLock: Lock,
  localLock: Lock,
): UserSkillShadow[] {
  return [
    ...skillShadowsInLock(name, "project", projectLock),
    ...skillShadowsInLock(name, "local", localLock),
  ];
}

function skillShadowsInLock(
  name: string,
  scope: UserSkillShadow["scope"],
  lock: Lock,
): UserSkillShadow[] {
  const shadows: UserSkillShadow[] = [];
  for (const key of Object.keys(lock.items)) {
    const parsed = parseLockKey(key);
    if (parsed.kind !== "skills" || parsed.name !== name) continue;
    shadows.push({ scope, source: parsed.source });
  }
  return shadows;
}

function defaultUserSkillRoots(): UserSkillRoot[] {
  return [
    { surface: "claude", path: join(homedir(), ".claude", "skills") },
    { surface: "codex", path: join(homedir(), ".agents", "skills") },
    {
      surface: "codex",
      path: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills"),
    },
  ];
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

function surfaceSort(surface: UserSkillSurface): number {
  switch (surface) {
    case "claude":
      return 0;
    case "codex":
      return 1;
  }
}
