import type { ItemKind } from "./master";
import { isFragmentItemKind } from "./master";
import type { ItemSource } from "./installed";
import type { Lock, LockEntry } from "./lock";
import type { ItemRef } from "./item-ref";
import { lockKeysForRef } from "./item-ref";
import type { RuntimeWarning } from "./runtime-warnings";
import type { FragmentContributionState } from "./fragments";

export type State =
  | "ok"
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

export interface StatusRow {
  scope: "project" | "local";
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: State;
  lockedSha: string;
  currentSha: string | null;
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
  upstreamSha: string | null;
  upstreamDirty: boolean;
  fragmentOutputState: FragmentContributionState | null;
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
    return f.currentSha !== f.lockedSha
      ? "drifted_and_upstream_dirty"
      : "upstream_dirty";
  }
  if (f.upstreamSha === null) return "missing_upstream";
  const drifted = f.currentSha !== f.lockedSha;
  const update = f.upstreamSha !== f.lockedSha;
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
  runtimeWarnings: RuntimeWarning[];
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
    lockedSha: entry.sha,
    currentSha: input.currentSha,
    upstreamSha: input.upstreamSha,
    ...(input.upstreamDirty && { upstreamDirty: input.upstreamDirty }),
    ...(entry.source === "data" && {
      sourceCommit: entry.sourceCommit,
      ...(entry.local === true && { local: true as const }),
      ...(entry.localReason !== undefined && {
        localReason: entry.localReason,
      }),
      ...(entry.label !== undefined && { label: entry.label }),
    }),
    ...(entry.source === "system" && {
      cliVersion: entry.cliVersion,
    }),
    ...runtimeWarningFields(input.runtimeWarnings),
  };
}

export function statusTargets(
  projectLock: Lock,
  localLock: Lock,
  ref: ItemRef | undefined,
  opts: { project?: boolean; local?: boolean },
): Array<{ scope: "project" | "local"; key: string }> {
  const includeProject = !opts.local;
  const includeLocal = !opts.project;
  const projectKeys = ref
    ? lockKeysForRef(projectLock, ref)
    : Object.keys(projectLock.items);
  const localKeys = ref
    ? lockKeysForRef(localLock, ref)
    : Object.keys(localLock.items);
  return [
    ...(includeProject
      ? projectKeys.map((key) => ({ scope: "project" as const, key }))
      : []),
    ...(includeLocal
      ? localKeys.map((key) => ({ scope: "local" as const, key }))
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
  throw new Error(
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
