import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter } from "node:path";
import { join, resolve } from "node:path";
import { z } from "zod";
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
  | "codex_project_untrusted"
  | "pi_extension_executes_code"
  | "pi_extension_dependencies_not_installed";

export interface RuntimeWarning {
  type: RuntimeWarningType;
  path: string;
  message: string;
}

interface RuntimeWarningOptions {
  personalSkillPath?: string;
  /** Content root to inspect instead of the installed extension directory. */
  itemPath?: string;
}

const PiExtensionPackageSchema = z.object({
  dependencies: z.record(z.unknown()).optional(),
});

export function runtimeWarningsForItem(
  project: string,
  kind: ItemKind,
  name: string,
  opts: RuntimeWarningOptions = {},
): RuntimeWarning[] {
  if (kind === "pi-extensions") {
    return piExtensionWarnings(
      name,
      opts.itemPath ?? join(project, ".pi", "extensions", name),
    );
  }
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

export function formatRuntimeWarnings(
  warnings: RuntimeWarning[] = [],
  indent = "",
): string[] {
  const lines: string[] = [];
  for (const warning of warnings) {
    if (warning.type === "shadowed_by_personal_claude_skill") {
      lines.push(`${indent}⚠ personal Claude skill shadows this project skill`);
      lines.push(`${indent}  ${warning.message}`);
    } else if (warning.type === "codex_project_untrusted") {
      lines.push(`${indent}⚠ Codex project config may be ignored`);
      lines.push(`${indent}  ${warning.message}`);
    } else if (warning.type === "pi_extension_executes_code") {
      lines.push(
        `${indent}warning: Pi extensions execute arbitrary code after this project is trusted by Pi.`,
      );
      lines.push(
        `${indent}review this extension before running /reload or starting pi in this project.`,
      );
    } else if (warning.type === "pi_extension_dependencies_not_installed") {
      lines.push(
        `${indent}warning: pi extension declares package dependencies; capshelf does not install them. Pi may fail to load this extension until dependencies are installed manually or the extension is packaged for Pi.`,
      );
    }
  }
  return lines;
}

export function printRuntimeWarnings(
  warnings: RuntimeWarning[] = [],
  indent = "",
): void {
  for (const line of formatRuntimeWarnings(warnings, indent)) {
    console.log(line);
  }
}

export function isStrictRuntimeWarning(warning: RuntimeWarning): boolean {
  return (
    warning.type !== "codex_project_untrusted" &&
    warning.type !== "pi_extension_executes_code" &&
    warning.type !== "pi_extension_dependencies_not_installed"
  );
}

function piExtensionWarnings(name: string, itemPath: string): RuntimeWarning[] {
  const path = `.pi/extensions/${name}`;
  const warnings: RuntimeWarning[] = [
    {
      type: "pi_extension_executes_code",
      path,
      message: "Pi extensions execute arbitrary code after project trust.",
    },
  ];
  if (declaresPackageDependencies(join(itemPath, "package.json"))) {
    warnings.push({
      type: "pi_extension_dependencies_not_installed",
      path,
      message:
        "Pi extension declares package dependencies; capshelf does not install them.",
    });
  }
  return warnings;
}

function declaresPackageDependencies(packagePath: string): boolean {
  if (!existsSync(packagePath)) return false;
  try {
    const parsed = PiExtensionPackageSchema.safeParse(
      JSON.parse(readFileSync(packagePath, "utf-8")),
    );
    return (
      parsed.success &&
      parsed.data.dependencies !== undefined &&
      Object.keys(parsed.data.dependencies).length > 0
    );
  } catch {
    return false;
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
