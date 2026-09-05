/**
 * The status report as a function: the per-item rows `capshelf status`
 * prints, computed for one project, without the command's option parsing or
 * output. The command and the web UI both call it, so a row in the dashboard
 * is the row `status --json` prints and never a second opinion.
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
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "./master";
import { itemOutputTargets, parseLockKey, shaOfInstalled } from "./installed";
import { findSystemItem, shaOfSystemItem } from "./bundled";
import type { ItemRef } from "./item-ref";
import { commitExists, isGitWorkTreeRoot } from "./git";
import { upstreamFactsForItem } from "./upstream-facts";
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
  type FragmentContributionState,
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
  itemTreeEntriesAtCommit,
  type FilteredPath,
} from "./pin";
import { captureCommittedItemNeeds } from "./metadata";
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
  /** Restrict to project scope (`status --project`). */
  project?: boolean;
  /** Restrict to clone-local scope (`status --local`). */
  local?: boolean;
}

export interface StatusReportInput {
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  /**
   * The data repo to read upstream facts from, or null when none is usable.
   * `resolveStatusDataRepo` produces this value with the command's degrade
   * rules.
   */
  dataRepo: string | null;
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
 * The data repo `status` reads, or null.
 *
 * Status still produces a report when the data repo is not configured or has
 * gone missing on disk: data items report missing_upstream instead of
 * crashing. A configured-but-absent path degrades to null here so fragment
 * and copy items degrade uniformly, and the per-item master/git calls surface
 * genuine errors (ambiguous refs, permission failures) instead of swallowing
 * them. A bound path that is not a git repo degrades the same way.
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

/**
 * The rule `status --strict` applies to one row: anything other than
 * up-to-date or kept-local fails, and so does a strict runtime warning. The
 * web UI calls this "needs attention".
 */
export function rowFailsStrict(row: StatusRow): boolean {
  return (
    (row.state !== "ok" && row.state !== "kept-local") ||
    (row.runtimeWarnings?.some(isStrictRuntimeWarning) ?? false)
  );
}

/**
 * Which `--diff-view` comparisons a state can render. Mirrors the gates in
 * `buildStatusDiff` (`src/status-diff.ts`): the installed view exists for
 * local drift states, the upstream view for states with committed upstream
 * content to compare.
 */
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
  if (ref.kind !== undefined && ref.kind !== "skills") return [];
  return skills.filter((skill) => skill.name === ref.name);
}

