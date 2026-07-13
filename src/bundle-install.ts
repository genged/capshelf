/**
 * Bundle install pipeline: a pure planner (`planBundleInstall`), read-only
 * async preflight checks (`preflightBundleChecks`), and the executor
 * (`executeBundleInstall`). Every deterministic refusal is caught before any
 * write, so `add bundles/<name>` is all-or-nothing without rollback
 * machinery. The executor is also the skip gate for already-installed
 * members: the shared single-item installer deliberately keeps standalone
 * `add`'s implicit re-apply (it recomputes the pin and rewrites `appliedAt`),
 * and a bundle that means "ensure these are present" must never bump existing
 * pins — pin movement belongs to `capshelf update`.
 * See local/specs/bundles-spec.md.
 */
import type { Bundle } from "./bundles";
import { memberRef } from "./bundles";
import { isSystemItemName } from "./bundled";
import { PreconditionError } from "./errors";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import {
  assertFragmentSourcesClean,
  currentFragmentTargetsForItem,
  fragmentSourceCandidates,
  lastTouchingFragmentCommit,
  planFragmentOutput,
  shaOfFragmentItem,
} from "./fragments";
import type { FragmentTarget } from "./fragments";
import { assertPathClean } from "./git";
import { findInstallConflict } from "./installed";
import { assertLocalInstallPathsUntracked } from "./local-config";
import { dataKey } from "./lock";
import type { Lock } from "./lock";
import { addManifestName } from "./manifest";
import type { Manifest } from "./manifest";
import { ITEM_KINDS, isFragmentItemKind } from "./master";
import type { ItemKind, MasterItem } from "./master";
import { METADATA_SIDECAR } from "./metadata";
import type { ItemMetadata } from "./metadata";

export type BundleScope = "project" | "local";

export type MemberPlanStatus =
  | "install"
  | "already-installed"
  | "refused"
  | "missing"
  | "cross-scope";

export interface MemberPlan {
  kind: ItemKind;
  name: string;
  /** Kind-qualified ref, e.g. "skills/security-review". */
  ref: string;
  status: MemberPlanStatus;
  /** Failure detail for refused/cross-scope members (may be multi-line). */
  reason?: string;
  /** Extra context lines printed under the reason (e.g. declaring sidecar). */
  detail?: string[];
}

export interface BundlePlan {
  scope: BundleScope;
  /** ITEM_KINDS order across kinds; bundle-file order within a kind. */
  members: MemberPlan[];
  /**
   * Fragment member refs that block `--local`, collected into ONE aggregated
   * bundle-level refusal — never per-member `assertLocalScopeSupported`,
   * which throws on the first violator with a per-kind message and would
   * hide the rest of the list.
   */
  localFragmentMembers: string[];
  /** Every non-skill member rejected by local scope, including copy items. */
  localUnsupportedMembers: string[];
  /**
   * Unmet `requires` per member, computed against installed items ∪ the
   * bundle's own members — a requirement satisfied by a sibling member that
   * is about to be installed does not warn.
   */
  missingRequiresByMember: Map<string, string[]>;
}

/** Members whose state refuses the whole bundle (all-or-nothing). */
export function planFailures(plan: BundlePlan): MemberPlan[] {
  return plan.members.filter(
    (m) =>
      m.status === "refused" ||
      m.status === "missing" ||
      m.status === "cross-scope",
  );
}

export interface PlanBundleInstallOptions {
  bundle: Bundle;
  masterItems: Pick<MasterItem, "kind" | "name" | "repoRelPath">[];
  projectLock: Lock;
  localLock: Lock;
  scope: BundleScope;
  /** Metadata for data items (members and installed), keyed by kind/name. */
  metadataByRef: Map<string, ItemMetadata>;
}

/**
 * The pure half of preflight: resolution, scope ownership, `--local`
 * aggregation, the symmetric conflicts-with check (vs installed items AND vs
 * sibling members), and `requires` against installed ∪ members. Filesystem
 * and git checks live in `preflightBundleChecks`.
 */
