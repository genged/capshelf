import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter } from "node:path";
import { join, resolve } from "node:path";
import type { ItemKind } from "./master";
import {
  claudeDir,
  codexProjectConfigDir,
  codexDir,
  homeRelative,
  personalClaudeSkillPath,
} from "./paths";

export type RuntimeWarningType =
  | "shadowed_by_personal_claude_skill"
  | "codex_project_untrusted";

export interface RuntimeWarning {
  type: RuntimeWarningType;
  path: string;
  message: string;
}

interface RuntimeWarningOptions {
  personalSkillPath?: string;
}

export function runtimeWarningsForItem(
  project: string,
  kind: ItemKind,
  name: string,
  opts: RuntimeWarningOptions = {},
): RuntimeWarning[] {
  if (kind !== "skills") return [];

  const personalPath = opts.personalSkillPath ?? personalClaudeSkillPath(name);
  if (!existsSync(personalPath)) return [];
  if (isProjectSkillPath(project, name, personalPath)) return [];

  return [
    {
      type: "shadowed_by_personal_claude_skill",
      path: personalPath,
      message: `Claude will load ${homeRelative(personalPath)} before this project skill.`,
    },
  ];
}

export function codexProjectTrustWarnings(project: string): RuntimeWarning[] {
  if (!commandExists("codex")) return [];
  const configPath = join(
    process.env.CODEX_HOME ?? joinHomeCodex(),
    "config.toml",
  );
  if (isCodexProjectTrusted(configPath, project)) return [];
  return [
    {
      type: "codex_project_untrusted",
      path: codexProjectConfigDir(project),
      message: `Codex may ignore ${homeRelative(join(codexProjectConfigDir(project), "config.toml"))} until this project is trusted.`,
    },
  ];
}

export function printRuntimeWarnings(
  warnings: RuntimeWarning[] = [],
  indent = "",
): void {
  for (const warning of warnings) {
    if (warning.type === "shadowed_by_personal_claude_skill") {
      console.log(
        `${indent}⚠ personal Claude skill shadows this project skill`,
      );
      console.log(`${indent}  ${warning.message}`);
    } else if (warning.type === "codex_project_untrusted") {
      console.log(`${indent}⚠ Codex project config may be ignored`);
      console.log(`${indent}  ${warning.message}`);
    }
  }
}

export function isStrictRuntimeWarning(warning: RuntimeWarning): boolean {
  return warning.type !== "codex_project_untrusted";
}

function isProjectSkillPath(
  project: string,
  name: string,
  personalPath: string,
): boolean {
  return [claudeDir(project), codexDir(project)]
    .map((root) => join(root, "skills", name))
    .some((candidate) => sameExistingPath(candidate, personalPath));
}

function sameExistingPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function commandExists(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

function joinHomeCodex(): string {
  return join(process.env.HOME ?? "", ".codex");
}

function isCodexProjectTrusted(configPath: string, project: string): boolean {
  if (!existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return false;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("projects" in parsed)
  ) {
    return false;
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (typeof projects !== "object" || projects === null) return false;
  const exact = (projects as Record<string, unknown>)[resolve(project)];
  if (typeof exact !== "object" || exact === null) return false;
  return (exact as { trust_level?: unknown }).trust_level === "trusted";
}