export async function buildStatusReport(
  input: StatusReportInput,
): Promise<StatusReport> {
  const { project, manifest, projectLock, localLock, dataRepo, ref } = input;
  const scope = input.scope ?? {};
  const targets = statusTargets(projectLock, localLock, ref, scope);
  const external = (await listSkillsShSkills(project)).filter(
    (skill) =>
      !ref ||
      (skill.name === ref.name &&
        (ref.kind === undefined || ref.kind === "skills")),
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

  const rows: StatusRow[] = [];
  const fragmentStates = new Map<string, FragmentContributionState>();
  for (const target of targets) {
    const { scope: rowScope, key } = target;
    const lock = rowScope === "local" ? localLock : projectLock;
    const { source, kind, name: itemName } = parseLockKey(key);
    if (kind === "skills" && externalSkillNames.has(itemName)) continue;

    const entry = lock.items[key]!;
    // Reachability must be gathered before computing currentSha: the
    // sourceCommit-dependent computations below (`git show` /
    // `ls-tree` at the pinned commit) would error out on an
    // unreachable pin. When the commit is missing they are skipped and
    // the row degrades to missing_source_commit instead of crashing.
    const sourceCommitPresent: boolean | null =
      entry.source === "data" && dataRepo
        ? await commitExists(dataRepo, entry.sourceCommit)
        : null;
    // Under lock version 4 the installed state is named the way Git
    // names it — a blob id per pinned path plus its mode — so the same
    // `sourcePinDigest` formula covers the pin, the install, and the
    // upstream. Mode is inside the digest, which is why `modeDrifted`
    // stays false on that path: an executable-bit flip is already a
    // different identity rather than a separate flag.
    const treeIdentity = entry.source === "data" && isTreePinned(entry);
    const installation =
      treeIdentity && entry.source === "data" && dataRepo
        ? await describeInstallation(
            project,
            dataRepo,
            kind,
            itemName,
            entry.sourceCommit,
          )
        : null;
    let currentSha: string | null;
    let modeDrifted = false;
    if (treeIdentity && entry.source === "data" && dataRepo) {
      currentSha =
        sourceCommitPresent === false
          ? null
          : (installation?.currentSha ?? null);
    } else if (isFragmentItemKind(kind)) {
      currentSha = await shaOfInstalled(project, kind, itemName);
    } else if (isCopyDirectoryItemKind(kind)) {
      currentSha = await currentCopyDirectoryItemSha({
        project,
        dataRepo,
        manifest,
        source,
        kind,
        name: itemName,
        sourceCommit:
          entry.source === "data" && sourceCommitPresent !== false
            ? entry.sourceCommit
            : undefined,
      });
      if (currentSha !== null) {
        modeDrifted = await copyDirectoryModeDrifted({
          project,
          dataRepo,
          manifest,
          source,
          kind,
          name: itemName,
          sourceCommit:
            entry.source === "data" && sourceCommitPresent !== false
              ? entry.sourceCommit
              : undefined,
        });
      }
    } else if (isCopyTargetFileItemKind(kind)) {
      currentSha =
        entry.source === "data" && dataRepo && sourceCommitPresent !== false
          ? await shaOfInstalledSubagent(
              project,
              dataRepo,
              itemName,
              entry.sourceCommit,
            )
          : entryIdentity(entry);
    } else {
      throw new Error(`no status strategy for ${kind}/${itemName}`);
    }
    let fragmentOutputState: FragmentContributionState | null = null;
    if (source === "data" && isFragmentItemKind(kind)) {
      if (sourceCommitPresent === false) {
        currentSha = entryIdentity(entry);
      } else if (dataRepo) {
        const stateKey = `${rowScope}/${key}`;
        if (!fragmentStates.has(stateKey)) {
          fragmentStates.set(
            stateKey,
            await itemFragmentContributionState(
              project,
              dataRepo,
              manifest,
              lock,
              kind,
              itemName,
              entry,
            ),
          );
        }
        fragmentOutputState = fragmentStates.get(stateKey)!;
        currentSha =
          fragmentOutputState === "ok"
            ? entryIdentity(entry)
            : fragmentOutputState === "missing"
              ? null
              : "fragment-output-drift";
      } else {
        currentSha = entryIdentity(entry);
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
        );
        upstreamSha = upstream.upstreamSha;
        upstreamDirty = upstream.upstreamDirty;
        upstreamChanged =
          upstreamSha !== entryIdentity(entry) ||
          (entry.source === "data" &&
            upstream.sourceCommit !== null &&
            upstream.sourceCommit !== entry.sourceCommit);
        if (upstreamSha !== null || upstreamDirty) {
          try {
            currentNeeds = (
              await captureCommittedItemNeeds(dataRepo, {
                kind,
                name: itemName,
              })
            ).needs;
          } catch {
            currentNeeds = undefined;
          }
        }
      }
    } else {
      const sys = findSystemItem(itemName);
      upstreamSha =
        sys && sys.kind === kind ? await shaOfSystemItem(sys) : null;
      upstreamChanged = upstreamSha !== entryIdentity(entry);
    }

    // PIN-9 on the reporting path: one `check-attr` per item, against
    // the commit the pin names, so the verdict is identical in every
    // clone whether or not that clone holds the driver's key.
    const filteredPaths =
      treeIdentity &&
      entry.source === "data" &&
      dataRepo &&
      sourceCommitPresent !== false
        ? await filteredPathsForEntry(
            dataRepo,
            kind,
            itemName,
            entry.sourceCommit,
          )
        : [];
    const axes: StatusAxes | undefined =
      entry.source === "data" && treeIdentity
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
    // Coverage is read at the locked commit, never at the worktree, so
    // `status` describes what the project actually has. When it cannot
    // be read at all — no data repo, or an unreachable pin — the rows
    // degrade to `present: null` instead of the command crashing.
    let targetCoverage: TargetCoverageReport | null = null;
    if (entry.source !== "data") {
      targetCoverage = null;
    } else if (!dataRepo) {
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
      // `sourceCommitPresent` is already true here — it was probed at
      // the top of the row, before anything commit-dependent ran. Saying
      // so skips a second identical `git cat-file -e` per row.
      targetCoverage = await itemTargetCoverageAtCommit(
        project,
        dataRepo,
        kind,
        itemName,
        entry.sourceCommit,
        { commitKnownPresent: true },
      );
    }

    const subagentTargets =
      kind === "subagents" &&
      entry.source === "data" &&
      dataRepo &&
      sourceCommitPresent !== false &&
      // The locked commit resolves but its tree does not read.
      // `subagentSourcesAtCommit` cannot tell that from "this item has
      // no sources" and throws, which would exit the whole report;
      // `status` degrades instead, the way `describeInstallation`
      // already does for the same failure
      // (`src/install-identity.ts:107-111`). This is a gate rather than
      // a catch on purpose: a blob that fails to read *after* the tree
      // enumerated is a different state, one in which `apply` cannot run
      // either, and swallowing it would print an apparently healthy row.
      // `targets` is omitted rather than emptied, because an empty array
      // would claim the item has no targets — the false absence this
      // report exists to remove. `targetCoverage` says `unknown` beside
      // it.
      targetCoverage?.state !== "unknown"
        ? (
            await subagentTargetStatusAtCommit(
              project,
              dataRepo,
              itemName,
              entry.sourceCommit,
            )
          ).map((detail) => ({
            ...detail,
            outputPath: relative(project, detail.outputPath),
          }))
        : undefined;

    rows.push(
      buildStatusRow({
        scope: rowScope,
        source,
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

/**
 * The `--diff` comparisons for a set of rows, each path and view once.
 */
export async function collectStatusDiffs(
  input: StatusDiffsInput,
): Promise<StatusDiff[]> {
  const diffs: StatusDiff[] = [];
  const seenPaths = new Set<string>();
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
 * PIN-9 for one item at one commit. `status` calls this per row rather than
 * grouping by commit: a project's items rarely share a source commit, so the
 * grouping the spec's cost table describes would save nothing here — the
 * saving is in a multi-item `update`, which pins them all at once.
 */
async function filteredPathsForEntry(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<FilteredPath[]> {
  try {
    const entries = await itemTreeEntriesAtCommit(dataRepo, kind, name, commit);
    return await filteredPathsAtCommit(dataRepo, commit, [
      { kind, name, entries },
    ]);
  } catch {
    return [];
  }
}

/**
 * The Codex project-trust warning used to be emitted for every `mcp` item,
 * whatever its sources: a claude-only item warned about the harness it does
 * not reach, and said nothing about the one it does not cover.
 *
 * The gate may only *remove* a warning on evidence that the locked commit has
 * no Codex source. Unknown coverage falls back to today's behavior and emits,
 * so a degraded project never silently loses a warning.
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
): Promise<FragmentContributionState> {
  if (entry.source !== "data") return "ok";
  const targets = await lockedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
  );
  let state: FragmentContributionState = "ok";
  for (const target of targets) {
    const targetState = await fragmentContributionState(
      project,
      dataRepo,
      manifest,
      lock,
      target,
    );
    if (targetState === "missing") return "missing";
    if (targetState === "drifted") state = "drifted";
  }
  return state;
}
