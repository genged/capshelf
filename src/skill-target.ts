/**
 * Ownership of the install folder two item kinds share (spec D2).
 *
 * `skills/<n>` and `plugins/<n>` both install into one folder —
 * `.agents/skills/<n>` in codex-compatible mode, `.claude/skills/<n>` in
 * claude-only mode (`installsAtSkillTarget`, `src/master.ts`). The shelf may
 * hold both forms of one name; a project may hold only one. The existing
 * collision check, `assertNoScopeCollisions` (`src/status-core.ts`), compares
 * lock *keys*, so `data/skills/<n>` and `data/plugins/<n>` look like two
 * unrelated items to it even though they are one folder on disk.
 *
 * This module is the folder-level check (spec D2 guard 5). `skillTargetOwners`
 * finds every owner of a skill-target folder: a project-lock or local-lock
 * entry, a remote row, a skills.sh row, or an unmanaged path. `assertSkillTargetFree`
 * refuses a write that would create, replace, or delete that folder while
 * another owner holds it.
 */
import { readlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PreconditionError } from "./errors";
import type { ExternalSkill } from "./external";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "./external";
import { lstatOrNull } from "./fs-utils";
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
 * Always fold case and Unicode normalization, whatever the filesystem of the
 * machine running this check: a project is shared across machines, so a pair
 * that collides on one machine's filesystem must be refused on every one.
 */
const ALL_FOLDING = { caseFolding: true, normalizationFolding: true } as const;

export interface SkillTargetLocks {
  project: Lock;
  local: Lock;
  remotes: RemotesLock;
}

/**
 * The item's own lock key in the scope being written. For `move`, this is the
 * key in the scope the item is leaving: an owner equal to it is the item's own
 * folder, not a conflict, and `assertSkillTargetFree` drops it before it
 * refuses on the first owner left.
 */
export interface SkillTargetSelf {
  key: string;
}

export type SkillTargetOwner =
  | { owner: "lock"; key: string }
  | { owner: "skills.sh"; name: string }
  | { owner: "unmanaged"; path: string };

/** A short label for an owner, for a message that only needs to name it. */
export function skillTargetOwnerLabel(owner: SkillTargetOwner): string {
  switch (owner.owner) {
    case "lock":
      return owner.key;
    case "skills.sh":
      return "skills.sh";
    case "unmanaged":
      return owner.path;
  }
}

/**
 * Every owner of the skill-target folder `name` resolves to.
 *
 * An owner is any lock key `<source>/<skills|plugins>/<n2>` in the project or
 * local lock, any remote key `remote/<skills|plugins>/<n2>`, or any skills.sh
 * row `<n2>`, where `destinationKey(n2, ALL)` equals `destinationKey(name,
 * ALL)`. An unmanaged path — an existing path at the codex or Claude skill
 * location for `name` — counts as an owner only when none of those three
 * populations already explains the folder.
 */
export async function skillTargetOwners(
  project: string,
  name: string,
  locks: SkillTargetLocks,
): Promise<SkillTargetOwner[]> {
  const wanted = destinationKey(name, ALL_FOLDING);
  const owners: SkillTargetOwner[] = [];

  for (const lock of [locks.project, locks.local]) {
    for (const key of Object.keys(lock.items)) {
      const parsed = parseLockKey(key);
      if (!installsAtSkillTarget(parsed.kind)) continue;
      if (destinationKey(parsed.name, ALL_FOLDING) !== wanted) continue;
      owners.push({ owner: "lock", key });
    }
  }

  for (const key of Object.keys(locks.remotes.items)) {
    const parsed = parseRemoteKey(key);
    if (destinationKey(parsed.name, ALL_FOLDING) !== wanted) continue;
    owners.push({ owner: "lock", key });
  }

  for (const skill of await listSkillsShSkills(project)) {
    if (destinationKey(skill.name, ALL_FOLDING) !== wanted) continue;
    owners.push({ owner: "skills.sh", name: skill.name });
  }

  if (owners.length === 0) {
    const unmanaged = unmanagedSkillTargetOwner(project, name);
    if (unmanaged) owners.push(unmanaged);
  }

  return owners;
}

