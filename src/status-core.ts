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

/*
 * PIN-6 axes. `status` reports pin, source, and installation separately and
 * derives one headline from them. A precedence chain evaluated in place would
 * report whichever condition it tested first and lose the more actionable one,
 * so `--json` always carries all three and a script never loses one to a rule.
 *
 * Deviation from the spec, recorded here because the name matters to
 * consumers: the spec calls the second axis `source`, but `StatusRow.source`
 * already means the entry's origin (`data` | `system`) and predates this
 * design. The axis is `sourceState` in the row and in `--json`; reusing
 * `source` would silently change the meaning of an existing field.
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

export interface StatusRow {
  scope: "project" | "local";
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: State;
  lockedSha: string;
  currentSha: string | null;
  /** Executable modes differ even when the byte-only lock sha is unchanged. */
  modeDrifted?: boolean;
  /** PIN-6: the three axes, evaluated independently. */
  pin?: PinAxis;
  sourceState?: SourceAxis;
  installation?: InstallationAxis;
  /** What kind of difference each drifted path carries (PIN-6 stage 2). */
  installDifferences?: InstallDifference[];
  /** Managed paths that declare an external filter driver (PIN-9). */
  filteredPaths?: FilteredPath[];
  /** master sha (data) or bundled sha (system); null if upstream is gone */
  upstreamSha: string | null;
  /** true when the data-repo item path has uncommitted changes */
  upstreamDirty?: boolean;
  /** for data items, the recorded source commit */
  sourceCommit?: string;
  local?: true;
  localReason?: string;
  /** for system items, the cliVersion that wrote the entry */
  cliVersion?: string;
  label?: string;
  runtimeWarnings?: RuntimeWarning[];
  /** Orthogonal freshness of the lock-pinned needs declaration. */
  needsState?: NeedsState;
  /** Present for every data row; null means a migrated v2 snapshot. */
  lockedNeeds?: ItemNeeds | null;
  targets?: StatusTargetDetail[];
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
  /** lock entry source ("data" | "system") */
  source: ItemSource;
  /** true only for a data entry pinned local (kept-local) */
  local: boolean;
  /** the sha recorded in the lock (entry.sha) */
  lockedSha: string;
  currentSha: string | null;
  /** Executable modes differ even when the byte-only lock sha is unchanged. */
  modeDrifted?: boolean;
  upstreamSha: string | null;
  upstreamDirty: boolean;
  /** Upstream bytes or last-touching commit differ from the lock. */
  upstreamChanged?: boolean;
  fragmentOutputState: FragmentContributionState | null;
  /**
   * Whether the data entry's locked `sourceCommit` is reachable in the data
   * repo. `null` (or omitted) means "not applicable or not checkable" (system
   * items, no data repo resolved) and is treated as present, which keeps
   * existing callers backwards compatible.
   */
  sourceCommitPresent?: boolean | null;
  /** PIN-9: a managed path declares an external filter driver. */
  sourceFiltered?: boolean;
}

/**
 * Pure status state machine: given the SHAs and flags gathered for one tracked
 * item, decide its drift/update state. Extracted verbatim from the status loop
 * so it can be exhaustively unit-tested without touching git or the filesystem.
 */
export function deriveState(f: StateFacts): State {
  if (f.source === "data" && f.local && f.currentSha !== null) {
    return "kept-local";
  }
  // Ahead of every other condition, because a filtered source makes a re-pin
  // pointless: every consumer would receive the placeholder Git stores, so
  // there is nothing else worth acting on until it is fixed upstream.
  if (f.sourceFiltered === true) return "source_filtered";
  // After kept-local (an explicit user pin keeps its strict exemption),
  // before all upstream/drift comparisons — those are unreliable when the
  // pinned provenance is gone (e.g. squash-orphaned or unpushed elsewhere).
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
  filteredPaths?: FilteredPath[];
}

export interface BuildStatusRowInput {
  scope: "project" | "local";
  source: ItemSource;
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
  axes?: StatusAxes;
}

/** Pure assembly of a StatusRow from a lock entry and the computed facts. */
export function buildStatusRow(input: BuildStatusRowInput): StatusRow {
  const { scope, source, kind, name, entry, state } = input;
  return {
    scope,
    source,
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
  // Status lists every match (it never requires a unique target), so it uses
  // the shared ref matcher for the ref case and enumerates all keys otherwise.
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
