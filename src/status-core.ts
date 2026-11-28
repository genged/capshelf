import type { ItemKind } from "./master";
import { isFragmentItemKind } from "./master";
import { PreconditionError } from "./errors";
import type { ItemSource } from "./installed";
import type { Lock, LockEntry } from "./lock";
import type { ItemRef } from "./item-ref";
import { matchRefAcrossScopes } from "./targets";
import type { ScopedTarget } from "./targets";
import type { RuntimeWarning } from "./runtime-warnings";
import type { FragmentContributionState } from "./fragments";
import { entryIdentity, needsEqual } from "./lock";
import type { ItemNeeds } from "./metadata";
import type { InstallationAxis } from "./install-identity";
import type { InstallDifference } from "./install-diff";
import type { FilteredPath } from "./pin";
import type { PluginRunCounts } from "./plugin-runs";
import type { ClaudeTrust } from "./claude-trust";
import type { SkillInvocations } from "./skill-invocations";
import type {
  TargetCoverageFields,
  TargetCoverageJson,
} from "./target-coverage";

/**
 * Axes are reported separately so a precedence chain doesn't hide the more
 * actionable condition; the second axis is `sourceState` because
 * `StatusRow.source` already means entry origin.
 */
export type PinAxis = "valid" | "mismatch" | "unresolvable";
export type SourceAxis = "exact" | "filtered" | "dirty";
export type { InstallationAxis } from "./install-identity";

export type State =
  | "ok"
  | "source_filtered"
  | "missing_source_commit"
  | "update_available"
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "missing_output"
  | "missing_upstream"
  | "upstream_dirty"
  | "source_dirty"
  | "drifted_and_upstream_dirty"
  | "output_drift"
  | "source_dirty_and_output_drift"
  | "kept-local";

export type NeedsState =
  | "current"
  | "update_available"
  | "unknown"
  | "unavailable";

/**
 * `ItemSource` is a lock key prefix and remote skills live in a different
 * document, so only the reporting row widens to include `remote`.
 */
export type RowSource = ItemSource | "remote";

export interface RemoteRowFacts {
  upstream: string;
  ref: string;
  subpath: string;
  lastChecked: string | null;
  upstreamHead: string | null;
  /**
   * Machine state, not project state: it decides what the row can measure, not
   * what the project owns.
   */
  cachePresent: boolean;
  alsoTrackedInShelf: boolean;
}

export type StatusRowRuns = PluginRunCounts;

export interface StatusRow {
  scope: "project" | "local";
  source: RowSource;
  remote?: RemoteRowFacts;
  runs?: StatusRowRuns;
  claudeTrust?: ClaudeTrust;
  kind: ItemKind;
  name: string;
  state: State;
  lockedSha: string;
  currentSha: string | null;
  /**
   * Executable-mode changes don't alter the byte-only lock sha, so they are
   * tracked separately.
   */
  modeDrifted?: boolean;
  pin?: PinAxis;
  sourceState?: SourceAxis;
  installation?: InstallationAxis;
  installDifferences?: InstallDifference[];
  visibleExtras?: string[];
  filteredPaths?: FilteredPath[];
  upstreamSha: string | null;
  upstreamDirty?: boolean;
  sourceCommit?: string;
  local?: true;
  localReason?: string;
  cliVersion?: string;
  label?: string;
  runtimeWarnings?: RuntimeWarning[];
  needsState?: NeedsState;
  lockedNeeds?: ItemNeeds | null;
  targets?: StatusTargetDetail[];
  targetCoverage?: TargetCoverageJson[];
  coverageState?: "unknown";
  coverageReason?: string;
  /**
   * Present on a skill row only when Claude Code transcripts exist for the
   * project, so a machine without them prints the same report as before.
   */
  invocations?: SkillInvocations;
}

export interface StatusTargetDetail {
  target: string;
  sourcePath: string;
  outputPath: string;
  state: "ok" | "missing" | "drifted";
}

