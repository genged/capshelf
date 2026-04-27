import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ItemKind } from "./master";
import {
  claudeDir,
  codexDir,
  homeRelative,
  personalClaudeSkillPath,
} from "./paths";

export type RuntimeWarningType = "shadowed_by_personal_claude_skill";

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

export function printRuntimeWarnings(
  warnings: RuntimeWarning[] = [],
  indent = "",
): void {
  for (const warning of warnings) {
    if (warning.type === "shadowed_by_personal_claude_skill") {
      console.log(`${indent}⚠ personal Claude skill shadows this project skill`);
      console.log(`${indent}  ${warning.message}`);
    }
  }
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
