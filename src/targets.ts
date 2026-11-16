import { NotFoundError, PreconditionError } from "./errors";
import { PRODUCT_NAME } from "./identity";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import type { ItemRef } from "./item-ref";
import { lockKeysForRef, parseItemRef } from "./item-ref";
import { parseLockKey } from "./installed";
import type { Lock } from "./lock";
import type { ItemAtCommit } from "./pin";
import { installsAtSkillTarget } from "./master";
import { parseRemoteKey } from "./remotes-lock";

export interface ScopedTarget {
  scope: "project" | "local";
  key: string;
}

export interface ScopeFilter {
  project?: boolean;
  local?: boolean;
}

export function pinnedDataItems(
  targets: readonly ScopedTarget[],
  projectLock: Lock,
  localLock: Lock,
): ItemAtCommit[] {
  return targets.flatMap(({ scope, key }) => {
    const entry = (scope === "local" ? localLock : projectLock).items[key];
    if (entry?.source !== "data") return [];
    const { kind, name } = parseLockKey(key);
    return [{ kind, name, commit: entry.sourceCommit }];
  });
}

/**
 * The single definition of what a ref points at, so apply, update, and status
 * cannot resolve it differently.
 */
export function matchRefAcrossScopes(
  projectLock: Lock,
  localLock: Lock,
  ref: ItemRef,
  opts: ScopeFilter = {},
): ScopedTarget[] {
  const includeProject = !opts.local;
  const includeLocal = !opts.project;
  return [
    ...(includeProject
      ? lockKeysForRef(projectLock, ref).map((key) => ({
          scope: "project" as const,
          key,
        }))
      : []),
    ...(includeLocal
      ? lockKeysForRef(localLock, ref).map((key) => ({
          scope: "local" as const,
          key,
        }))
      : []),
  ];
}

/**
 * A ref matching both a remote row and a shelf item is refused: remote rows
 * resolve first and would silently win, leaving the shelf item unconverged. A
 * ref matching one population passes.
 */
export function assertRefNotSplitAcrossPopulations(
  projectLock: Lock,
  localLock: Lock,
  ref: ItemRef,
  remoteKeys: readonly string[],
  opts: ScopeFilter = {},
): void {
  if (remoteKeys.length === 0) return;
  const shelf = matchRefAcrossScopes(projectLock, localLock, ref, opts);
  if (shelf.length === 0) return;
  throw splitPopulationRefusal(ref.name, [
    ...shelf.map((match) => `${match.scope}/${match.key}`),
    ...remoteKeys,
  ]);
}

/**
 * Shared so apply, update, and rm refuse identically. The hint is the adopt
 * because `kind/name` cannot separate owners that are both `skills/<name>`, and
 * `rm` refuses this state too.
 */
export function splitPopulationRefusal(
  name: string,
  owners: readonly string[],
): PreconditionError {
  const remoteOwner = owners.find((owner) => owner.startsWith("remote/"));
  const kind =
    remoteOwner !== undefined ? parseRemoteKey(remoteOwner).kind : "skills";
  return new PreconditionError(
    `ambiguous item "${name}": the shelf and a remote copy both own it — ${owners.join(", ")}`,
    {
      hint: `leave one owner: ${PRODUCT_NAME} share ${kind}/${name} --adopt`,
    },
  );
}

export async function resolveTrackedTarget(
  project: string,
  projectLock: Lock,
  localLock: Lock,
  itemRef: string,
  opts: ScopeFilter & { verb: string },
): Promise<ScopedTarget> {
  const ref = parseItemRef(itemRef);
  const matches = matchRefAcrossScopes(projectLock, localLock, ref, opts);
  if (matches.length === 0) {
    if (ref.kind === undefined || installsAtSkillTarget(ref.kind)) {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not ${opts.verb} ${ref.kind ?? "skills"}/${ref.name} — ${skillsShConflictMessage(external)}`,
        );
      }
    }
    throw new NotFoundError(`not tracked in this project: ${itemRef}`);
  }
  if (matches.length > 1) {
    throw new PreconditionError(
      `ambiguous item "${ref.name}": found in ${matches
        .map((match) => `${match.scope}/${match.key}`)
        .join(", ")}; use --local or remove one owner`,
    );
  }
  return matches[0]!;
}
