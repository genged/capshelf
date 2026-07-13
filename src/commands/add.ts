import type { Command } from "commander";
import { join } from "node:path";
import { homeRelative } from "../paths";
import { loadProjectContext } from "../command-context";
import { saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { addManifestName, manifestNamesForKind } from "../manifest";
import { saveLocalLock, saveLock, dataKey } from "../lock";
import type { Lock } from "../lock";
import {
  isFragmentItemKind,
  listMasterItems,
  shaOfGitVisibleItem,
} from "../master";
import type { MasterItem } from "../master";
import {
  METADATA_SIDECAR,
  loadDataItemMetadata,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata } from "../metadata";
import { NotFoundError, PreconditionError, ResultExitError } from "../errors";
import { copyItemIntoProject, targetDir } from "../sync";
import { findInstallConflict } from "../installed";
import { isSystemItemName } from "../bundled";
import { assertPathClean, lastTouchingContentCommit } from "../git";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  saveLocalConfig,
} from "../local-config";
import type { LocalConfig } from "../local-config";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  applyFragmentOutput,
  assertFragmentSourcesClean,
  currentFragmentSourcesForItem,
  currentFragmentTargetsForItem,
  fragmentOutputPath,
  lastTouchingFragmentCommit,
  shaOfFragmentItem,
} from "../fragments";
import type { FragmentApplyResult, FragmentSource } from "../fragments";
import { isBundleRef, loadBundleStrict, memberRef } from "../bundles";
import type { Bundle } from "../bundles";
import {
  executeBundleInstall,
  planBundleInstall,
  planFailures,
  preflightBundleChecks,
} from "../bundle-install";
import type { BundlePlan, MemberPlan } from "../bundle-install";

interface AddOptions {
  json?: boolean;
  local?: boolean;
}

/** Everything the single-item installer needs; loaded once per command. */
export interface AddContext {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  localConfig: LocalConfig | null;
  local: boolean;
}

export interface InstallDataItemResult {
  sha: string;
  sourceCommit: string;
  dst: string;
  wasAlreadyInstalled: boolean;
  sources: FragmentSource[];
  outputResults: FragmentApplyResult[];
  runtimeWarnings: RuntimeWarning[];
  missingRequires: string[];
}

export function registerAdd(program: Command): void {
  program
    .command("add <item>")
    .description(
      "install an item (or expand a bundles/<name> bundle) from the data repo into the current project",
    )
    .option("--local", "install as clone-local project state")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: AddOptions, cmd: Command) => {
      // Bundle refs branch BEFORE parseItemRef: the parser rejects "bundles"
      // as an item kind, so testing afterwards would be dead code behind an
      // exit-1 throw (local/specs/bundles-spec.md).
      const bundleName = isBundleRef(itemRef);
      if (bundleName !== null) {
        await addBundle(bundleName, opts, cmd);
        return;
      }

      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(
          `"${ref.name}" is a system item — managed by the CLI, not addable from a data repo. It is installed automatically by 'capshelf init'.`,
        );
      }

      const ctx = await loadAddContext(opts, cmd);
      const item = await findMasterItemByRef(ctx.dataRepo, ref);
      if (!item) {
        throw new NotFoundError(
          `not found in data repo (${ctx.dataRepo}): ${itemRef}`,
        );
      }

      const result = await installDataItem(ctx, item);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              kind: item.kind,
              name: item.name,
              scope: ctx.local ? "local" : "project",
              sha: result.sha,
              sourceCommit: result.sourceCommit,
              dst: result.dst,
              wasAlreadyInstalled: result.wasAlreadyInstalled,
              ...(result.sources.length > 0 && {
                sources: fragmentSourcesJson(ctx.project, result),
              }),
              ...(result.runtimeWarnings.length > 0 && {
                runtimeWarnings: result.runtimeWarnings,
              }),
              ...(result.missingRequires.length > 0 && {
                missingRequires: result.missingRequires,
              }),
            },
            null,
            2,
          ),
        );
        printMissingRequires(
          `${item.kind}/${item.name}`,
          result.missingRequires,
        );
        return;
      }
      const verb = result.wasAlreadyInstalled ? "re-applied" : "added";
      const scope = ctx.local ? "local" : "project";
      console.log(
        `✓ ${verb} ${scope}/data/${item.kind}/${item.name} @ ${result.sha}`,
      );
      console.log(`  source commit: ${result.sourceCommit}`);
      console.log(`  ${result.dst}`);
      printRuntimeWarnings(result.runtimeWarnings);
      printMissingRequires(`${item.kind}/${item.name}`, result.missingRequires);
    });
}