export interface ExternalPersonalClaudeSkill {
  kind: "skills";
  name: string;
  path: string;
  warning: RuntimeWarning;
}

export interface StateFacts {
  kind: ItemKind;
  /**
   * A remote row passes `"data"` because it has a real upstream, so existing
   * drift and update logic applies unchanged.
   */
  source: ItemSource;
  local: boolean;
  lockedSha: string;
  currentSha: string | null;
  /**
   * Track executable modes separately because the byte-only lock sha excludes
   * them.
   */
  modeDrifted?: boolean;
  upstreamSha: string | null;
  upstreamDirty: boolean;
  upstreamChanged?: boolean;
  fragmentOutputState: FragmentContributionState | null;
  sourceCommitPresent?: boolean | null;
  sourceFiltered?: boolean;
}

export function deriveState(f: StateFacts): State {
  if (f.source === "data" && f.local && f.currentSha !== null) {
    return "kept-local";
  }
  // Checked right after kept-local and ahead of every other condition: a
  // filtered source makes a re-pin pointless since consumers would receive
  // Git's placeholder.
  if (f.sourceFiltered === true) return "source_filtered";
  // Runs before upstream/drift comparisons, which are unreliable once the
  // pinned provenance is gone; kept-local stays exempt.
  if (f.source === "data" && f.sourceCommitPresent === false) {
    return "missing_source_commit";
  }
  if (isFragmentItemKind(f.kind) && f.upstreamDirty) {
    return f.fragmentOutputState === "drifted" ||
      f.fragmentOutputState === "missing"
      ? "source_dirty_and_output_drift"
      : "source_dirty";
  }
  if (isFragmentItemKind(f.kind) && f.fragmentOutputState === "missing") {
    return "missing_output";
  }
  if (isFragmentItemKind(f.kind) && f.fragmentOutputState === "drifted") {
    return f.upstreamSha !== null && f.upstreamSha !== f.lockedSha
      ? "drifted_and_update"
      : "output_drift";
  }
  if (f.currentSha === null) return "missing_installed";
  if (f.upstreamDirty) {
    return f.currentSha !== f.lockedSha || f.modeDrifted === true
      ? "drifted_and_upstream_dirty"
      : "upstream_dirty";
  }
  if (f.upstreamSha === null) return "missing_upstream";
  const drifted = f.currentSha !== f.lockedSha || f.modeDrifted === true;
  const update = f.upstreamChanged ?? f.upstreamSha !== f.lockedSha;
  if (drifted && update) return "drifted_and_update";
  if (drifted) return "drifted_local";
  if (update) return "update_available";
  return "ok";
}

export function runtimeWarningFields(
  runtimeWarnings: RuntimeWarning[],
): Pick<StatusRow, "runtimeWarnings"> {
  return runtimeWarnings.length > 0 ? { runtimeWarnings } : {};
}

export interface StatusAxes {
  pin: PinAxis;
  sourceState: SourceAxis;
  installation?: InstallationAxis;
  installDifferences?: InstallDifference[];
  visibleExtras?: string[];
  filteredPaths?: FilteredPath[];
}

export interface BuildStatusRowInput {
  scope: "project" | "local";
  source: RowSource;
  remote?: RemoteRowFacts;
  runs?: StatusRowRuns;
  claudeTrust?: ClaudeTrust;
  kind: ItemKind;
  name: string;
  entry: LockEntry;
  state: State;
  currentSha: string | null;
  upstreamSha: string | null;
  upstreamDirty: boolean;
  modeDrifted?: boolean;
  runtimeWarnings: RuntimeWarning[];
  needsState?: NeedsState;
  targets?: StatusTargetDetail[];
  coverage?: TargetCoverageFields;
  axes?: StatusAxes;
}