export function planBundleInstall(opts: PlanBundleInstallOptions): BundlePlan {
  const { bundle, scope } = opts;
  const targetLock = scope === "local" ? opts.localLock : opts.projectLock;
  const otherLock = scope === "local" ? opts.projectLock : opts.localLock;
  const masterByRef = new Map(
    opts.masterItems.map((item) => [`${item.kind}/${item.name}`, item]),
  );
  // Stable sort: ITEM_KINDS order across kinds, file order within a kind
  // (fragments merge in manifest order, so authors control precedence).
  const ordered = [...bundle.members].sort(
    (a, b) => ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind),
  );
  const memberRefs = new Set(ordered.map(memberRef));
  const installedRefs = new Set<string>();
  for (const lock of [opts.projectLock, opts.localLock]) {
    for (const key of Object.keys(lock.items)) {
      // Lock keys are <source>/<kind>/<name>; relations use <kind>/<name>
      // and match both data and system sources, exactly as `add` does.
      installedRefs.add(key.slice(key.indexOf("/") + 1));
    }
  }

  const plan: BundlePlan = {
    scope,
    members: [],
    localFragmentMembers: [],
    localUnsupportedMembers: [],
    missingRequiresByMember: new Map(),
  };

  for (const member of ordered) {
    const ref = memberRef(member);
    const m: MemberPlan = {
      kind: member.kind,
      name: member.name,
      ref,
      status: "install",
    };
    plan.members.push(m);

    if (isSystemItemName(member.name)) {
      m.status = "refused";
      m.reason = `"${member.name}" is a system item — managed by the CLI, not addable from a data repo`;
      continue;
    }
    if (!masterByRef.has(ref)) {
      m.status = "missing";
      continue;
    }
    const key = dataKey(member.kind, member.name);
    if (targetLock.items[key] !== undefined) {
      m.status = "already-installed";
      continue;
    }
    if (otherLock.items[key] !== undefined) {
      m.status = "cross-scope";
      const otherScope = scope === "local" ? "project" : "local";
      m.reason = `already owned by ${otherScope} scope; fix with: capshelf move ${ref} --to ${scope}`;
      continue;
    }
    if (scope === "local" && member.kind !== "skills") {
      plan.localUnsupportedMembers.push(ref);
      if (isFragmentItemKind(member.kind)) {
        plan.localFragmentMembers.push(ref);
      }
      m.status = "refused";
      m.reason = "local scope is skills-only";
    }
  }

  const declaredBy = (ref: string): string[] | undefined => {
    const item = masterByRef.get(ref);
    return item
      ? [`declared by: ${item.repoRelPath}/${METADATA_SIDECAR}`]
      : undefined;
  };

  for (const m of plan.members) {
    if (m.status !== "install") continue;
    const meta = opts.metadataByRef.get(m.ref);
    // Forward direction: this member declares the conflict.
    const installedHit = meta?.conflictsWith.find(
      (ref) => ref !== m.ref && installedRefs.has(ref),
    );
    const siblingHit = meta?.conflictsWith.find(
      (ref) => ref !== m.ref && memberRefs.has(ref),
    );
    if (installedHit || siblingHit) {
      m.status = "refused";
      m.reason = installedHit
        ? `conflicts with installed ${installedHit}`
        : `conflicts with bundle member ${siblingHit}`;
      m.detail = declaredBy(m.ref);
      continue;
    }
    // Reverse direction: conflict relations are symmetric, so an installed
    // item's (or a sibling member's) declaration against this member refuses
    // too. Items deleted upstream have no metadata here — skipped, never
    // failed, matching standalone add.
    for (const [declRef, declMeta] of opts.metadataByRef) {
      if (declRef === m.ref) continue;
      if (!declMeta.conflictsWith.includes(m.ref)) continue;
      if (!installedRefs.has(declRef) && !memberRefs.has(declRef)) continue;
      m.status = "refused";
      m.reason = installedRefs.has(declRef)
        ? `conflicts with installed ${declRef}`
        : `conflicts with bundle member ${declRef}`;
      m.detail = declaredBy(declRef);
      break;
    }
  }

  for (const m of plan.members) {
    if (m.status !== "install") continue;
    const meta = opts.metadataByRef.get(m.ref);
    if (!meta) continue;
    const missing = meta.requires.filter(
      (ref) => ref !== m.ref && !installedRefs.has(ref) && !memberRefs.has(ref),
    );
    if (missing.length > 0) plan.missingRequiresByMember.set(m.ref, missing);
  }

  return plan;
}

export interface BundlePreflightContext {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  /** Target-scope lock; the base for the prospective fragment lock. */
  lock: Lock;
  masterByRef: Map<string, MasterItem>;
  /** Injectable for tests; defaults to fragments.ts planFragmentOutput. */
  planFragmentOutputFn?: typeof planFragmentOutput;
}

/**
 * The read-only filesystem/git half of preflight, mirroring the standalone
 * `add` checks per member: skills.sh ownership, dirty data-repo paths,
 * untracked-target collisions, local install paths, and the fragment
 * unmanaged-collision dry-run. Failures flip members to `refused`; nothing
 * is written.
 */
export async function preflightBundleChecks(
  plan: BundlePlan,
  ctx: BundlePreflightContext,
): Promise<void> {
  for (const m of plan.members) {
    if (m.status !== "install") continue;
    const item = ctx.masterByRef.get(m.ref);
    if (!item) continue;
    try {
      if (item.kind === "skills") {
        const external = await findSkillsShSkill(ctx.project, item.name);
        if (external) {
          throw new PreconditionError(skillsShConflictMessage(external));
        }
      }
      if (isFragmentItemKind(item.kind)) {
        await assertFragmentSourcesClean(ctx.dataRepo, item.kind, item.name);
      } else {
        await assertPathClean(ctx.dataRepo, item.repoRelPath);
        const conflict = findInstallConflict(
          ctx.project,
          item.kind,
          item.name,
          ctx.manifest.installMode,
        );
        if (conflict) {
          throw new PreconditionError(
            `target already exists but is not managed by capshelf\n` +
              `existing path: ${conflict}\n` +
              `remove it manually, choose a different name, or adopt it with: capshelf share ${m.ref} --to project`,
          );
        }
      }
      if (plan.scope === "local") {
        await assertLocalInstallPathsUntracked(ctx.project, item.name);
      }
    } catch (err) {
      m.status = "refused";
      m.reason = err instanceof Error ? err.message : String(err);
    }
  }
  if (plan.scope !== "local") {
    await preflightFragmentCollisions(plan, ctx);
  }
}

