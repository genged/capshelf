import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { rm as fsRm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ItemKind } from "./master";
import type { Manifest } from "./manifest";
import { NotFoundError, PreconditionError } from "./errors";
import {
  claudeSkillPath,
  codexSkillPath,
  ensureInstallAliases,
  installedPath,
} from "./installed";
import { assertRepoClean, commitInRepo } from "./git";
import { replaceDirFromDir, replaceDirFromGitVisibleFiles } from "./sync";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import { runtimeWarningsForItem } from "./runtime-warnings";
import { privateDotenvFiles } from "./dotfiles";
import { isFragmentKind } from "./fragments";
import {
  expectedAdoptionPath,
  type AdoptOptions,
  type PromoteResult,
} from "./promote-core";
import { adoptionSnapshot } from "./item-snapshot";

interface AdoptionSource {
  path: string;
  kind: "installed" | "claude-real";
}

export async function adoptIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  opts: AdoptOptions,
): Promise<PromoteResult> {
  if (isFragmentKind(kind)) {
    throw new PreconditionError(
      `share for ${kind}/${name} requires --from <path> --to project`,
    );
  }
  if (kind === "skills") {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not adopting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const adoption = findAdoptionSource(project, kind, name, opts.installMode);
  if (!adoption) {
    throw new NotFoundError(
      `local item does not exist: ${expectedAdoptionPath(project, kind, name, opts.installMode)}`,
    );
  }

  const repoRelPath = `${kind}/${name}`;
  const dataPath = join(dataRepo, repoRelPath);
  if (existsSync(dataPath)) {
    throw new PreconditionError(
      `data repo item already exists: ${repoRelPath}`,
    );
  }

  if (kind === "skills") {
    assertCanNormalizeAdoptedSkill(project, name, adoption, opts.installMode);
  }
  await assertRepoClean(dataRepo);
  const adoptionRelPath = relative(project, adoption.path);
  const snapshot = await adoptionSnapshot(
    project,
    adoption.path,
    adoptionRelPath,
    opts.sourceScope ?? "project",
  );
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  if (snapshot.source === "filesystem") {
    await replaceDirFromDir(adoption.path, dataPath);
  } else {
    await replaceDirFromGitVisibleFiles(
      project,
      adoptionRelPath,
      adoption.path,
      dataPath,
    );
  }
  const sourceCommit = await commitInRepo(
    dataRepo,
    [repoRelPath],
    opts.message ?? `capshelf: ${kind}/${name}`,
  );

  if (kind === "skills") {
    await normalizeAdoptedSkill(project, name, adoption, opts.installMode);
  }
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "created",
    sha: snapshot.sha,
    sourceCommit,
    committed: true,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

function assertCanNormalizeAdoptedSkill(
  project: string,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
): void {
  if (mode !== "codex-compatible") return;
  if (adoption.kind === "claude-real") return;

  const managedPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new PreconditionError(
      `compatibility path already exists but is not a symlink: ${claudePath}`,
    );
  }

  const target = resolve(dirname(claudePath), readlinkSync(claudePath));
  if (resolve(target) !== resolve(managedPath)) {
    throw new PreconditionError(
      `compatibility symlink points somewhere else: ${claudePath} -> ${target}\n` +
        `  expected it to point at: ${managedPath}`,
    );
  }
}

function findAdoptionSource(
  project: string,
  kind: ItemKind,
  name: string,
  mode: Manifest["installMode"],
): AdoptionSource | null {
  if (kind === "mcp") {
    return existingItemDir(
      installedPath(project, kind, name, mode),
      "installed",
      kind,
    );
  }
  if (kind === "settings") return null;

  if (mode === "claude-only") {
    const path = claudeSkillPath(project, name);
    return existingItemDir(path, "installed", kind);
  }

  const codexPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const codex = existingItemDir(codexPath, "installed", kind);
  const claudeStat = lstatOrNull(claudePath);

  if (codex && claudeStat && !claudeStat.isSymbolicLink()) {
    throw new PreconditionError(
      `ambiguous local skill paths for skills/${name}: ${codexPath} and ${claudePath}\n` +
        "  remove one path or make .claude/skills point at .agents/skills before adopting",
    );
  }
  if (codex) return codex;

  if (claudeStat?.isSymbolicLink()) {
    return existingItemDir(
      installedPath(project, "skills", name, mode),
      "installed",
      kind,
    );
  }
  if (claudeStat) return existingItemDir(claudePath, "claude-real", kind);
  return null;
}

function existingItemDir(
  path: string,
  sourceKind: AdoptionSource["kind"],
  kind: ItemKind,
): AdoptionSource | null {
  const stat = lstatOrNull(path);
  if (!stat) return null;
  if (!stat.isDirectory()) {
    throw new PreconditionError(
      `local ${kind} path is not a directory: ${path}`,
    );
  }
  if (kind === "skills" && !existsSync(join(path, "SKILL.md"))) {
    throw new PreconditionError(`local skill is missing SKILL.md: ${path}`);
  }
  return { path, kind: sourceKind };
}

async function normalizeAdoptedSkill(
  project: string,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
): Promise<void> {
  if (mode !== "codex-compatible") return;

  if (adoption.kind === "claude-real") {
    const managedPath = codexSkillPath(project, name);
    const adoptionRelPath = relative(project, adoption.path);
    await replaceDirFromGitVisibleFiles(
      project,
      adoptionRelPath,
      adoption.path,
      managedPath,
    );
    await fsRm(adoption.path, { recursive: true, force: true });
  }
  await ensureInstallAliases(project, "skills", name, mode);
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}
