import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NotFoundError, PreconditionError } from "./errors";
import { showAtCommit } from "./git";
import {
  canonicalSkillRef,
  collectSelectedSkill,
  validateMarketplaceName,
} from "./plugin-projection";
import { assertNoSymlinkAncestors } from "./path-safety";

const ownerSchema = z
  .object({ name: z.string().min(1), email: z.string().min(1).optional() })
  .passthrough();
const pluginSchema = z
  .object({
    name: z.string().min(1),
    source: z.unknown(),
    strict: z.unknown().optional(),
    skills: z.unknown().optional(),
  })
  .passthrough();
const marketplaceSchema = z
  .object({
    name: z.string().min(1),
    owner: ownerSchema,
    description: z.string().optional(),
    plugins: z.array(pluginSchema),
    renames: z.record(z.string(), z.string().nullable()).optional(),
  })
  .passthrough();

export type ClaudePlugin = z.infer<typeof pluginSchema>;
export type ClaudeMarketplace = z.infer<typeof marketplaceSchema>;

const COMPONENT_FIELDS = new Set([
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "lspServers",
]);

export function isManagedClaudePlugin(plugin: ClaudePlugin): boolean {
  if (
    plugin.source !== "./" ||
    plugin.strict !== false ||
    "version" in plugin ||
    [...COMPONENT_FIELDS].some((key) => key in plugin) ||
    !Array.isArray(plugin.skills) ||
    plugin.skills.length === 0
  ) {
    return false;
  }
  try {
    return plugin.skills.every(
      (skill) =>
        typeof skill === "string" &&
        skill.startsWith("./") &&
        skill === `./${canonicalSkillRef(skill.slice(2))}`,
    );
  } catch {
    return false;
  }
}

function isAttemptedManagedClaudePlugin(plugin: ClaudePlugin): boolean {
  return (
    plugin.source === "./" &&
    plugin.strict === false &&
    !("version" in plugin) &&
    ![...COMPONENT_FIELDS].some((key) => key in plugin)
  );
}

export function claudePluginSkills(plugin: ClaudePlugin): string[] {
  if (!isManagedClaudePlugin(plugin)) return [];
  return (plugin.skills as string[]).map((skill) => skill.slice(2));
}

export async function loadClaudeMarketplace(
  dataRepo: string,
): Promise<ClaudeMarketplace> {
  await assertNoSymlinkAncestors(dataRepo, ".claude-plugin/marketplace.json");
  const path = join(dataRepo, ".claude-plugin", "marketplace.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new NotFoundError("Claude marketplace is not initialized");
  }
  return parseClaudeMarketplace(raw);
}

export async function loadClaudeMarketplaceAtHead(
  dataRepo: string,
): Promise<ClaudeMarketplace> {
  let raw: Buffer;
  try {
    raw = await showAtCommit(
      dataRepo,
      "HEAD",
      ".claude-plugin/marketplace.json",
    );
  } catch {
    throw new NotFoundError("Claude marketplace is not initialized at HEAD");
  }
  return parseClaudeMarketplace(raw.toString("utf8"));
}

function parseClaudeMarketplace(raw: string): ClaudeMarketplace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PreconditionError(
      `invalid Claude marketplace JSON: ${String(error)}`,
    );
  }
  const result = marketplaceSchema.safeParse(parsed);
  if (!result.success) {
    throw new PreconditionError(
      `invalid Claude marketplace: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  validateMarketplaceName(result.data.name, "marketplace name", "claude");
  return result.data;
}

export function validateClaudeMarketplaceDocument(
  marketplace: ClaudeMarketplace,
): ClaudeMarketplace {
  return parseClaudeMarketplace(serializeClaudeMarketplace(marketplace));
}

export async function validateClaudeMarketplace(
  dataRepo: string,
  marketplace: ClaudeMarketplace,
): Promise<string[]> {
  const warnings: string[] = [];
  const names = new Set<string>();
  const memberships = new Map<string, string[]>();
  const managed = marketplace.plugins.some(isManagedClaudePlugin);
  if (managed) {
    try {
      const rootPlugin = await lstat(
        join(dataRepo, ".claude-plugin", "plugin.json"),
      );
      if (rootPlugin) {
        throw new PreconditionError(
          "root .claude-plugin/plugin.json conflicts with managed strict:false entries",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const plugin of marketplace.plugins) {
    validateMarketplaceName(plugin.name, "plugin name", "claude");
    if (names.has(plugin.name)) {
      throw new PreconditionError(`duplicate Claude plugin "${plugin.name}"`);
    }
    names.add(plugin.name);
    if (!isManagedClaudePlugin(plugin)) {
      if (isAttemptedManagedClaudePlugin(plugin)) {
        throw new PreconditionError(
          `managed Claude plugin "${plugin.name}" must have a non-empty array of canonical ./skills/<name> paths`,
        );
      }
      warnings.push(`external Claude plugin "${plugin.name}" was preserved`);
      continue;
    }
    for (const skill of claudePluginSkills(plugin)) {
      await collectSelectedSkill(dataRepo, skill);
      const plugins = memberships.get(skill) ?? [];
      plugins.push(plugin.name);
      memberships.set(skill, plugins);
    }
  }
  for (const [skill, plugins] of memberships) {
    if (plugins.length > 1) {
      warnings.push(
        `${skill} belongs to multiple Claude plugins: ${plugins.join(", ")}`,
      );
    }
  }
  validateRenames(marketplace, names);
  return warnings;
}

function validateRenames(
  marketplace: ClaudeMarketplace,
  current: Set<string>,
): void {
  const renames = marketplace.renames ?? {};
  for (const start of Object.keys(renames)) {
    const seen = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null && !current.has(cursor)) {
      if (seen.has(cursor)) {
        throw new PreconditionError(`Claude rename cycle at "${cursor}"`);
      }
      seen.add(cursor);
      if (!(cursor in renames)) {
        throw new PreconditionError(
          `Claude rename "${start}" has no current or retired destination`,
        );
      }
      cursor = renames[cursor] ?? null;
    }
  }
}

export function findClaudePlugin(
  marketplace: ClaudeMarketplace,
  name: string,
): ClaudePlugin {
  const plugin = marketplace.plugins.find((entry) => entry.name === name);
  if (!plugin) throw new NotFoundError(`Claude plugin "${name}" not found`);
  return plugin;
}

export function serializeClaudeMarketplace(
  marketplace: ClaudeMarketplace,
): string {
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}
