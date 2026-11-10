import { existsSync, readlinkSync } from "node:fs";
import { assertSafeItemName, assertNever } from "./assert";
import { ensureDir, lstatOrNull } from "./fs-utils";
import { rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { PreconditionError } from "./errors";
import { assertConfinedSync, resolveThroughExistingSync } from "./path-safety";
import {
  ITEM_KINDS,
  installsAtSkillTarget,
  isItemKind,
  isMaterializedItemKind,
  itemRepoRelPath,
  type ItemKind,
  type MaterializedItemKind,
  type SkillTargetKind,
  shaOfItem,
} from "./master";
import {
  claudeDir,
  codexProjectConfigDir,
  codexDir,
  detectInstallMode,
  installBaseDir,
  piDir,
} from "./paths";
import type { InstallMode } from "./paths";

export interface ItemOutputTarget {
  id: string;
  canonicalRelPath: string;
  outputPath: string;
}

export function itemOutputTargets(
  project: string,
  kind: MaterializedItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): ItemOutputTarget[] {
  const targets = unconfinedItemOutputTargets(project, kind, name, mode);
  // Every builder result is confined before a caller can mutate it.
  for (const target of targets) assertConfinedSync(project, target.outputPath);
  return targets;
}

function unconfinedItemOutputTargets(
  project: string,
  kind: MaterializedItemKind,
  name: string,
  mode: InstallMode,
): ItemOutputTarget[] {
  switch (kind) {
    case "skills":
    case "plugins":
      return [
        {
          id: "directory",
          canonicalRelPath: itemRepoRelPath(kind, name),
          outputPath: skillInstalledPath(project, kind, name, mode),
        },
      ];
    case "pi-extensions":
      return [
        {
          id: "directory",
          canonicalRelPath: itemRepoRelPath(kind, name),
          outputPath: join(piDir(project), "extensions", name),
        },
      ];
    case "subagents":
      return [
        {
          id: "claude",
          canonicalRelPath: `subagents/${name}/claude.md`,
          outputPath: join(claudeDir(project), "agents", `${name}.md`),
        },
        {
          id: "codex",
          canonicalRelPath: `subagents/${name}/codex.toml`,
          outputPath: join(
            codexProjectConfigDir(project),
            "agents",
            `${name}.toml`,
          ),
        },
      ];
    default:
      return assertNever(kind);
  }
}

export function installedPath(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): string {
  let dst: string;
  if (isMaterializedItemKind(kind)) {
    const targets = itemOutputTargets(project, kind, name, mode);
    if (targets.length !== 1) {
      throw new Error(
        `${kind}/${name} owns ${targets.length} output targets; select a target explicitly`,
      );
    }
    dst = targets[0]!.outputPath;
  } else {
    switch (kind) {
      case "settings":
        dst = join(claudeDir(project), "settings.json");
        break;
      case "mcp":
        dst = join(project, ".mcp.json");
        break;
      case "codex-config":
        dst = join(codexProjectConfigDir(project), "config.toml");
        break;
      default:
        return assertNever(kind);
    }
  }
  // Root invariant: an install destination is always inside the project, and
  // so is every real path it resolves to. Every destructive caller
  // (materialize/sync rm+rewrite) trusts this path, so a path that escapes —
  // via a `..`/absolute item name or a symlinked parent — must never be
  // returned. This backstops the per-boundary name validation rather than
  // relying on it alone.
  assertConfinedSync(project, dst);
  return dst;
}

export function claudeSkillPath(project: string, name: string): string {
  return join(claudeDir(project), "skills", name);
}

export function codexSkillPath(project: string, name: string): string {
  return join(codexDir(project), "skills", name);
}

export function findInstallConflict(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): string | null {
  if (isMaterializedItemKind(kind)) {
    for (const target of itemOutputTargets(project, kind, name, mode)) {
      if (pathExists(target.outputPath)) return target.outputPath;
    }
  } else {
    const dst = installedPath(project, kind, name, mode);
    if (pathExists(dst)) return dst;
  }

  if (installsAtSkillTarget(kind) && mode === "codex-compatible") {
    const claudePath = claudeSkillPath(project, name);
    if (pathExists(claudePath)) return claudePath;
  }

  return null;
}

export function assertCanMaterializeInstalled(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): void {
  if (!installsAtSkillTarget(kind) || mode !== "codex-compatible") return;

  const claudePath = claudeSkillPath(project, name);
  assertConfinedSync(project, dirname(claudePath));
  const stat = lstatOrNull(claudePath);
  if (!stat || stat.isSymbolicLink()) return;

  throw new Error(
    `compatibility path already exists but is not a symlink: ${claudePath}`,
  );
}

export async function ensureInstallAliases(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): Promise<void> {
  if (!installsAtSkillTarget(kind) || mode !== "codex-compatible") return;

  const dst = installedPath(project, kind, name, mode);
  const claudePath = claudeSkillPath(project, name);
  // The alias folder must resolve inside the project. The link target is
  // computed from the physical folder, because the OS resolves a relative
  // link from there, not from the path as written.
  const physicalParent = assertConfinedSync(project, dirname(claudePath));
  const physicalDst = assertConfinedSync(project, dst);
  const stat = lstatOrNull(claudePath);

  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `compatibility path already exists but is not a symlink: ${claudePath}`,
      );
    }
    const existingTarget = physicalAliasTarget(physicalParent, claudePath);
    if (samePath(existingTarget, physicalDst)) return;
    throw new Error(
      `compatibility symlink points somewhere else: ${claudePath} -> ${existingTarget}`,
    );
  }

  await ensureDir(dirname(claudePath), { root: project });
  await symlink(relative(physicalParent, physicalDst), claudePath, "dir");
}