/**
 * Preflight the fragment unmanaged-collision refusal without writing:
 * `planFragmentOutput({ dryRun: true })` runs `assertNoUnmanagedCollisions`
 * before any write, called once per affected fragment target with a
 * PROSPECTIVE nextLock/nextManifest containing ALL non-skipped bundle
 * fragment members — not just the members preceding the one under check,
 * because collisions must be judged against the full post-bundle merge. The
 * plain Error it throws is wrapped in a PreconditionError and attributed to
 * the offending member(s).
 */
async function preflightFragmentCollisions(
  plan: BundlePlan,
  ctx: BundlePreflightContext,
): Promise<void> {
  const fragmentPlans = plan.members.filter(
    (m) => m.status === "install" && isFragmentItemKind(m.kind),
  );
  if (fragmentPlans.length === 0) return;
  const planFn = ctx.planFragmentOutputFn ?? planFragmentOutput;

  const nextManifest = structuredClone(ctx.manifest);
  const nextLock = structuredClone(ctx.lock);
  const targetsByRef = new Map<string, FragmentTarget[]>();
  for (const m of fragmentPlans) {
    const item = ctx.masterByRef.get(m.ref);
    if (!item || !isFragmentItemKind(item.kind)) continue;
    addManifestName(nextManifest, item.kind, item.name);
    nextLock.items[dataKey(item.kind, item.name)] = {
      source: "data",
      sha: await shaOfFragmentItem(ctx.dataRepo, item.kind, item.name),
      sourceCommit: await lastTouchingFragmentCommit(
        ctx.dataRepo,
        item.kind,
        item.name,
      ),
      appliedAt: new Date().toISOString(),
    };
    targetsByRef.set(
      m.ref,
      await currentFragmentTargetsForItem(ctx.dataRepo, item.kind, item.name),
    );
  }

  const targets = [...new Set([...targetsByRef.values()].flat())];
  for (const target of targets) {
    try {
      await planFn({
        project: ctx.project,
        dataRepo: ctx.dataRepo,
        manifest: ctx.manifest,
        nextManifest,
        oldLock: ctx.lock,
        nextLock,
        target,
        dryRun: true,
      });
    } catch (err) {
      const wrapped =
        err instanceof PreconditionError
          ? err
          : new PreconditionError(
              err instanceof Error ? err.message : String(err),
              { cause: err },
            );
      // Attribute to the member(s) whose canonical source path the collision
      // message names; fall back to every member feeding this target.
      const offenders = fragmentPlans.filter(
        (m) =>
          isFragmentItemKind(m.kind) &&
          fragmentSourceCandidates(m.kind, m.name).some(
            (source) =>
              source.target === target &&
              wrapped.message.includes(source.relPath),
          ),
      );
      const blamed =
        offenders.length > 0
          ? offenders
          : fragmentPlans.filter((m) =>
              targetsByRef.get(m.ref)?.includes(target),
            );
      for (const m of blamed) {
        if (m.status !== "install") continue;
        m.status = "refused";
        m.reason = wrapped.message;
      }
    }
  }
}

export interface ExecuteBundleContext<R> {
  projectLock: Lock;
  localLock: Lock;
  scope: BundleScope;
  /** The extracted single-item installer (persists manifest+lock itself). */
  installItem(member: MemberPlan): Promise<R>;
}

/**
 * Install every planned member through the shared single-item installer,
 * which persists manifest + lock after each member, so a mid-install I/O
 * failure (the only failure preflight cannot rule out) leaves a consistent
 * prefix that a re-run converges past. This function is the skip gate: it
 * checks both locks and never invokes the installer for an already-installed
 * member — see the module comment.
 */
export async function executeBundleInstall<R>(
  plan: BundlePlan,
  ctx: ExecuteBundleContext<R>,
): Promise<Map<string, R>> {
  const results = new Map<string, R>();
  for (const m of plan.members) {
    if (m.status === "already-installed") continue;
    if (m.status !== "install") {
      throw new PreconditionError(
        `internal: executeBundleInstall reached with unresolved member ${m.ref} (${m.status})`,
      );
    }
    const key = dataKey(m.kind, m.name);
    if (
      ctx.projectLock.items[key] !== undefined ||
      ctx.localLock.items[key] !== undefined
    ) {
      m.status = "already-installed";
      continue;
    }
    results.set(m.ref, await ctx.installItem(m));
  }
  return results;
}
