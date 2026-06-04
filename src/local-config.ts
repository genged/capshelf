import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { $ } from "bun";
import { LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE, METADATA_DIR } from "./identity";
import { expandTilde } from "./paths";
import { PreconditionError } from "./errors";
import type { ItemKind } from "./master";
import { gitInfoExcludePath, isGitWorkTreeRoot } from "./git";

const LocalConfigSchema = z.object({
  dataRepo: z.string().min(1),
  skills: z.array(z.string()).default([]),
  settings: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
});

export interface LocalConfig {
  dataRepo: string;
  skills: string[];
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
  const parsed = LocalConfigSchema.parse(
    JSON.parse(await readFile(path, "utf-8")),
  );
  return {
    dataRepo: expandTilde(parsed.dataRepo),
    skills: parsed.skills,
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
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
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
    await writeFile(path, `${entry}\n`);
    return;
  }

  const raw = await readFile(path, "utf-8");
  if (raw.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${raw}${separator}${entry}\n`);
}

export async function ensureLocalExcludes(
  project: string,
  skillName: string,
): Promise<void> {
  const excludePath = await gitInfoExcludePath(project);
  if (!excludePath) return;
  await assertLocalInstallPathsUntracked(project, skillName);
  const entries = [
    `.agents/skills/${skillName}/`,
    `.claude/skills/${skillName}`,
  ];

  await mkdir(dirname(excludePath), { recursive: true });
  const raw = existsSync(excludePath)
    ? await readFile(excludePath, "utf-8")
    : "";
  const existing = new Set(raw.split(/\r?\n/).map((line) => line.trim()));
  const additions = entries.filter((entry) => !existing.has(entry));
  if (additions.length === 0) return;
  const separator = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${raw}${separator}${additions.join("\n")}\n`);
}

export async function removeLocalExcludes(
  project: string,
  skillName: string,
): Promise<void> {
  const entries = new Set([
    `.agents/skills/${skillName}/`,
    `.claude/skills/${skillName}`,
  ]);
  const excludePath = join(project, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;

  const raw = await readFile(excludePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.filter((line) => !entries.has(line.trim()));
  if (nextLines.length === lines.length) return;
  await writeFile(excludePath, nextLines.join("\n"));
}

export async function assertLocalInstallPathsUntracked(
  project: string,
  skillName: string,
): Promise<void> {
  if (!(await isGitWorkTreeRoot(project))) return;
  for (const relPath of [
    `.agents/skills/${skillName}`,
    `.claude/skills/${skillName}`,
  ]) {
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
  if (kind === "skills") return;
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

async function trackedPathExists(
  repo: string,
  relPath: string,
): Promise<boolean> {
  try {
    const out = await $`git -C ${repo} ls-files -- ${relPath}`.quiet().text();
    return out.trim().length > 0;
  } catch (err) {
    const shellError = err as { exitCode?: number };
    if (shellError.exitCode !== undefined) return false;
    throw err;
  }
}
