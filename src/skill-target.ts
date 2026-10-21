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
 * finds every owner of a skill-target folder: a project-lock entry, a
 * local-lock entry, a remote row, a skills.sh row, or an unmanaged path.
 * `assertSkillTargetFree` refuses a write that would create, replace, or
 * delete that folder while another owner holds it.
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
 * refuses on the first owner left. For `share --adopt`, it is the remote key
 * the adopt releases (`remote/<kind>/<n>`).
 */
export interface SkillTargetSelf {
  key: string;
}

/**
 * `addCommand` replaces `capshelf add <kind>/<name>` in the switch message.
 * A remote install passes its own command, because a shelf `add` of the
 * same ref would not install from the upstream.
 *
 * `ignoreSkillsSh` drops a skills.sh owner. Only `share --adopt` of a remote
 * *skill* row sets it: skills.sh is a legitimate previous owner of a skill,
 * and a skill adopt beside a skills.sh row of the same name succeeded before
 * this guard existed. A plugin adopt never sets it: skills.sh never installs
 * a plugin, so its row there is a second owner of the folder (spec D2 guard
 * 5, D9).
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

/** A short label for an owner, for a message that only needs to name it. */
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
 * Every owner of the skill-target folder `name` resolves to.
 *
 * An owner is any lock key `<source>/<skills|plugins>/<n2>` in the project or
 * local lock, any remote key `remote/<skills|plugins>/<n2>`, or any skills.sh
 * row `<n2>`, where `destinationKey(n2, ALL)` equals `destinationKey(name,
 * ALL)`. An unmanaged path is an existing directory entry, folded the same
 * way, at the codex or Claude skill location for `name`. It counts as an
 * owner unless it is the exact destination of one of those owners, or the
 * same file as one (an alias symlink, or a folding volume). The scan runs
 * even when a lock explains the name: a lock entry for `rr` does not explain
 * an unmanaged `.agents/skills/RR` on a case-sensitive volume.
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
 * Whether `path` is a managed owner's destination: the exact path, or the
 * same file by device and inode. The second case covers the Claude alias
 * symlink and a volume that folds case, where `RR` and `rr` are one folder.
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
 * Refuse a write that would create, replace, or delete the skill-target
 * folder for `kind`/`name` while another owner holds it (spec D2 guard 5).
 *
 * `self === null` means no lock key tracks this item yet — the first install
 * of it, which is exactly `add`'s call. There, an `unmanaged` owner at the
 * item's own destination is not this guard's conflict to report: the install
 * path already has its own recovery rule for a path that exists but is not
 * yet tracked (`matchesPinnedInstall`, `src/commands/add.ts`), which adopts
 * it only when its content exactly matches the pin and refuses otherwise.
 * That rule checks only the exact path. An unmanaged entry that only folds
 * to the name, such as `.agents/skills/RR` for `rr`, stays an owner, because
 * the two folders collide on a volume that folds case.
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
    // Same kind as the item being written: not the skill/plugin pair this
    // message exists for. The ordinary scope-collision guards should have
    // already refused this state; this line is a defensive fallback.
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
 * Each existing directory entry at the codex or Claude skills directory that
 * folds to `name`, for when nothing else explains the folder. Matched by
 * `readdir` plus `destinationKey`, not by `lstat`-ing the literal name: a
 * committed `.agents/skills/RR` must be found for a write of `rr` on every
 * machine, including one whose filesystem does not fold case or Unicode
 * itself (spec D2 guard 5). Every match is returned, so an exact entry cannot
 * hide a folded one beside it.
 *
 * The codex entries come first. `skillTargetOwners` drops the entries that
 * a managed owner explains.
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

/** The entries of `dir` that fold to `wanted`. Never throws. */
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