/**
 * Refuse a write that would create, replace, or delete the skill-target
 * folder for `kind`/`name` while another owner holds it (spec D2 guard 5).
 *
 * `self === null` means no lock key tracks this item yet — the first install
 * of it, which is exactly `add`'s call. There, an `unmanaged` owner is not
 * this guard's conflict to report: the install path already has its own
 * recovery rule for a path that exists but is not yet tracked
 * (`matchesPinnedInstall`, `src/commands/add.ts`), which adopts it only when
 * its content exactly matches the pin and refuses otherwise. Guard 5 exists
 * for a *second* owner — a lock, remote, or skills.sh row — not for that
 * already-guarded first-install path.
 */
export async function assertSkillTargetFree(
  project: string,
  kind: SkillTargetKind,
  name: string,
  locks: SkillTargetLocks,
  self: SkillTargetSelf | null,
): Promise<void> {
  const owners = (await skillTargetOwners(project, name, locks)).filter(
    (owner) => {
      if (owner.owner === "lock" && owner.key === self?.key) return false;
      if (self === null && owner.owner === "unmanaged") return false;
      return true;
    },
  );
  const first = owners[0];
  if (!first) return;
  const folder = relative(project, installedPath(project, kind, name));
  throw new PreconditionError(
    await skillTargetConflictMessage(project, folder, kind, name, first),
  );
}

async function skillTargetConflictMessage(
  project: string,
  folder: string,
  kind: SkillTargetKind,
  name: string,
  owner: SkillTargetOwner,
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
  return lockOwnerConflictMessage(folder, kind, name, owner.key);
}

/**
 * The switch message (spec D2 guard 3): names the existing owner, the item
 * being written, the two commands that switch between them, and the Claude
 * Code namespace change the switch causes (spec D2 guard 4). `<skill>` is a
 * literal placeholder for whichever skill inside the plugin is named: at this
 * point capshelf knows only the plugin's own name, not the names of the
 * skills nested under it.
 */
function lockOwnerConflictMessage(
  folder: string,
  kind: SkillTargetKind,
  name: string,
  ownerKey: string,
): string {
  const ownerRef = skillTargetRefFromKey(ownerKey);
  const ownerLabel = `${ownerRef.kind}/${ownerRef.name}`;
  const selfLabel = `${kind}/${name}`;
  const lines = [`${folder} is already installed by ${ownerKey}`];
  if (ownerRef.kind === kind) {
    // Same kind as the item being written: not the skill/plugin pair this
    // message exists for. The ordinary scope-collision guards should have
    // already refused this state; this line is a defensive fallback.
    lines.push(`  remove one owner before installing ${selfLabel}`);
    return lines.join("\n");
  }
  lines.push(
    `  a project uses one of ${ownerLabel} and ${selfLabel}. To switch:`,
    `    ${PRODUCT_NAME} rm ${ownerLabel}`,
    `    ${PRODUCT_NAME} add ${selfLabel}`,
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
 * An existing path at the codex or Claude skill location for `name`, when
 * nothing else explains it. A Claude-side symlink that resolves to the codex
 * path is the compatibility alias of a managed install, not a second owner.
 */
function unmanagedSkillTargetOwner(
  project: string,
  name: string,
): SkillTargetOwner | null {
  const codexPath = codexSkillPath(project, name);
  if (lstatOrNull(codexPath)) return { owner: "unmanaged", path: codexPath };

  const claudePath = claudeSkillPath(project, name);
  const claudeStat = lstatOrNull(claudePath);
  if (!claudeStat) return null;
  if (claudeStat.isSymbolicLink() && aliasPointsAt(claudePath, codexPath)) {
    return null;
  }
  return { owner: "unmanaged", path: claudePath };
}

function aliasPointsAt(linkPath: string, target: string): boolean {
  try {
    return (
      resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(target)
    );
  } catch {
    return false;
  }
}