export function buildStatusRow(input: BuildStatusRowInput): StatusRow {
  const { scope, source, kind, name, entry, state } = input;
  return {
    scope,
    source,
    ...(input.remote !== undefined && { remote: input.remote }),
    ...(input.runs !== undefined && { runs: input.runs }),
    ...(input.claudeTrust !== undefined && { claudeTrust: input.claudeTrust }),
    kind,
    name,
    state,
    lockedSha: entryIdentity(entry),
    currentSha: input.currentSha,
    upstreamSha: input.upstreamSha,
    ...(input.modeDrifted && { modeDrifted: true }),
    ...(input.upstreamDirty && { upstreamDirty: input.upstreamDirty }),
    ...(entry.source === "data" && {
      sourceCommit: entry.sourceCommit,
      needsState: input.needsState ?? "unavailable",
      lockedNeeds: entry.needs ?? null,
      ...(entry.local === true && { local: true as const }),
      ...(entry.localReason !== undefined && {
        localReason: entry.localReason,
      }),
      ...(entry.label !== undefined && { label: entry.label }),
    }),
    ...(entry.source === "system" && {
      cliVersion: entry.cliVersion,
    }),
    ...(input.targets !== undefined && { targets: input.targets }),
    ...(input.coverage !== undefined && input.coverage),
    ...(input.axes !== undefined && {
      pin: input.axes.pin,
      sourceState: input.axes.sourceState,
      ...(input.axes.installation !== undefined && {
        installation: input.axes.installation,
      }),
      ...(input.axes.installDifferences !== undefined &&
        input.axes.installDifferences.length > 0 && {
          installDifferences: input.axes.installDifferences,
        }),
      ...(input.axes.visibleExtras !== undefined &&
        input.axes.visibleExtras.length > 0 && {
          visibleExtras: input.axes.visibleExtras,
        }),
      ...(input.axes.filteredPaths !== undefined &&
        input.axes.filteredPaths.length > 0 && {
          filteredPaths: input.axes.filteredPaths,
        }),
    }),
    ...runtimeWarningFields(input.runtimeWarnings),
  };
}

export function deriveNeedsState(
  locked: ItemNeeds | null,
  current: ItemNeeds | undefined,
): NeedsState {
  if (locked === null) return "unknown";
  if (current === undefined) return "unavailable";
  return needsEqual(locked, current) ? "current" : "update_available";
}

export function statusTargets(
  projectLock: Lock,
  localLock: Lock,
  ref: ItemRef | undefined,
  opts: { project?: boolean; local?: boolean },
): ScopedTarget[] {
  if (ref) return matchRefAcrossScopes(projectLock, localLock, ref, opts);
  const includeProject = !opts.local;
  const includeLocal = !opts.project;
  return [
    ...(includeProject
      ? Object.keys(projectLock.items).map((key) => ({
          scope: "project" as const,
          key,
        }))
      : []),
    ...(includeLocal
      ? Object.keys(localLock.items).map((key) => ({
          scope: "local" as const,
          key,
        }))
      : []),
  ];
}

export function assertNoScopeCollisions(
  projectLock: Lock,
  localLock: Lock,
  action = "checking status",
): void {
  const projectKeys = new Set(Object.keys(projectLock.items));
  const collisions = Object.keys(localLock.items).filter((key) =>
    projectKeys.has(key),
  );
  if (collisions.length === 0) return;
  throw new PreconditionError(
    `item is owned by both project and local scope: ${collisions.join(", ")}\n` +
      `  remove one owner before ${action}; local scope does not shadow project scope`,
  );
}

export function personalClaudeExternals(
  rows: StatusRow[],
): ExternalPersonalClaudeSkill[] {
  const out: ExternalPersonalClaudeSkill[] = [];
  for (const row of rows) {
    if (row.kind !== "skills") continue;
    for (const warning of row.runtimeWarnings ?? []) {
      if (warning.type !== "shadowed_by_personal_claude_skill") continue;
      out.push({
        kind: "skills",
        name: row.name,
        path: warning.path,
        warning,
      });
    }
  }
  return out;
}