export async function removeInstallAliases(
  project: string,
  kind: ItemKind,
  name: string,
  managedPath: string,
  mode: InstallMode = detectInstallMode(project),
): Promise<boolean> {
  if (!installsAtSkillTarget(kind) || mode !== "codex-compatible") return false;

  const claudePath = claudeSkillPath(project, name);
  // Confine the folder, not the link: a dangling alias is still ours to remove.
  const physicalParent = assertConfinedSync(project, dirname(claudePath));
  const stat = lstatOrNull(claudePath);
  if (!stat?.isSymbolicLink()) return false;

  const target = physicalAliasTarget(physicalParent, claudePath);
  if (samePath(target, assertConfinedSync(project, managedPath))) {
    await rm(claudePath, { force: true });
    return true;
  }
  return false;
}

export function isInstalled(
  project: string,
  kind: ItemKind,
  name: string,
): boolean {
  return existsSync(installedPath(project, kind, name));
}

/**
 * PIN-5: the installed content hash is filesystem work, full stop.
 *
 * It used to branch on whether the project was a Git worktree and hash the
 * Git-visible file list when it was — so an edit to the project's
 * `.gitignore` could move an item's computed state, and a `--local` item, put
 * in `.git/info/exclude` by capshelf itself, hashed as if it were empty.
 */
export async function shaOfInstalled(
  project: string,
  kind: ItemKind,
  name: string,
): Promise<string | null> {
  const p = installedPath(project, kind, name);
  if (!existsSync(p)) return null;
  return shaOfItem(p);
}

/**
 * Which record owns an item, not where its bytes come from. Those were one
 * question until a third population separated them; `ContentSource` in
 * `src/item-source.ts` answers the other. A value here is a lock key prefix
 * and nothing more.
 */
export type ItemSource = "data" | "system";

export interface LockKeyParts {
  source: ItemSource;
  kind: ItemKind;
  name: string;
}

export function parseLockKey(key: string): LockKeyParts {
  const parts = key.split("/");
  if (parts.length < 3) {
    throw new Error(`invalid lock key: ${key} (expected source/kind/name)`);
  }
  const [source, kind, ...nameParts] = parts;
  if (source !== "data" && source !== "system") {
    throw new Error(`invalid lock key source: ${source}`);
  }
  if (!kind || !isItemKind(kind)) {
    throw new Error(
      `unsupported lock key kind: ${kind ?? "(missing)"} (supported: ${ITEM_KINDS.join(", ")})`,
    );
  }
  const name = nameParts.join("/");
  assertSafeItemName(name, `lock key ${key}`);
  return {
    source,
    kind,
    name,
  };
}

function skillInstalledPath(
  project: string,
  kind: SkillTargetKind,
  name: string,
  mode: InstallMode,
): string {
  const canonical = join(installBaseDir(project, mode), "skills", name);
  const claudePath = claudeSkillPath(project, name);
  const physicalParent = assertConfinedSync(project, dirname(claudePath));
  const stat = lstatOrNull(claudePath);
  if (stat?.isSymbolicLink()) {
    const symlinkTarget = physicalAliasTarget(physicalParent, claudePath);
    // The compatibility alias must resolve to the managed skill location.
    // Materialize/sync delete-and-rewrite whatever path this returns, so
    // following a stray or hostile symlink that points elsewhere would let it
    // wipe an arbitrary directory. Refuse instead of following it.
    if (!samePath(symlinkTarget, assertConfinedSync(project, canonical))) {
      // A link that leaves the project is refused first, with exit 3.
      try {
        assertConfinedSync(project, claudePath);
      } catch (error) {
        if (!(error instanceof PreconditionError)) throw error;
        throw new PreconditionError(
          `compatibility symlink for ${kind}/${name} resolves outside the managed skills dir: ${claudePath} -> ${symlinkTarget}\n  ${error.message}`,
          { cause: error, hint: error.hint },
        );
      }
      const codexPath = codexSkillPath(project, name);
      if (
        mode === "codex-compatible" &&
        pathExists(codexPath) &&
        !samePath(codexPath, symlinkTarget)
      ) {
        throw new Error(
          `ambiguous skill install paths for ${kind}/${name}: ${codexPath} and ${claudePath} -> ${symlinkTarget}`,
        );
      }
      throw new Error(
        `compatibility symlink for ${kind}/${name} resolves outside the managed skills dir: ${claudePath} -> ${symlinkTarget}`,
      );
    }
    return canonical;
  }

  return canonical;
}

/**
 * Where an alias points, as a real path. `resolve` alone only normalizes the
 * link text. It does not follow a symlink inside the target, so it cannot be
 * compared with `assertConfinedSync`, which returns real paths. A dangling
 * target keeps its missing tail, so a managed dangling alias still matches.
 */
function physicalAliasTarget(
  physicalParent: string,
  claudePath: string,
): string {
  return resolveThroughExistingSync(
    resolve(physicalParent, readlinkSync(claudePath)),
  );
}

function pathExists(path: string): boolean {
  return lstatOrNull(path) !== null;
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