async function loadAddContext(
  opts: AddOptions,
  cmd: Command,
): Promise<AddContext> {
  const base = await loadProjectContext({ cmd, dataRepo: true });
  const localConfig = await loadLocalConfig(base.project);
  return {
    ...base,
    // dataRepo: true guarantees it is resolved.
    dataRepo: base.dataRepo!,
    localConfig,
    local: opts.local ?? false,
  };
}

export interface InstallDataItemOptions {
  /**
   * Sidecar relations (`requires`/`conflicts-with`) enforcement. The bundle
   * executor disables it: bundle preflight already ran the symmetric
   * conflict check against installed items AND sibling members, and bundle
   * `requires` warnings are computed against installed ∪ members.
   */
  enforceRelations?: boolean;
}

/**
 * The load/check/copy/lock core shared by standalone `add` and the bundle
 * executor. Persists manifest + lock before returning, so bundle expansion
 * leaves a consistent prefix after a mid-install failure.
 *
 * Deliberately has NO skip guard for already-installed items: standalone
 * `add` re-applies them (recomputes sha/sourceCommit, rewrites the lock
 * entry with a fresh appliedAt) and "re-applied" vs "added" is display-only.
 * The bundle executor never calls this for installed members — the skip
 * lives there, not here (local/specs/bundles-spec.md).
 */
