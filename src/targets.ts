import { NotFoundError, PreconditionError } from "./errors";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import type { ItemRef } from "./item-ref";
import { lockKeysForRef, parseItemRef } from "./item-ref";
import type { Lock } from "./lock";

export interface ScopedTarget {
  scope: "project" | "local";
  key: string;
}

export interface ScopeFilter {
  /** Restrict to project scope (used by `status --project`). */
  project?: boolean;
  /** Restrict to local scope. */
  local?: boolean;
}

/**
 * Every lock key a ref maps to across the project and local locks, honoring a
 * scope filter. This is the one definition of "what does this ref point at",
 * shared by apply/update/status so a ref can't resolve differently depending
 * on the verb.
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
 * Refuse a bare ref that names a pulled skill and a shelf item at once.
 *
 * `remoteKeysForRef` matches on name alone, and `add <url>` only checks
 * `skills/<name>` against the two locks, so a project can track `mcp/pdf` in
 * its shelf and pull `skills/pdf` from a URL. `apply` and `update` resolve the
 * remote row first, so without this the pulled skill would win `capshelf apply
 * pdf` outright and leave the shelf item unconverged with nothing reported.
 * `resolveTrackedTarget` already refuses an ambiguous bare ref inside one
 * population; this is the same rule across two.
 *
 * A ref that names its kind is never ambiguous and passes through.
 */
export function assertRefNotSplitAcrossPopulations(
  projectLock: Lock,
  localLock: Lock,
  ref: ItemRef,
  remoteKeys: readonly string[],
  opts: ScopeFilter = {},
): void {
  if (ref.kind !== undefined || remoteKeys.length === 0) return;
  const shelf = matchRefAcrossScopes(projectLock, localLock, ref, opts);
  if (shelf.length === 0) return;
  throw new PreconditionError(
    `ambiguous item "${ref.name}": found ${[
      ...shelf.map((match) => `${match.scope}/${match.key}`),
      ...remoteKeys,
    ].join(", ")}; use kind/name`,
  );
}

/**
 * Resolve a single ref to exactly one tracked target, or throw the standard
 * errors that apply and update must report identically: a skills.sh-managed
 * external skill (PreconditionError, verb-specific message), a ref that isn't
 * tracked (NotFoundError), or a ref that is ambiguous across scopes (Error).
 * `verb` is the present participle used in the external-skill refusal, e.g.
 * "applying" or "updating".
 */
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
    if (ref.kind === undefined || ref.kind === "skills") {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not ${opts.verb} skills/${ref.name} — ${skillsShConflictMessage(external)}`,
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
