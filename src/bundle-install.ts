/**
 * The executor skips already-installed members because the shared installer
 * re-applies and rewrites `appliedAt`; a bundle means "ensure present" and pin
 * movement belongs to `capshelf update`.
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
  planFragmentOutput,
} from "./fragments";
import type { FragmentTarget } from "./fragments";
import { assertPathClean } from "./git";
import type { GitReadMemo } from "./git-read-memo";
import { findInstallConflict } from "./installed";
import { assertLocalInstallPathsUntracked } from "./local-config";
import {
  assertWritableLock,
  createDataLockEntry,
  dataKey,
  emptyLock,
} from "./lock";
import { loadRemotesLock } from "./remotes-lock";
import { assertSkillTargetFree } from "./skill-target";
import type { SkillTargetLocks } from "./skill-target";
import { destinationKey, pinCurrentSource } from "./pin";
import type { Lock } from "./lock";
import { addManifestName } from "./manifest";
import type { Manifest } from "./manifest";
import {
  ITEM_KINDS,
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "./master";
import type { ItemKind, MasterItem } from "./master";
import { METADATA_SIDECAR, captureCommittedItemNeeds } from "./metadata";
import type { ItemMetadata } from "./metadata";
import {
  assertSubagentOutputAvailable,
  subagentSourceCandidates,
  validateCurrentSubagent,
} from "./subagents";

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
  ref: string;
  status: MemberPlanStatus;
  reason?: string;
  detail?: string[];
}

export interface BundlePlan {
  scope: BundleScope;
  members: MemberPlan[];
  localUnsupportedMembers: string[];
  missingRequiresByMember: Map<string, string[]>;
}

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
  metadataByRef: Map<string, ItemMetadata>;
}

export function planBundleInstall(opts: PlanBundleInstallOptions): BundlePlan {
  const { bundle, scope } = opts;
  const targetLock = scope === "local" ? opts.localLock : opts.projectLock;
  const otherLock = scope === "local" ? opts.projectLock : opts.localLock;
  const masterByRef = new Map(
    opts.masterItems.map((item) => [`${item.kind}/${item.name}`, item]),
  );
  // Fragments merge in manifest order, so file order within a kind lets authors
  // control precedence.
  const ordered = [...bundle.members].sort(
    (a, b) => ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind),
  );
  const memberRefs = new Set(ordered.map(memberRef));
  const installedRefs = new Set<string>();
  for (const lock of [opts.projectLock, opts.localLock]) {
    for (const key of Object.keys(lock.items)) {
      installedRefs.add(key.slice(key.indexOf("/") + 1));
    }
  }

  const plan: BundlePlan = {
    scope,
    members: [],
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
    if (scope === "local" && !isCopyDirectoryItemKind(member.kind)) {
      plan.localUnsupportedMembers.push(ref);
      m.status = "refused";
      m.reason = "local scope supports copy-directory items only";
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
    // Conflicts are symmetric, so an installed item's or sibling member's
    // declaration against this member refuses too. Items deleted upstream have
    // no metadata and are skipped, as in standalone add.
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
  memo?: GitReadMemo;
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  masterByRef: Map<string, MasterItem>;
  planFragmentOutputFn?: typeof planFragmentOutput;
  skillTargetLocks?: SkillTargetLocks;
}

export async function preflightBundleChecks(
  plan: BundlePlan,
  ctx: BundlePreflightContext,
): Promise<void> {
  // First, so an owner conflict is named as one, not as an unmanaged path.
  await preflightSkillTargetOwners(plan, ctx);
  for (const m of plan.members) {
    if (m.status !== "install") continue;
    const item = ctx.masterByRef.get(m.ref);
    if (!item) continue;
    try {
      if (installsAtSkillTarget(item.kind)) {
        const external = await findSkillsShSkill(ctx.project, item.name);
        if (external) {
          throw new PreconditionError(skillsShConflictMessage(external));
        }
      }
      if (isFragmentItemKind(item.kind)) {
        await assertFragmentSourcesClean(ctx.dataRepo, item.kind, item.name);
      } else if (isCopyDirectoryItemKind(item.kind)) {
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
      } else if (isCopyTargetFileItemKind(item.kind)) {
        for (const source of subagentSourceCandidates(ctx.project, item.name)) {
          await assertPathClean(ctx.dataRepo, source.relPath);
        }
        await validateCurrentSubagent(ctx.project, ctx.dataRepo, item.name);
        await assertSubagentOutputAvailable(
          ctx.project,
          ctx.dataRepo,
          item.name,
        );
      } else {
        throw new Error(`no bundle strategy for ${item.kind}/${item.name}`);
      }
      if (plan.scope === "local") {
        await assertLocalInstallPathsUntracked(
          ctx.project,
          item.kind,
          item.name,
        );
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
 * Checked across the whole bundle before any member runs so a deterministic
 * folder conflict never leaves a partial install.
 */
async function preflightSkillTargetOwners(
  plan: BundlePlan,
  ctx: BundlePreflightContext,
): Promise<void> {
  const locks: SkillTargetLocks = ctx.skillTargetLocks ?? {
    project: ctx.lock,
    local: emptyLock(),
    remotes: await loadRemotesLock(ctx.project),
  };
  const members = plan.members.filter(
    (m) => m.status === "install" && installsAtSkillTarget(m.kind),
  );
  const byFolder = new Map<string, MemberPlan[]>();
  for (const m of members) {
    const folder = destinationKey(m.name, {
      caseFolding: true,
      normalizationFolding: true,
    });
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), m]);
  }
  for (const group of byFolder.values()) {
    if (group.length < 2) continue;
    for (const m of group) {
      const others = group.filter((other) => other !== m).map((o) => o.ref);
      m.status = "refused";
      m.reason = `${m.ref} and ${others.join(", ")} install to one folder; a project uses one of them`;
    }
  }
  for (const m of members) {
    if (m.status !== "install" || !installsAtSkillTarget(m.kind)) continue;
    try {
      await assertSkillTargetFree(ctx.project, m.kind, m.name, locks, null);
    } catch (err) {
      m.status = "refused";
      m.reason = err instanceof Error ? err.message : String(err);
    }
  }
}

/**
 * Uses a prospective lock/manifest with all non-skipped fragment members,
 * because collisions must be judged against the full post-bundle merge, not
 * just preceding members.
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
  const nextLock = assertWritableLock(
    structuredClone(ctx.lock),
    "capshelf add bundles/<name>",
  );
  const targetsByRef = new Map<string, FragmentTarget[]>();
  for (const m of fragmentPlans) {
    const item = ctx.masterByRef.get(m.ref);
    if (!item || !isFragmentItemKind(item.kind)) continue;
    addManifestName(nextManifest, item.kind, item.name);
    nextLock.items[dataKey(item.kind, item.name)] = createDataLockEntry({
      pin: await pinCurrentSource(ctx.dataRepo, item.kind, item.name, {
        memo: ctx.memo,
      }),
      ...(await captureCommittedItemNeeds(ctx.dataRepo, item, {
        memo: ctx.memo,
      })),
    });
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
        memo: ctx.memo,
      });
    } catch (err) {
      const wrapped =
        err instanceof PreconditionError
          ? err
          : new PreconditionError(
              err instanceof Error ? err.message : String(err),
              { cause: err },
            );
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
  installItem(member: MemberPlan): Promise<R>;
}

/**
 * The shared installer persists manifest and lock after each member, so a
 * mid-install I/O failure leaves a consistent prefix that a re-run converges
 * past.
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
