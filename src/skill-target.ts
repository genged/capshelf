/**
 * `skills/<n>` and `plugins/<n>` install into one folder, but
 * `assertNoScopeCollisions` compares lock keys and sees two unrelated items, so
 * this module checks ownership at the folder level.
 */
import { dirname, join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { PreconditionError } from "./errors";
import type { ExternalSkill } from "./external";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "./external";
import { PRODUCT_NAME } from "./identity";
import {
  claudeSkillPath,
  codexSkillPath,
  installedPath,
  parseLockKey,
} from "./installed";
import type { Lock } from "./lock";
import { installsAtSkillTarget } from "./master";
import type { SkillTargetKind } from "./master";
import { destinationKey } from "./pin";
import { parseRemoteKey } from "./remotes-lock";
import type { RemotesLock } from "./remotes-lock";

/**
 * Always fold case and Unicode normalization regardless of this machine's
 * filesystem: a project is shared across machines, so a pair that collides on
 * one must be refused everywhere.
 */
const ALL_FOLDING = { caseFolding: true, normalizationFolding: true } as const;

export interface SkillTargetLocks {
  project: Lock;
  local: Lock;
  remotes: RemotesLock;
}

/**
 * An owner equal to this key is the item's own folder, not a conflict; for
 * `move` it is the key in the scope being left, for `share --adopt` the remote
 * key being released.
 */
export interface SkillTargetSelf {
  key: string;
}

/**
 * `ignoreSkillsSh` is set only when adopting a remote skill, where skills.sh is
 * a legitimate previous owner. A plugin adopt leaves it unset, so a skills.sh
 * row of that name still counts as a second owner, because skills.sh never
 * installs plugins.
 */
export interface SkillTargetOptions {
  addCommand?: string;
  ignoreSkillsSh?: boolean;
}

type UnmanagedOwner = { owner: "unmanaged"; path: string };

export type SkillTargetOwner =
  | { owner: "project" | "local"; key: string }
  | { owner: "remote"; key: string }
  | { owner: "skills.sh"; name: string }
  | UnmanagedOwner;

export function skillTargetOwnerLabel(owner: SkillTargetOwner): string {
  switch (owner.owner) {
    case "project":
      return `${owner.key} (project scope)`;
    case "local":
      return `${owner.key} (local scope)`;
    case "remote":
      return owner.key;
    case "skills.sh":
      return "skills.sh";
    case "unmanaged":
      return owner.path;
  }
}

/**
 * The unmanaged-path scan runs even when a lock explains the name: a lock entry
 * for `rr` does not explain an unmanaged `.agents/skills/RR` on a
 * case-sensitive volume.
 */
export async function skillTargetOwners(
  project: string,
  name: string,
  locks: SkillTargetLocks,
): Promise<SkillTargetOwner[]> {
  const wanted = destinationKey(name, ALL_FOLDING);
  const owners: SkillTargetOwner[] = [];

  const managedNames: string[] = [];

  for (const [scope, lock] of [
    ["project", locks.project],
    ["local", locks.local],
  ] as const) {
    for (const key of Object.keys(lock.items)) {
      const parsed = parseLockKey(key);
      if (!installsAtSkillTarget(parsed.kind)) continue;
      if (destinationKey(parsed.name, ALL_FOLDING) !== wanted) continue;
      owners.push({ owner: scope, key });
      managedNames.push(parsed.name);
    }
  }

  for (const key of Object.keys(locks.remotes.items)) {
    const parsed = parseRemoteKey(key);
    if (destinationKey(parsed.name, ALL_FOLDING) !== wanted) continue;
    owners.push({ owner: "remote", key });
    managedNames.push(parsed.name);
  }

  for (const skill of await listSkillsShSkills(project)) {
    if (destinationKey(skill.name, ALL_FOLDING) !== wanted) continue;
    owners.push({ owner: "skills.sh", name: skill.name });
    managedNames.push(skill.name);
  }

  const managedDestinations = managedNames.flatMap((managed) => [
    codexSkillPath(project, managed),
    claudeSkillPath(project, managed),
  ]);
  for (const unmanaged of await unmanagedSkillTargetOwners(project, name)) {
    if (!(await isManagedDestination(unmanaged.path, managedDestinations))) {
      owners.push(unmanaged);
    }
  }

  return owners;
}

/**
 * Match by device and inode as well as path so the Claude alias symlink and
 * case-folding volumes, where `RR` and `rr` are one folder, count as managed.
 */
async function isManagedDestination(
  path: string,
  destinations: readonly string[],
): Promise<boolean> {
  if (destinations.includes(path)) return true;
  const info = await stat(path).catch(() => null);
  if (info === null) return false;
  for (const destination of destinations) {
    const other = await stat(destination).catch(() => null);
    if (other !== null && other.dev === info.dev && other.ino === info.ino) {
      return true;
    }
  }
  return false;
}

/**
 * On first install (`self === null`) an unmanaged owner at the exact
 * destination is left to the install path's pin-match rule, which adopts it
 * only when its content matches the pin and refuses otherwise. Entries that
 * only fold to the name still conflict.
 */
export async function assertSkillTargetFree(
  project: string,
  kind: SkillTargetKind,
  name: string,
  locks: SkillTargetLocks,
  self: SkillTargetSelf | null,
  options: SkillTargetOptions = {},
): Promise<void> {
  const ownDestinations = new Set([
    codexSkillPath(project, name),
    claudeSkillPath(project, name),
  ]);
  const owners = (await skillTargetOwners(project, name, locks)).filter(
    (owner) => {
      if (
        (owner.owner === "project" ||
          owner.owner === "local" ||
          owner.owner === "remote") &&
        owner.key === self?.key
      ) {
        return false;
      }
      if (
        self === null &&
        owner.owner === "unmanaged" &&
        ownDestinations.has(owner.path)
      ) {
        return false;
      }
      if (options.ignoreSkillsSh === true && owner.owner === "skills.sh") {
        return false;
      }
      return true;
    },
  );
  const first = owners[0];
  if (!first) return;
  const folder = relative(project, installedPath(project, kind, name));
  throw new PreconditionError(
    await skillTargetConflictMessage(
      project,
      folder,
      kind,
      name,
      first,
      options,
    ),
  );
}

async function skillTargetConflictMessage(
  project: string,
  folder: string,
  kind: SkillTargetKind,
  name: string,
  owner: SkillTargetOwner,
  options: SkillTargetOptions,
): Promise<string> {
  if (owner.owner === "skills.sh") {
    const external: ExternalSkill = (await findSkillsShSkill(
      project,
      owner.name,
    )) ?? { name: owner.name, source: "" };
    return [
      `${folder} is already installed by skills.sh`,
      `  ${skillsShConflictMessage(external)}`,
    ].join("\n");
  }
  if (owner.owner === "unmanaged") {
    return [
      `${folder} is already in use at ${owner.path}`,
      `  capshelf does not manage that path. Move or delete it, then install ${kind}/${name} again.`,
    ].join("\n");
  }
  return lockOwnerConflictMessage(folder, kind, name, owner, options);
}

/**
 * `<skill>` is a literal placeholder: only the plugin's own name is known here,
 * not the names of skills nested under it.
 */
function lockOwnerConflictMessage(
  folder: string,
  kind: SkillTargetKind,
  name: string,
  owner: { owner: "project" | "local" | "remote"; key: string },
  options: SkillTargetOptions,
): string {
  const ownerRef = skillTargetRefFromKey(owner.key);
  const ownerLabel = `${ownerRef.kind}/${ownerRef.name}`;
  const selfLabel = `${kind}/${name}`;
  const lines = [
    `${folder} is already installed by ${skillTargetOwnerLabel(owner)}`,
  ];
  if (ownerRef.kind === kind) {
    lines.push(`  remove one owner before installing ${selfLabel}`);
    return lines.join("\n");
  }
  lines.push(
    `  a project uses one of ${ownerLabel} and ${selfLabel}. To switch:`,
    `    ${PRODUCT_NAME} rm ${ownerLabel}`,
    `    ${options.addCommand ?? `${PRODUCT_NAME} add ${selfLabel}`}`,
    kind === "plugins"
      ? `  after the switch, Claude Code calls the skill ${name}:<skill> (was /${name})`
      : `  after the switch, Claude Code calls the skill /${name} (was ${name}:<skill>)`,
  );
  return lines.join("\n");
}

interface SkillTargetRef {
  kind: SkillTargetKind;
  name: string;
}

function skillTargetRefFromKey(key: string): SkillTargetRef {
  if (key.startsWith("remote/")) {
    const parsed = parseRemoteKey(key);
    return { kind: parsed.kind, name: parsed.name };
  }
  const parsed = parseLockKey(key);
  if (!installsAtSkillTarget(parsed.kind)) {
    throw new Error(`expected a skill-target lock key: ${key}`);
  }
  return { kind: parsed.kind, name: parsed.name };
}

/**
 * Match via `readdir` plus `destinationKey`, not `lstat` of the literal name,
 * so a committed `.agents/skills/RR` is found on filesystems that do not fold
 * case; every match is returned so an exact entry cannot hide a folded one.
 */
async function unmanagedSkillTargetOwners(
  project: string,
  name: string,
): Promise<UnmanagedOwner[]> {
  const wanted = destinationKey(name, ALL_FOLDING);
  const owners: UnmanagedOwner[] = [];
  for (const skillsDir of [
    dirname(codexSkillPath(project, name)),
    dirname(claudeSkillPath(project, name)),
  ]) {
    for (const entry of await foldedDirEntries(skillsDir, wanted)) {
      owners.push({ owner: "unmanaged", path: join(skillsDir, entry) });
    }
  }
  return owners;
}

async function foldedDirEntries(
  dir: string,
  wanted: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter(
    (entry) => destinationKey(entry, ALL_FOLDING) === wanted,
  );
}
