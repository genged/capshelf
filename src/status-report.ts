import { existsSync } from "node:fs";
import { resolveDataRepoOptional } from "./paths";
import { loadLocalLock, loadLock } from "./lock";
import type { Lock, LockEntry } from "./lock";
import { loadManifest } from "./manifest";
import type { Manifest } from "./manifest";
import type { ItemKind } from "./master";
import { isFragmentItemKind, shaOfItem } from "./master";
import { installedPath, shaOfInstalled, parseLockKey } from "./installed";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "./bundled";
import type { ItemRef } from "./item-ref";
import { commitExists, isGitRepo } from "./git";
import { upstreamFactsForItem } from "./upstream-facts";
import { listClaudePlugins, listSkillsShSkills } from "./external";
import { buildStatusDiff, currentCopyItemSha } from "./status-diff";
import type { StatusDiff } from "./status-diff";
import {
  codexProjectTrustWarnings,
  runtimeWarningsForItem,
} from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import {
  fragmentContributionState,
  lockedFragmentTargetsForItem,
  type FragmentContributionState,
} from "./fragments";
import {
  assertNoScopeCollisions,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type ExternalPersonalClaudeSkill,
  type StatusRow,
} from "./status-core";

export interface StatusScopeOptions {
  project?: boolean;
  local?: boolean;
  diff?: boolean;
}

export interface StatusReport {
  project: string;
  dataRepo: string | null;
  cliVersion: string;
  count: number;
  items: StatusRow[];
  diffs?: StatusDiff[];
  external: Awaited<ReturnType<typeof listSkillsShSkills>>;
  externalClaudePlugins: Awaited<ReturnType<typeof listClaudePlugins>>;
  personalClaudeExternal: ExternalPersonalClaudeSkill[];
}

/**
 * Compute the full drift/update report for a project. This is the shared
 * source of truth for both the `status` CLI command and the `serve` HTTP API,
 * so the two can never disagree. It performs the same gathering the command
 * always did (extracted verbatim); printing, strict-exit handling, and ref
 * parsing stay with the caller.
 */
export async function buildStatusReport(args: {
  project: string;
  dataOverride?: string;
  ref?: ItemRef;
  opts: StatusScopeOptions;
}): Promise<StatusReport> {
  const { project, dataOverride, ref, opts } = args;
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  const localLock = await loadLocalLock(project);
  assertNoScopeCollisions(projectLock, localLock);

  // Status still produces a report when the data repo isn't configured or has
  // gone missing on disk: data items report missing_upstream instead of
  // crashing. Treating a configured-but-absent path as null degrades both
  // fragment and copy items uniformly, and lets the per-item master/git calls
  // surface genuine errors (ambiguous refs, permission failures) instead of
  // swallowing them.
  const resolvedDataRepo = await resolveDataRepoOptional({
    override: dataOverride,
    manifest,
    project,
  });
  // A bound path that is not a git repo degrades like a missing one (rows
  // report missing_upstream) instead of crashing on raw git errors during
  // per-item upstream checks.
  const dataRepo =
    resolvedDataRepo &&
    existsSync(resolvedDataRepo) &&
    (await isGitRepo(resolvedDataRepo))
      ? resolvedDataRepo
      : null;

  const targets = statusTargets(projectLock, localLock, ref, opts);
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
  const externalSkillNames = new Set(external.map((skill) => skill.name));

  const rows: StatusRow[] = [];
  const fragmentStates = new Map<string, FragmentContributionState>();
  for (const target of targets) {
    const { scope, key } = target;
    const lock = scope === "local" ? localLock : projectLock;
    const { source, kind, name: itemName } = parseLockKey(key);
    if (kind === "skills" && externalSkillNames.has(itemName)) continue;

    const entry = lock.items[key]!;
    // Reachability must be gathered before computing currentSha: the
    // sourceCommit-dependent computations below (`git show` / `ls-tree` at the
    // pinned commit) would error out on an unreachable pin. When the commit is
    // missing they are skipped and the row degrades to missing_source_commit
    // instead of crashing.
    const sourceCommitPresent: boolean | null =
      entry.source === "data" && dataRepo
        ? await commitExists(dataRepo, entry.sourceCommit)
        : null;
    let currentSha = isFragmentItemKind(kind)
      ? await currentInstalledSha(project, kind, itemName, scope)
      : await currentCopyItemSha({
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
    let fragmentOutputState: FragmentContributionState | null = null;
    if (source === "data" && isFragmentItemKind(kind)) {
      if (sourceCommitPresent === false) {
        currentSha = entry.sha;
      } else if (dataRepo) {
        const stateKey = `${scope}/${key}`;
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
            ? entry.sha
            : fragmentOutputState === "missing"
              ? null
              : "fragment-output-drift";
      } else {
        currentSha = entry.sha;
      }
    }

    let upstreamSha: string | null = null;
    let upstreamDirty = false;
    if (source === "data") {
      if (dataRepo) {
        const upstream = await upstreamFactsForItem(dataRepo, kind, itemName);
        upstreamSha = upstream.upstreamSha;
        upstreamDirty = upstream.upstreamDirty;
      }
    } else {
      const sys = findSystemItem(itemName);
      upstreamSha =
        sys && sys.kind === kind ? await shaOfSystemItem(sys) : null;
    }

    const state = deriveState({
      kind,
      source: entry.source,
      local: entry.source === "data" && entry.local === true,
      lockedSha: entry.sha,
      currentSha,
      upstreamSha,
      upstreamDirty,
      fragmentOutputState,
      sourceCommitPresent,
    });

    rows.push(
      buildStatusRow({
        scope,
        source,
        kind,
        name: itemName,
        entry,
        state,
        currentSha,
        upstreamSha,
        upstreamDirty,
        runtimeWarnings: [
          ...runtimeWarningsForItem(project, kind, itemName),
          ...codexWarningsForItem(project, kind),
        ],
      }),
    );
  }

  const personalClaudeExternal = personalClaudeExternals(rows);

  let diffs: StatusDiff[] | undefined;
  if (opts.diff) {
    diffs = [];
    const seenPaths = new Set<string>();
    for (const row of rows) {
      const rowLock = row.scope === "local" ? localLock : projectLock;
      const diff = await buildStatusDiff({
        project,
        dataRepo,
        manifest,
        lock: rowLock,
        row,
      });
      if (!diff || seenPaths.has(diff.path)) continue;
      seenPaths.add(diff.path);
      diffs.push(diff);
    }
  }

  return {
    project,
    dataRepo,
    cliVersion: CLI_VERSION,
    count: rows.length,
    items: rows,
    ...(opts.diff && { diffs }),
    external,
    externalClaudePlugins,
    personalClaudeExternal,
  };
}

async function currentInstalledSha(
  project: string,
  kind: ItemKind,
  name: string,
  scope: "project" | "local",
): Promise<string | null> {
  if (scope === "local" && kind === "skills") {
    const path = installedPath(project, kind, name);
    return existsSync(path) ? await shaOfItem(path) : null;
  }
  return await shaOfInstalled(project, kind, name);
}

function codexWarningsForItem(
  project: string,
  kind: ItemKind,
): RuntimeWarning[] {
  if (kind !== "mcp" && kind !== "codex-config") return [];
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
