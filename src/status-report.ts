import { GitReadMemo } from "./git-read-memo";
/**
 * The command and the web UI share this function so a dashboard row is always
 * the row `status --json` prints.
 */
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { resolveDataRepoOptional } from "./data-repo";
import { entryIdentity } from "./lock";
import type { Lock, LockEntry } from "./lock";
import { describeInstallation, isTreePinned } from "./install-identity";
import type { Manifest } from "./manifest";
import type { ItemKind } from "./master";
import {
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "./master";
import {
  installedPath,
  itemOutputTargets,
  parseLockKey,
  shaOfInstalled,
} from "./installed";
import { pluginRunCounts } from "./plugin-runs";
import { claudeTrustFor } from "./claude-trust";
import { findSystemItem, shaOfSystemItem } from "./bundled";
import type { ItemRef } from "./item-ref";
import {
  commitExists,
  isGitWorkTreeRoot,
  headSha,
  repositoryObjectsDirectory,
  worktreeCleanSnapshot,
} from "./git";
import type { PathCleanCheck } from "./git";
import { upstreamFactsForItem } from "./upstream-facts";
import { pinnedDataItems } from "./targets";
import {
  listClaudePlugins,
  listSkillsShSkills,
  listUserSkills,
  withUserSkillShadows,
} from "./external";
import type {
  ExternalClaudePlugin,
  ExternalSkill,
  ExternalUserSkill,
} from "./external";
import {
  buildStatusDiff,
  copyDirectoryModeDrifted,
  currentCopyDirectoryItemSha,
} from "./status-diff";
import type { StatusDiff, StatusDiffView } from "./status-diff";
import {
  codexProjectTrustWarnings,
  isStrictRuntimeWarning,
  runtimeWarningsForItem,
} from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import {
  fragmentContributionState,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
  type FragmentContributionState,
  type FragmentOutputPlan,
  type FragmentTarget,
} from "./fragments";
import {
  deriveNeedsState,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type ExternalPersonalClaudeSkill,
  type State,
  type StatusAxes,
  type StatusRow,
} from "./status-core";
import {
  filteredPathsAtCommit,
  batchItemReads,
  itemTreeEntriesAtCommit,
  prefetchItemBlobs,
  prefetchSourceCommits,
  type FilteredPath,
  type ItemAtCommit,
} from "./pin";
import { buildRemoteStatusRows } from "./remote-status";
import type { RemotesLock } from "./remotes-lock";
import { contentSourceOrNull, isBundled, isGitTree } from "./item-source";
import type { GitTreeSource } from "./item-source";
import {
  committedItemNeedsFromSidecar,
  committedSidecarsAtCommit,
  loadCommittedItemNeeds,
} from "./metadata";
import type { ItemNeeds } from "./metadata";
import {
  shaOfInstalledSubagent,
  subagentTargetStatusAtCommit,
} from "./subagents";
import {
  coversTarget,
  itemTargetCoverageAtCommit,
  targetCoverageJson,
  unknownTargetCoverage,
} from "./target-coverage";
import type { TargetCoverageReport } from "./target-coverage";

export interface StatusScope {
  project?: boolean;
  local?: boolean;
}

export interface StatusReportInput {
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  dataRepo: string | null;
  remotes: RemotesLock;
  ref?: ItemRef;
  scope?: StatusScope;
}

export interface StatusReport {
  rows: StatusRow[];
  external: ExternalSkill[];
  externalClaudePlugins: ExternalClaudePlugin[];
  externalUserSkills: ExternalUserSkill[];
  personalClaudeExternal: ExternalPersonalClaudeSkill[];
}

/**
 * An unconfigured, missing, or non-git data repo degrades to null, so data
 * items report missing_upstream instead of crashing. Genuine git errors still
 * surface from the per-item calls.
 */
export async function resolveStatusDataRepo(opts: {
  override?: string;
  manifest: Manifest;
  project: string;
}): Promise<string | null> {
  const resolved = await resolveDataRepoOptional(opts);
  return resolved && existsSync(resolved) && (await isGitWorkTreeRoot(resolved))
    ? resolved
    : null;
}

export function rowFailsStrict(row: StatusRow): boolean {
  return (
    (row.state !== "ok" && row.state !== "kept-local") ||
    (row.runtimeWarnings?.some(isStrictRuntimeWarning) ?? false) ||
    // An unfinished adopt is a warning, not a new `State`, so state switches
    // are untouched; it still fails strict while it lasts.
    row.remote?.alsoTrackedInShelf === true ||
    // A visible extra is drift that `update` deletes, so it fails strict;
    // kept-local rows are exempt.
    (row.state !== "kept-local" && (row.visibleExtras?.length ?? 0) > 0)
  );
}

export function statusDiffViews(
  state: State,
): Array<Exclude<StatusDiffView, "all">> {
  const views: Array<Exclude<StatusDiffView, "all">> = [];
  if (
    state === "drifted_local" ||
    state === "drifted_and_update" ||
    state === "missing_installed" ||
    state === "missing_output" ||
    state === "drifted_and_upstream_dirty" ||
    state === "output_drift" ||
    state === "source_dirty" ||
    state === "source_dirty_and_output_drift" ||
    state === "missing_source_commit"
  ) {
    views.push("installed");
  }
  if (
    state === "update_available" ||
    state === "drifted_and_update" ||
    state === "missing_upstream" ||
    state === "missing_source_commit" ||
    state === "drifted_and_upstream_dirty" ||
    state === "upstream_dirty"
  ) {
    views.push("upstream");
  }
  return views;
}

export function filterUserSkillsForRef(
  skills: ExternalUserSkill[],
  ref: ItemRef | undefined,
): ExternalUserSkill[] {
  if (!ref) return skills;
  if (ref.kind !== undefined && !installsAtSkillTarget(ref.kind)) return [];
  return skills.filter((skill) => skill.name === ref.name);
}

export async function buildStatusReport(
  input: StatusReportInput,
): Promise<StatusReport> {
  const { project, manifest, projectLock, localLock, dataRepo, ref } = input;
  const scope = input.scope ?? {};
  const targets = statusTargets(projectLock, localLock, ref, scope);
  // Read once per status run: every plugin row, shelf or remote, shares the
  // same workspace trust fact.
  const claudeTrust = claudeTrustFor(project);
  const external = (await listSkillsShSkills(project)).filter(
    (skill) =>
      !ref ||
      (skill.name === ref.name &&
        (ref.kind === undefined || installsAtSkillTarget(ref.kind))),
  );
  const externalClaudePlugins = (await listClaudePlugins(project)).filter(
    (plugin) =>
      !ref ||
      (ref.kind === undefined &&
        (plugin.id === ref.name || plugin.name === ref.name)),
  );
  const externalUserSkills =
    scope.project || scope.local
      ? []
      : filterUserSkillsForRef(
          withUserSkillShadows(await listUserSkills(), projectLock, localLock),
          ref,
        );
  const externalSkillNames = new Set(external.map((skill) => skill.name));

  const memo = new GitReadMemo();
  // One `HEAD` read is shared so the history walk and every row's sidecar read
  // see the same commit; a failed read is not cached.
  let observedHead: string | undefined;
  const observeHead = async (): Promise<string | undefined> => {
    observedHead ??= await headSha(dataRepo!).catch(() => undefined);
    return observedHead;
  };
  let observedObjectsDir: string | undefined;
  const observeObjectsDir = async (): Promise<string> => {
    observedObjectsDir ??= await repositoryObjectsDirectory(dataRepo!);
    return observedObjectsDir;
  };
  let observedClean: PathCleanCheck | undefined;
  const isDataPathClean: PathCleanCheck = async (relPath) => {
    observedClean ??= await worktreeCleanSnapshot(dataRepo!);
    return await observedClean(relPath);
  };
  const dataItems = targets
    .map((target) => parseLockKey(target.key))
    .filter((parsed) => parsed.source === "data");
  let observedSidecars: Map<string, Buffer> | undefined;
  let walkHead: string | undefined;
  if (dataRepo) {
    const pinned = pinnedDataItems(targets, projectLock, localLock);
    batchItemReads(dataRepo, pinned, memo);
    if (pinned.length >= 2) {
      walkHead = await observeHead();
      if (walkHead !== undefined) {
        await prefetchSourceCommits(dataRepo, walkHead, pinned, memo);
      }
    }
    await prefetchItemBlobs(
      dataRepo,
      pinned.filter((item) => !isCopyDirectoryItemKind(item.kind)),
      memo,
    );
  }
  const rows: StatusRow[] = [];
  const fragmentStates = new Map<string, FragmentContributionState>();
  for (const target of targets) {
    const { scope: rowScope, key } = target;
    const lock = rowScope === "local" ? localLock : projectLock;
    const { source, kind, name: itemName } = parseLockKey(key);
    if (installsAtSkillTarget(kind) && externalSkillNames.has(itemName)) {
      continue;
    }

    const entry = lock.items[key]!;
    // A null content source means no usable repository: the row degrades
    // instead of failing the command.
    const contentSource = contentSourceOrNull({
      entry,
      kind,
      name: itemName,
      repo: dataRepo,
    });
    const tree = isGitTree(contentSource) ? contentSource : null;
    // Probe commit reachability first: commit-dependent git reads error on an
    // unreachable pin, so those are skipped and the row degrades to
    // missing_source_commit.
    const sourceCommitPresent: boolean | null = tree
      ? await commitExists(tree.repo, tree.commit, memo)
      : null;
    // Mode is inside the digest under lock v4, so an executable-bit flip is a
    // different identity and `modeDrifted` stays false.
    const treeIdentity = isTreePinned(entry);
    const installation =
      treeIdentity && tree
        ? await describeInstallation(
            project,
            tree,
            kind,
            itemName,
            rowScope,
            memo,
          )
        : null;
    let currentSha: string | null;
    let modeDrifted = false;
    if (treeIdentity && tree) {
      currentSha =
        sourceCommitPresent === false
          ? null
          : (installation?.currentSha ?? null);
    } else if (isFragmentItemKind(kind)) {
      currentSha = await shaOfInstalled(project, kind, itemName);
    } else if (isCopyDirectoryItemKind(kind)) {
      const lockedSource = sourceCommitPresent === false ? null : contentSource;
      currentSha = await currentCopyDirectoryItemSha({
        project,
        source: lockedSource,
        manifest,
        kind,
        name: itemName,
      });
      if (currentSha !== null) {
        modeDrifted = await copyDirectoryModeDrifted({
          project,
          source: lockedSource,
          manifest,
          kind,
          name: itemName,
        });
      }
    } else if (isCopyTargetFileItemKind(kind)) {
      currentSha =
        tree && sourceCommitPresent !== false
          ? await shaOfInstalledSubagent(
              project,
              tree.repo,
              itemName,
              tree.commit,
              memo,
            )
          : entryIdentity(entry);
    } else {
      throw new Error(`no status strategy for ${kind}/${itemName}`);
    }
    let fragmentOutputState: FragmentContributionState | null = null;
    // The outer test asks whether the record is a shelf fragment that
    // contributes to merged output; the inner asks whether the commit is
    // readable, so they must not be merged.
    if (source === "data" && isFragmentItemKind(kind)) {
      if (tree === null || sourceCommitPresent === false) {
        currentSha = entryIdentity(entry);
      } else {
        fragmentOutputState = await itemFragmentContributionState(
          project,
          tree.repo,
          manifest,
          lock,
          kind,
          itemName,
          entry,
          rowScope,
          fragmentStates,
          memo,
        );
        currentSha =
          fragmentOutputState === "ok"
            ? entryIdentity(entry)
            : fragmentOutputState === "missing"
              ? null
              : "fragment-output-drift";
      }
    }

    let upstreamSha: string | null = null;
    let upstreamChanged = false;
    let upstreamDirty = false;
    let currentNeeds: ItemNeeds | undefined;
    if (source === "data") {
      if (dataRepo) {
        const upstream = await upstreamFactsForItem(
          dataRepo,
          kind,
          itemName,
          treeIdentity ? "tree" : "worktree",
          { memo, isClean: isDataPathClean, head: walkHead },
        );
        upstreamSha = upstream.upstreamSha;
        upstreamDirty = upstream.upstreamDirty;
        upstreamChanged =
          upstreamSha !== entryIdentity(entry) ||
          (entry.source === "data" &&
            upstream.sourceCommit !== null &&
            upstream.sourceCommit !== entry.sourceCommit);
        if (upstreamSha !== null || upstreamDirty) {
          const head = await observeHead();
          if (head !== undefined) {
            try {
              const item = { kind, name: itemName };
              observedSidecars ??= await committedSidecarsAtCommit(
                dataRepo,
                dataItems,
                head,
                memo,
              ).catch(() => undefined);
              // If the batch read failed, fall back to a per-row read, which
              // reports no needs when Git cannot read the sidecar.
              currentNeeds = (
                observedSidecars === undefined
                  ? await loadCommittedItemNeeds(dataRepo, item, head)
                  : committedItemNeedsFromSidecar(item, observedSidecars)
              ).needs;
            } catch {
              currentNeeds = undefined;
            }
          }
        }
      }
    } else {
      const sys = findSystemItem(itemName);
      upstreamSha =
        sys && sys.kind === kind ? await shaOfSystemItem(sys) : null;
      upstreamChanged = upstreamSha !== entryIdentity(entry);
    }

    // Run `check-attr` against the pinned commit so the verdict is identical in
    // every clone, whether or not it holds the driver's key.
    const filteredPaths =
      treeIdentity && tree && sourceCommitPresent !== false
        ? await filteredPathsForEntry(
            tree,
            kind,
            itemName,
            observeObjectsDir,
            memo,
          )
        : [];
    const axes: StatusAxes | undefined = treeIdentity
      ? {
          pin:
            sourceCommitPresent === false || installation === null
              ? "unresolvable"
              : installation.pinnedSha === entryIdentity(entry)
                ? "valid"
                : "mismatch",
          sourceState:
            filteredPaths.length > 0
              ? "filtered"
              : upstreamDirty
                ? "dirty"
                : "exact",
          ...(installation !== null && {
            installation: installation.axis,
            visibleExtras: installation.visibleExtras,
            installDifferences: installation.differences.filter(
              (difference) => difference.kind !== "untouched",
            ),
          }),
          ...(filteredPaths.length > 0 && { filteredPaths }),
        }
      : undefined;
    const state = deriveState({
      kind,
      source: entry.source,
      local: entry.source === "data" && entry.local === true,
      lockedSha: entryIdentity(entry),
      currentSha,
      modeDrifted,
      upstreamSha,
      upstreamDirty,
      upstreamChanged,
      fragmentOutputState,
      sourceCommitPresent,
      sourceFiltered: filteredPaths.length > 0,
    });
    // Read coverage at the locked commit, not the worktree, so `status` reports
    // what the project actually has.
    let targetCoverage: TargetCoverageReport | null = null;
    if (isBundled(contentSource)) {
      targetCoverage = null;
    } else if (tree === null) {
      targetCoverage = unknownTargetCoverage(
        project,
        kind,
        itemName,
        "data repo unbound",
      );
    } else if (sourceCommitPresent === false) {
      targetCoverage = unknownTargetCoverage(
        project,
        kind,
        itemName,
        "locked commit unreachable",
      );
    } else {
      targetCoverage = await itemTargetCoverageAtCommit(
        project,
        tree.repo,
        kind,
        itemName,
        tree.commit,
        { commitKnownPresent: true, memo },
      );
    }

    const subagentTargets =
      kind === "subagents" &&
      tree &&
      sourceCommitPresent !== false &&
      // Gate rather than catch: a blob failing after the tree enumerated means
      // `apply` can't run either, and swallowing it would show a healthy row.
      // `targets` is omitted, not emptied, since an empty array falsely claims
      // no targets.
      targetCoverage?.state !== "unknown"
        ? (
            await subagentTargetStatusAtCommit(
              project,
              tree.repo,
              itemName,
              tree.commit,
              memo,
            )
          ).map((detail) => ({
            ...detail,
            outputPath: relative(project, detail.outputPath),
          }))
        : undefined;

    const runs =
      kind === "plugins"
        ? await pluginRunCounts(
            installedPath(project, kind, itemName, manifest.installMode),
            sourceCommitPresent === false ? null : tree,
          )
        : null;

    rows.push(
      buildStatusRow({
        scope: rowScope,
        source,
        ...(runs !== null && { runs }),
        ...(kind === "plugins" && { claudeTrust }),
        kind,
        name: itemName,
        entry,
        state,
        currentSha,
        modeDrifted,
        upstreamSha,
        upstreamDirty,
        needsState:
          entry.source === "data"
            ? deriveNeedsState(entry.needs ?? null, currentNeeds)
            : undefined,
        targets: subagentTargets,
        ...(targetCoverage !== null && {
          coverage: targetCoverageJson(targetCoverage, project),
        }),
        ...(axes !== undefined && { axes }),
        runtimeWarnings: [
          ...runtimeWarningsForItem(project, kind, itemName),
          ...codexWarningsForItem(project, kind, itemName, targetCoverage),
        ],
      }),
    );
  }

  // Remote rows are local scope, so `--project` excludes them; appending
  // unconditionally would put a gitignored row in a committed-state-only
  // report.
  if (!scope.project) {
    rows.push(
      ...(await buildRemoteStatusRows({
        project,
        remotes: input.remotes,
        projectLock,
        localLock,
        claudeTrust,
        ...(ref !== undefined && { ref }),
      })),
    );
  }

  return {
    rows,
    external,
    externalClaudePlugins,
    externalUserSkills,
    personalClaudeExternal: personalClaudeExternals(rows),
  };
}

export interface StatusDiffsInput {
  project: string;
  dataRepo: string | null;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  rows: StatusRow[];
  view: StatusDiffView;
}

export async function collectStatusDiffs(
  input: StatusDiffsInput,
): Promise<StatusDiff[]> {
  const diffs: StatusDiff[] = [];
  const seenPaths = new Set<string>();
  const fragmentPlans = new Map<
    Lock,
    Map<FragmentTarget, FragmentOutputPlan>
  >();
  const fragmentPlanner: typeof planFragmentOutput = async (opts) => {
    let plansByTarget = fragmentPlans.get(opts.oldLock);
    if (plansByTarget === undefined) {
      plansByTarget = new Map();
      fragmentPlans.set(opts.oldLock, plansByTarget);
    }
    const cached = plansByTarget.get(opts.target);
    if (cached !== undefined) return cached;
    const plan = await planFragmentOutput(opts);
    plansByTarget.set(opts.target, plan);
    return plan;
  };
  const memo = new GitReadMemo();
  if (input.dataRepo) {
    const pinned: ItemAtCommit[] = input.rows.flatMap((row) =>
      row.source === "data" && row.sourceCommit !== undefined
        ? [{ kind: row.kind, name: row.name, commit: row.sourceCommit }]
        : [],
    );
    await prefetchItemBlobs(input.dataRepo, pinned, memo);
  }
  for (const row of input.rows) {
    const rowLock = row.scope === "local" ? input.localLock : input.projectLock;
    const views =
      input.view === "all"
        ? (["installed", "upstream"] as const)
        : [input.view];
    for (const view of views) {
      const diff = await buildStatusDiff({
        project: input.project,
        dataRepo: input.dataRepo,
        manifest: input.manifest,
        lock: rowLock,
        row,
        view,
        fragmentPlanner,
        memo,
      });
      const identity = diff
        ? `${row.scope}:${diff.item}:${diff.path}:${diff.view}`
        : "";
      if (!diff || seenPaths.has(identity)) continue;
      seenPaths.add(identity);
      diffs.push(diff);
    }
  }
  return diffs;
}

/**
 * Memoized so all rows at one commit are answered from a single attribute
 * query, sharing one Git process.
 */
async function filteredPathsForEntry(
  source: GitTreeSource,
  kind: ItemKind,
  name: string,
  observeObjectsDir: () => Promise<string>,
  memo: GitReadMemo,
): Promise<FilteredPath[]> {
  try {
    const entries = await itemTreeEntriesAtCommit(source, kind, memo);
    return await filteredPathsAtCommit(
      source.repo,
      source.commit,
      [{ kind, name, entries }],
      observeObjectsDir,
      memo,
    );
  } catch {
    return [];
  }
}

/**
 * For an mcp item, drop the Codex trust warning only on evidence that the
 * locked commit has no Codex source. Unknown coverage still emits, so a
 * degraded project never loses it.
 */
function codexWarningsForItem(
  project: string,
  kind: ItemKind,
  name: string,
  coverage: TargetCoverageReport | null,
): RuntimeWarning[] {
  if (kind === "subagents") {
    const hasCodexTarget = itemOutputTargets(project, kind, name).some(
      ({ id, outputPath }) => id === "codex" && existsSync(outputPath),
    );
    return hasCodexTarget ? codexProjectTrustWarnings(project) : [];
  }
  if (kind !== "mcp" && kind !== "codex-config") {
    return [];
  }
  if (
    kind === "mcp" &&
    coverage !== null &&
    coverage.state === "known" &&
    !coversTarget(coverage, "codex")
  ) {
    return [];
  }
  return codexProjectTrustWarnings(project);
}

async function itemFragmentContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  kind: Extract<ItemKind, "settings" | "mcp" | "codex-config">,
  name: string,
  entry: LockEntry,
  rowScope: string,
  states: Map<string, FragmentContributionState>,
  memo: GitReadMemo,
): Promise<FragmentContributionState> {
  if (entry.source !== "data") return "ok";
  const targets = await lockedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
    memo,
  );
  let state: FragmentContributionState = "ok";
  for (const target of targets) {
    const stateKey = `${rowScope}/${target}`;
    let targetState = states.get(stateKey);
    if (targetState === undefined) {
      targetState = await fragmentContributionState(
        project,
        dataRepo,
        manifest,
        lock,
        target,
        memo,
      );
      states.set(stateKey, targetState);
    }
    if (targetState === "missing") return "missing";
    if (targetState === "drifted") state = "drifted";
  }
  return state;
}
