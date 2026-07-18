import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE, METADATA_DIR } from "./identity";
import { expandTilde } from "./paths";
import { atomicWriteFile } from "./fs-utils";
import { hasShelvesKey } from "./manifest";
import { PreconditionError } from "./errors";
import { isCopyItemKind, type ItemKind } from "./master";
import { gitInfoExcludePath, gitTry, isGitWorkTreeRoot } from "./git";

const LocalConfigSchema = z.object({
  dataRepo: z.string().min(1),
  skills: z.array(z.string()).default([]),
  piExtensions: z.array(z.string()).default([]),
  settings: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
});

export interface LocalConfig {
  dataRepo: string;
  skills: string[];
  piExtensions: string[];
  settings: string[];
  mcp: string[];
}

export function localConfigPath(project: string): string {
  return join(project, METADATA_DIR, LOCAL_CONFIG_FILE);
}

export async function loadLocalConfig(
  project: string,
): Promise<LocalConfig | null> {
  const path = localConfigPath(project);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(await readFile(path, "utf-8"));
  // "shelves" is reserved for multi-shelf federation. Fail loudly before zod
  // strips it and a later saveLocalConfig silently deletes it. See
  // local/specs/multi-shelf-federation-spec.md, Compatibility Reservations,
  // Group 2(b).
  if (hasShelvesKey(raw)) {
    throw new Error(
      `${path} declares "shelves": this project uses multi-shelf federation, which this capshelf version does not support; upgrade capshelf`,
    );
  }
  const parsed = LocalConfigSchema.parse(raw);
  return {
    dataRepo: expandTilde(parsed.dataRepo),
    skills: parsed.skills,
    piExtensions: parsed.piExtensions,
    settings: parsed.settings,
    mcp: parsed.mcp,
  };
}

export async function saveLocalConfig(
  project: string,
  cfg: LocalConfig,
): Promise<void> {
  const path = localConfigPath(project);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  await ensureGitignored(project, LOCAL_CONFIG_FILE);
  await ensureGitignored(project, LOCAL_LOCK_FILE);
}

export async function ensureGitignored(
  project: string,
  entry: string,
): Promise<void> {
  const path = join(project, METADATA_DIR, ".gitignore");
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    await atomicWriteFile(path, `${entry}\n`);
    return;
  }

  const raw = await readFile(path, "utf-8");
  if (raw.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await atomicWriteFile(path, `${raw}${separator}${entry}\n`);
}

export function localConfigNamesForKind(
  config: LocalConfig,
  kind: ItemKind,
): string[] {
  switch (kind) {
    case "skills":
      return config.skills;
    case "pi-extensions":
      return config.piExtensions;
    case "settings":
    case "mcp":
    case "codex-config":
      throw new Error(`local intent is not supported for ${kind}`);
  }
}

export function addLocalConfigName(
  config: LocalConfig,
  kind: ItemKind,
  name: string,
): void {
  const names = localConfigNamesForKind(config, kind);
  if (!names.includes(name)) names.push(name);
}

export function removeLocalConfigName(
  config: LocalConfig,
  kind: ItemKind,
  name: string,
): void {
  const names = localConfigNamesForKind(config, kind);
  const index = names.indexOf(name);
  if (index !== -1) names.splice(index, 1);
}

export async function ensureLocalExcludes(
  project: string,
  kind: ItemKind,
  name: string,
): Promise<void> {
  const excludePath = await gitInfoExcludePath(project);
  if (!excludePath) return;
  await assertLocalInstallPathsUntracked(project, kind, name);
  const entries = localInstallPaths(kind, name, true);

  await mkdir(dirname(excludePath), { recursive: true });
  const raw = existsSync(excludePath)
    ? await readFile(excludePath, "utf-8")
    : "";
  const existing = new Set(raw.split(/\r?\n/).map((line) => line.trim()));
  const additions = entries.filter((entry) => !existing.has(entry));
  if (additions.length === 0) return;
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await atomicWriteFile(
    excludePath,
    `${raw}${separator}${additions.join("\n")}\n`,
  );
}

export async function removeLocalExcludes(
  project: string,
  kind: ItemKind,
  name: string,
): Promise<void> {
  const entries = new Set(localInstallPaths(kind, name, true));
  const excludePath = join(project, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;

  const raw = await readFile(excludePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.filter((line) => !entries.has(line.trim()));
  if (nextLines.length === lines.length) return;
  await atomicWriteFile(excludePath, nextLines.join("\n"));
}

export async function assertLocalInstallPathsUntracked(
  project: string,
  kind: ItemKind,
  name: string,
): Promise<void> {
  if (!(await isGitWorkTreeRoot(project))) return;
  for (const relPath of localInstallPaths(kind, name, false)) {
    const tracked = await trackedPathExists(project, relPath);
    if (tracked) {
      throw new PreconditionError(
        `local install path is already tracked by git: ${relPath}`,
        {
          hint: ".git/info/exclude cannot protect tracked files; remove it from git or use project scope",
        },
      );
    }
  }
}

export function assertLocalScopeSupported(
  kind: ItemKind,
  _name: string,
  verb: string,
  mcpMessage = "local scope is not supported for mcp fragments; keep project-local values in .mcp.json or .codex/config.toml",
): void {
  if (isCopyItemKind(kind)) return;
  if (kind === "settings") {
    throw new PreconditionError(
      `${verb} is not supported for settings fragments; keep project-local values in .claude/settings.json`,
    );
  }
  if (kind === "mcp") {
    throw new PreconditionError(mcpMessage);
  }
  throw new PreconditionError(
    `${verb} is not supported for codex-config fragments; keep project-local values in .codex/config.toml`,
  );
}

function localInstallPaths(
  kind: ItemKind,
  name: string,
  directorySuffix: boolean,
): string[] {
  const suffix = directorySuffix ? "/" : "";
  switch (kind) {
    case "skills":
      return [`.agents/skills/${name}${suffix}`, `.claude/skills/${name}`];
    case "pi-extensions":
      return [`.pi/extensions/${name}${suffix}`];
    case "settings":
    case "mcp":
    case "codex-config":
      throw new Error(`local install paths are not supported for ${kind}`);
  }
}

async function trackedPathExists(
  repo: string,
  relPath: string,
): Promise<boolean> {
  const r = await gitTry(repo, ["ls-files", "--", relPath]);
  if (r.exitCode !== 0) return false;
  return r.stdout.toString().trim().length > 0;
}