export async function installDataItem(
  ctx: AddContext,
  item: MasterItem,
  opts: InstallDataItemOptions = {},
): Promise<InstallDataItemResult> {
  const { project, dataRepo, manifest, projectLock, localLock, localConfig } =
    ctx;
  const lock = ctx.local ? localLock : projectLock;
  const oldLock = structuredClone(lock);

  // One unguarded call suffices: the helper returns early for skills.
  if (ctx.local) {
    assertLocalScopeSupported(item.kind, item.name, "add --local");
  }

  // Refuse to add from a dirty path. Otherwise the locked sha (hashed from
  // working tree) would not match git show <sourceCommit> (the last commit
  // touching the path), leaving apply/revert with the wrong content.
  if (isFragmentItemKind(item.kind)) {
    await assertFragmentSourcesClean(dataRepo, item.kind, item.name);
  } else {
    await assertPathClean(dataRepo, item.repoRelPath);
  }

  const key = dataKey(item.kind, item.name);
  const otherLock = ctx.local ? projectLock : localLock;
  if (otherLock.items[key] !== undefined) {
    const otherScope = ctx.local ? "project" : "local";
    throw new PreconditionError(
      `${item.kind}/${item.name} is already owned by ${otherScope} scope; remove one owner before adding another`,
    );
  }
  const alreadyInManifest = ctx.local
    ? (localConfig?.skills.includes(item.name) ?? false)
    : manifestNamesForKind(manifest, item.kind).includes(item.name);
  const alreadyInLock = lock.items[key] !== undefined;
  const dst = isFragmentItemKind(item.kind)
    ? fragmentOutputPath(
        project,
        (
          await currentFragmentTargetsForItem(dataRepo, item.kind, item.name)
        )[0]!,
      )
    : targetDir(project, item, manifest.installMode);

  if (item.kind === "skills") {
    const external = await findSkillsShSkill(project, item.name);
    if (external) {
      throw new PreconditionError(
        `not installing ${item.kind}/${item.name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const conflict = isFragmentItemKind(item.kind)
    ? null
    : findInstallConflict(project, item.kind, item.name, manifest.installMode);
  if (!alreadyInLock && conflict) {
    throw new PreconditionError(
      `not installing ${item.kind}/${item.name} — target already exists but is not managed by capshelf\n` +
        `  existing path: ${conflict}\n` +
        `  remove it manually, choose a different name, or adopt it with: capshelf share ${item.kind}/${item.name} --to project`,
    );
  }
  if (ctx.local) {
    await assertLocalInstallPathsUntracked(project, item.name);
  }

  const missingRequires =
    opts.enforceRelations === false
      ? []
      : await enforceItemRelations(dataRepo, item, projectLock, localLock);

  const sha = isFragmentItemKind(item.kind)
    ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
    : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
  const sourceCommit = isFragmentItemKind(item.kind)
    ? await lastTouchingFragmentCommit(dataRepo, item.kind, item.name)
    : await lastTouchingContentCommit(dataRepo, item.repoRelPath);

  if (ctx.local) {
    if (!localConfig) {
      throw new PreconditionError(
        "no local manifest exists; run capshelf init or capshelf set-data first",
      );
    }
    if (!localConfig.skills.includes(item.name))
      localConfig.skills.push(item.name);
  } else {
    addToManifest(manifest, item);
  }
  lock.items[key] = {
    source: "data",
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
  };

  const sources = isFragmentItemKind(item.kind)
    ? await currentFragmentSourcesForItem(dataRepo, item.kind, item.name)
    : [];
  const outputResults: FragmentApplyResult[] = [];
  if (isFragmentItemKind(item.kind)) {
    for (const target of [...new Set(sources.map((source) => source.target))]) {
      outputResults.push(
        await applyFragmentOutput({
          project,
          dataRepo,
          manifest,
          oldLock,
          nextLock: lock,
          target,
        }),
      );
    }
  } else {
    await copyItemIntoProject(project, item, manifest.installMode);
  }
  const runtimeWarnings = runtimeWarningsForItem(project, item.kind, item.name);

  if (ctx.local) {
    if (!localConfig) throw new Error("expected local manifest");
    await ensureLocalExcludes(project, item.name);
    await saveLocalConfig(project, localConfig);
    await saveLocalLock(project, lock);
  } else {
    await saveManifest(project, manifest);
    await saveLock(project, lock);
  }

  return {
    sha,
    sourceCommit,
    dst,
    wasAlreadyInstalled: alreadyInManifest && alreadyInLock,
    sources,
    outputResults,
    runtimeWarnings,
    missingRequires,
  };
}

/** Expand `add bundles/<name>`: load → preflight → refuse or install. */
async function addBundle(
  name: string,
  opts: AddOptions,
  cmd: Command,
): Promise<void> {
  const ctx = await loadAddContext(opts, cmd);
  const bundle = await loadBundleStrict(ctx.dataRepo, name);
  for (const warning of new Set(bundle.warnings)) {
    console.error(`⚠ ${warning}`);
  }
  const scope = ctx.local ? ("local" as const) : ("project" as const);
  if (ctx.local && !ctx.localConfig) {
    throw new Error(
      "no local manifest exists; run capshelf init or capshelf set-data first",
    );
  }

  const masterItems = await listMasterItems(ctx.dataRepo);
  const masterByRef = new Map(
    masterItems.map((item) => [`${item.kind}/${item.name}`, item]),
  );
  const metadataByRef = await loadRelationMetadata(
    bundle,
    masterByRef,
    ctx.projectLock,
    ctx.localLock,
  );

  const plan = planBundleInstall({
    bundle,
    masterItems,
    projectLock: ctx.projectLock,
    localLock: ctx.localLock,
    scope,
    metadataByRef,
  });
  await preflightBundleChecks(plan, {
    project: ctx.project,
    dataRepo: ctx.dataRepo,
    manifest: ctx.manifest,
    lock: ctx.local ? ctx.localLock : ctx.projectLock,
    masterByRef,
  });

  const failures = planFailures(plan);
  if (failures.length > 0) {
    if (opts.json) {
      printBundleJson(bundle, plan, ctx, new Map());
    } else {
      printBundleRefusal(bundle, plan, failures, ctx);
    }
    throw new ResultExitError(3);
  }

  const results = await executeBundleInstall(plan, {
    projectLock: ctx.projectLock,
    localLock: ctx.localLock,
    scope,
    installItem: (member: MemberPlan) => {
      const item = masterByRef.get(member.ref);
      if (!item) throw new Error(`expected master item for ${member.ref}`);
      return installDataItem(ctx, item, { enforceRelations: false });
    },
  });

  if (opts.json) {
    printBundleJson(bundle, plan, ctx, results);
  } else {
    printBundleSummary(bundle, plan, results);
  }
  const runtimeWarnings = collectRuntimeWarnings(results);
  if (!opts.json) printRuntimeWarnings(runtimeWarnings);
  for (const [ref, missing] of plan.missingRequiresByMember) {
    printMissingRequires(ref, missing);
  }
}

async function loadRelationMetadata(
  bundle: Bundle,
  masterByRef: Map<string, MasterItem>,
  projectLock: Lock,
  localLock: Lock,
): Promise<Map<string, ItemMetadata>> {
  // Metadata for the members (forward checks) plus every installed data
  // item (reverse conflicts) — same population standalone add consults.
  const wanted = new Set(bundle.members.map(memberRef));
  for (const lock of [projectLock, localLock]) {
    for (const key of Object.keys(lock.items)) {
      if (key.startsWith("data/")) wanted.add(key.slice("data/".length));
    }
  }
  const metadataByRef = new Map<string, ItemMetadata>();
  for (const ref of wanted) {
    const item = masterByRef.get(ref);
    if (!item) continue; // deleted upstream: skipped, never failed
    const meta = await loadDataItemMetadata(item);
    printMetadataWarnings(meta);
    metadataByRef.set(ref, meta);
  }
  return metadataByRef;
}

type BundleMemberJsonStatus =
  | "added"
  | "already-installed"
  | "refused"
  | "missing"
  | "blocked";

function memberJsonStatus(
  member: MemberPlan,
  failed: boolean,
): BundleMemberJsonStatus {
  switch (member.status) {
    case "already-installed":
      return "already-installed";
    case "missing":
      return "missing";
    case "refused":
    case "cross-scope":
      return "refused";
    case "install":
      // This member was fine; another member's failure stopped the bundle.
      return failed ? "blocked" : "added";
  }
}

function printBundleJson(
  bundle: Bundle,
  plan: BundlePlan,
  ctx: AddContext,
  results: Map<string, InstallDataItemResult>,
): void {
  const failed = planFailures(plan).length > 0;
  const lock = ctx.local ? ctx.localLock : ctx.projectLock;
  const members = plan.members.map((member) => {
    const status = memberJsonStatus(member, failed);
    const result = results.get(member.ref);
    return {
      ref: member.ref,
      status,
      ...(status === "refused" && {
        reason: member.reason ?? "refused",
      }),
      ...(status === "already-installed" && {
        sha: lock.items[dataKey(member.kind, member.name)]?.sha,
      }),
      ...(status === "added" &&
        result && {
          sha: result.sha,
          sourceCommit: result.sourceCommit,
          dst: relativeProjectPath(ctx.project, result.dst),
          ...(result.sources.length > 0 && {
            sources: fragmentSourcesJson(ctx.project, result),
          }),
        }),
    };
  });
  console.log(
    JSON.stringify(
      {
        bundle: bundle.name,
        ...(bundle.description !== undefined && {
          description: bundle.description,
        }),
        scope: ctx.local ? "local" : "project",
        dataRepo: ctx.dataRepo,
        applied: !failed,
        members,
        added: results.size,
        alreadyInstalled: plan.members.filter(
          (m) => m.status === "already-installed",
        ).length,
        missingRequires: [
          ...new Set([...plan.missingRequiresByMember.values()].flat()),
        ],
        runtimeWarnings: collectRuntimeWarnings(results),
      },
      null,
      2,
    ),
  );
}

function printBundleSummary(
  bundle: Bundle,
  plan: BundlePlan,
  results: Map<string, InstallDataItemResult>,
): void {
  if (plan.members.length === 0) {
    console.log(
      `✓ bundle ${bundle.name} → nothing to install (bundle has no members)`,
    );
    return;
  }
  const already = plan.members.filter(
    (m) => m.status === "already-installed",
  ).length;
  console.log(
    `✓ bundle ${bundle.name} → ${results.size} added, ${already} already installed`,
  );
  for (const member of plan.members) {
    if (member.status === "already-installed") {
      console.log(`  = ${member.ref.padEnd(33)} already installed`);
      continue;
    }
    const result = results.get(member.ref);
    if (result) console.log(`  + ${member.ref.padEnd(33)} @ ${result.sha}`);
  }
}

function printBundleRefusal(
  bundle: Bundle,
  plan: BundlePlan,
  failures: MemberPlan[],
  ctx: AddContext,
): void {
  // The --local skills-only rule gets ONE aggregated bundle-level error
  // naming every fragment member, never the first-violator per-kind message.
  // When it is the only failure kind, it is the headline; mixed with other
  // failures it becomes a block under a single headline whose count covers
  // every failed member.
  if (
    plan.localUnsupportedMembers.length > 0 &&
    failures.length === plan.localUnsupportedMembers.length
  ) {
    console.log(
      `✗ not installing bundle ${bundle.name} --local — local scope is skills-only`,
    );
    console.log(
      `  ${localUnsupportedLabel(plan)}: ${plan.localUnsupportedMembers.join(", ")}`,
    );
    console.log(
      `  install the bundle at project scope instead: capshelf add bundles/${bundle.name}`,
    );
    return;
  }

  const ready = plan.members.filter(
    (m) => m.status === "install" || m.status === "already-installed",
  ).length;
  console.log(
    `✗ not installing bundle ${bundle.name} — ${failures.length} of ${plan.members.length} members failed preflight`,
  );
  if (plan.localUnsupportedMembers.length > 0) {
    console.log("  ✗ local scope is skills-only");
    console.log(
      `    ${localUnsupportedLabel(plan)}: ${plan.localUnsupportedMembers.join(", ")}`,
    );
    console.log(
      `    install the bundle at project scope instead: capshelf add bundles/${bundle.name}`,
    );
    failures = failures.filter(
      (m) => !plan.localUnsupportedMembers.includes(m.ref),
    );
  }
  for (const member of failures) {
    const reason =
      member.status === "missing"
        ? `not found in data repo (${homeRelative(ctx.dataRepo)})`
        : (member.reason ?? "refused");
    const [first = "", ...rest] = reason.split("\n");
    console.log(`  ✗ ${member.ref.padEnd(24)} ${first}`);
    for (const line of [...rest, ...(member.detail ?? [])]) {
      console.log(`    ${" ".repeat(24)} ${line.trim()}`);
    }
  }
  console.log(
    `  no changes were made (${ready} ${ready === 1 ? "member was" : "members were"} ready)`,
  );
  console.log(
    `  fix the failures above, then re-run: capshelf add bundles/${bundle.name}`,
  );
}

function localUnsupportedLabel(plan: BundlePlan): string {
  return plan.localUnsupportedMembers.length ===
    plan.localFragmentMembers.length
    ? "fragment members"
    : "project-only members";
}

function collectRuntimeWarnings(
  results: Map<string, InstallDataItemResult>,
): RuntimeWarning[] {
  const seen = new Set<string>();
  const warnings: RuntimeWarning[] = [];
  for (const result of results.values()) {
    for (const warning of result.runtimeWarnings) {
      const key = JSON.stringify(warning);
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }
  return warnings;
}

function fragmentSourcesJson(
  project: string,
  result: InstallDataItemResult,
): Array<Record<string, unknown>> {
  return result.sources.map((source) => ({
    target: source.sourceTarget ?? source.target,
    sourcePath: source.relPath,
    outputPath: relativeProjectPath(
      project,
      fragmentOutputPath(project, source.target),
    ),
    outputAction:
      result.outputResults.find((r) => r.target === source.target)?.action ??
      "already-current",
  }));
}

/**
 * Enforce sidecar-declared relations before any writes.
 *
 * `conflicts-with` refuses (exit 3) and the check is symmetric: the new item
 * declaring a conflict with an installed item, or any installed data item
 * declaring a conflict with the new item, both refuse. There is no --force —
 * the two legitimate escape hatches (remove the other item, or fix a stale
 * declaration upstream) are printed in the error.
 *
 * `requires` only warns: the returned refs are missing from both locks and
 * are reported with exact fix commands (exit stays 0; exit 5 is reserved for
 * a future doctor/strict audit). Refs pointing at items deleted upstream are
 * reported as missing requires / skipped for conflicts — add never fails
 * because someone deleted a referenced item.
 */
async function enforceItemRelations(
  dataRepo: string,
  item: MasterItem,
  projectLock: Lock,
  localLock: Lock,
): Promise<string[]> {
  const meta = await loadDataItemMetadata(item);
  printMetadataWarnings(meta);
  const itemRef = `${item.kind}/${item.name}`;
  const installedKeys = new Set([
    ...Object.keys(projectLock.items),
    ...Object.keys(localLock.items),
  ]);
  // Re-adding an item must not conflict with (or require) itself.
  installedKeys.delete(dataKey(item.kind, item.name));
  const refInstalled = (ref: string): boolean =>
    installedKeys.has(`data/${ref}`) || installedKeys.has(`system/${ref}`);

  const declared = meta.conflictsWith.find(
    (ref) => ref !== itemRef && refInstalled(ref),
  );
  if (declared) {
    throw conflictRefusal(dataRepo, itemRef, declared, item.repoRelPath);
  }

  // Reverse direction: conflict relations are symmetric, so an installed
  // item's declaration against the new item refuses too.
  const masterByRef = new Map(
    (await listMasterItems(dataRepo)).map((m) => [`${m.kind}/${m.name}`, m]),
  );
  for (const installedKey of installedKeys) {
    if (!installedKey.startsWith("data/")) continue;
    const installedRef = installedKey.slice("data/".length);
    const installedItem = masterByRef.get(installedRef);
    // Deleted upstream: its declarations cannot be read — skip, never fail.
    if (!installedItem) continue;
    const installedMeta = await loadDataItemMetadata(installedItem);
    printMetadataWarnings(installedMeta);
    if (installedMeta.conflictsWith.includes(itemRef)) {
      throw conflictRefusal(
        dataRepo,
        itemRef,
        installedRef,
        installedItem.repoRelPath,
      );
    }
  }

  return meta.requires.filter((ref) => ref !== itemRef && !refInstalled(ref));
}

function conflictRefusal(
  dataRepo: string,
  newRef: string,
  installedRef: string,
  declaringRepoRelPath: string,
): PreconditionError {
  const declaringSidecar = `${declaringRepoRelPath}/${METADATA_SIDECAR}`;
  return new PreconditionError(
    `not installing ${newRef} — conflicts with installed ${installedRef}\n` +
      `  declared by: ${declaringSidecar}\n` +
      "  fix by one of:\n" +
      `    - remove the conflicting item first: capshelf rm ${installedRef}\n` +
      `    - if the declaration is stale, edit ${join(dataRepo, ...declaringSidecar.split("/"))} and commit`,
  );
}

function printMissingRequires(
  refLabel: string,
  missingRequires: string[],
): void {
  if (missingRequires.length === 0) return;
  console.error(`⚠ missing required items for ${refLabel}:`);
  for (const ref of missingRequires) {
    console.error(`    ${ref} — install with: capshelf add ${ref}`);
  }
}

function addToManifest(m: Manifest, item: MasterItem): void {
  addManifestName(m, item.kind, item.name);
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}
