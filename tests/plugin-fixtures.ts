import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { ConfigObject, ConfigValue } from "../src/config-values";

/**
 * Duplicated from remote-fixtures because that file imports writePlugins from
 * here and importing back would create a cycle; keep byte-identical.
 */
function skillText(name: string, description: string, body = "body"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

export interface PluginSpec {
  dir: string;
  manifestName?: string;
  manifestSkills?: string | string[];
  manifestDescription?: string;
  skills: Array<{
    name: string;
    description: string;
    body?: string;
    extra?: Record<string, string>;
  }>;
  files?: Record<string, string>;
}

export async function writePlugins(
  repo: string,
  plugins: readonly PluginSpec[],
  catalogs: { claude?: ConfigValue; codex?: ConfigValue },
): Promise<void> {
  for (const plugin of plugins) {
    for (const skill of plugin.skills) {
      const skillDir = join(repo, plugin.dir, "skills", skill.name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        skillText(skill.name, skill.description, skill.body),
      );
      for (const [relPath, content] of Object.entries(skill.extra ?? {})) {
        await writeUnder(skillDir, relPath, content);
      }
    }
    if (plugin.manifestName !== undefined) {
      const manifestDir = join(repo, plugin.dir, ".claude-plugin");
      await mkdir(manifestDir, { recursive: true });
      const manifest: ConfigObject = { name: plugin.manifestName };
      if (plugin.manifestSkills !== undefined) {
        manifest.skills = plugin.manifestSkills;
      }
      if (plugin.manifestDescription !== undefined) {
        manifest.description = plugin.manifestDescription;
      }
      await writeFile(
        join(manifestDir, "plugin.json"),
        JSON.stringify(manifest),
      );
    }
    for (const [relPath, content] of Object.entries(plugin.files ?? {})) {
      await writeUnder(join(repo, plugin.dir), relPath, content);
    }
  }
  if (catalogs.claude !== undefined) {
    const dir = join(repo, ".claude-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "marketplace.json"),
      JSON.stringify(catalogs.claude),
    );
  }
  if (catalogs.codex !== undefined) {
    const dir = join(repo, ".agents", "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "marketplace.json"),
      JSON.stringify(catalogs.codex),
    );
  }
}

async function writeUnder(
  base: string,
  relPath: string,
  content: string,
): Promise<void> {
  const target = join(base, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/**
 * `metadata` is document-level because Claude Code reads metadata.pluginRoot
 * once per marketplace, not per plugin entry.
 */
export function claudeCatalog(
  entries: ReadonlyArray<{
    name: string;
    source: ConfigValue;
    skills?: ConfigValue;
  }>,
  metadata?: ConfigValue,
): ConfigValue {
  return {
    name: "fixture",
    owner: { name: "fixture" },
    ...(metadata !== undefined && { metadata }),
    plugins: entries.map((entry) => ({
      name: entry.name,
      source: entry.source,
      ...(entry.skills !== undefined && { skills: entry.skills }),
    })),
  };
}

export function codexCatalog(
  entries: ReadonlyArray<{ name: string; path?: string; source?: ConfigValue }>,
): ConfigValue {
  return {
    plugins: entries.map((entry) => ({
      name: entry.name,
      source:
        entry.source !== undefined
          ? entry.source
          : { source: "local", path: entry.path ?? null },
    })),
  };
}
