import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { assertNever } from "./assert";
import {
  fragmentContributionState,
  isFragmentKind,
  lockedFragmentTargetsForItem,
} from "./fragments";
import type { FragmentContributionState, FragmentTarget } from "./fragments";
import { firstErrorLine } from "./errors";
import { commitExists, indexEntryFlags, statusPorcelainRecords } from "./git";
import { entryIdentity } from "./lock";
import type { DataLockEntryV4, WritableLock } from "./lock";
import { describeInstallation } from "./install-identity";
import { installedPath, itemOutputTargets, parseLockKey } from "./installed";
import type { Manifest } from "./manifest";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "./master";
import type { ItemKind } from "./master";
import { homeRelative } from "./paths";
import { sanitizeDisplayText } from "./pick-core";
import type { PickRow } from "./pick-core";
import { filteredPathsAtCommit, itemTreeEntriesAtCommit } from "./pin";
import { gitTreeSource } from "./item-source";
import { deriveState } from "./status-core";
import type { State } from "./status-core";
import { upstreamFactsForItem } from "./upstream-facts";

export type PromoteDisposition =
  | { offered: true; reason?: undefined }
  | { offered: false; reason: string };

export function promoteRowDisposition(state: State): PromoteDisposition {
  switch (state) {
    case "drifted_local":
    case "drifted_and_update":
    case "source_dirty":
    case "source_dirty_and_output_drift":
      return { offered: true };
    case "ok":
      return { offered: false, reason: "nothing to promote" };
    case "output_drift":
      return { offered: false, reason: "run capshelf apply, not promote" };
    case "kept-local":
      return { offered: false, reason: "promote refuses a keep-local item" };
    case "update_available":
      return { offered: false, reason: "run capshelf update, not promote" };
    case "missing_output":
      return { offered: false, reason: "output missing — run capshelf apply" };
    case "missing_installed":
      return {
        offered: false,
        reason: "installed files missing — run capshelf apply",
      };
    case "missing_upstream":
      return { offered: false, reason: "not in the data repo" };
    case "upstream_dirty":
    case "drifted_and_upstream_dirty":
      return {
        offered: false,
        reason: "the data repo copy has uncommitted changes",
      };
    case "missing_source_commit":
      return {
        offered: false,
        reason: "locked commit unreachable — run capshelf update",
      };
    case "source_filtered":
      return {
        offered: false,
        reason: "a source path uses an external git filter",
      };
    default:
      return assertNever(state);
  }
}

export interface PromoteCatalog {
  rows: PickRow[];
}

export interface LoadPromoteCatalogOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: WritableLock;
  scope: "project" | "local";
}

export async function loadPromoteCatalog(
  opts: LoadPromoteCatalogOptions,
): Promise<PromoteCatalog> {
  const items = Object.keys(opts.lock.items)
    .map((key) => ({ key, ...parseLockKey(key) }))
    .filter((item) => item.source === "data");

  // One batched `git ls-files -v` for all items: an index flag or ignore rule
  // makes `git status` blind to real changes, and the ignore probe skips copy
  // items because their file set cannot be enumerated.
  const { hidden, ignoredHidden } = await gitBlindSpots(
    opts.dataRepo,
    items.flatMap((item) => allCanonicalItemRelPaths(item.kind, item.name)),
    items
      .filter((item) => !isCopyDirectoryItemKind(item.kind))
      .flatMap((item) => allCanonicalItemRelPaths(item.kind, item.name)),
  );

  // Fragment contribution is a property of the target, not the item, so one
  // cached answer per target serves every item in this load.
  const contributionCache: FragmentContributionCache = new Map();
  const rows = await Promise.all(
    items.map((item) =>
      catalogRow(opts, item, hidden, ignoredHidden, contributionCache),
    ),
  );
  return { rows: rows.filter((row): row is PickRow => row !== null) };
}

async function catalogRow(
  opts: LoadPromoteCatalogOptions,
  item: { key: string; kind: ItemKind; name: string },
  hidden: readonly string[],
  ignoredHidden: ReadonlySet<string>,
  contributionCache: FragmentContributionCache,
): Promise<PickRow | null> {
  const { kind, name, key } = item;
  const entry = opts.lock.items[key];
  if (entry?.source !== "data") return null;
  // Per item, not all-or-nothing: deriving one item's state can throw for
  // item-specific reasons, and that must not block promoting unrelated items.
  let state: State;
  try {
    state = await itemState(opts, kind, name, entry, contributionCache);
  } catch (error) {
    return {
      ref: `${kind}/${name}`,
      kind,
      name,
      tags: [],
      installed: false,
      disabled: true,
      detail: sanitizeDisplayText(
        `state unavailable: ${firstErrorLine(error)}`,
      ),
    };
  }
  const disposition = promoteRowDisposition(state);

  // A path git is not watching disables the row in every state: `git status`
  // cannot see it, so "nothing to promote" would be wrong and a promote would
  // discard the hidden edit.
  const unwatched = unwatchedPaths(kind, name, hidden, ignoredHidden);
  let detail: string;
  if (unwatched.length > 0) {
    detail = `git is not watching ${unwatched.join(", ")}`;
  } else if (disposition.offered) {
    detail = await offeredDetail(opts, kind, name, state);
  } else {
    detail = disposition.reason;
  }

  const row: PickRow = {
    ref: `${kind}/${name}`,
    kind,
    name,
    tags: [],
    installed: false,
  };
  if (!(disposition.offered && unwatched.length === 0)) row.disabled = true;
  row.detail = sanitizeDisplayText(detail);
  return row;
}

/**
 * Untracked files under an ignore rule are silent in `git status` and refused
 * by `git add`, so promote cannot publish them; ordinary untracked files show
 * as `??` and promote normally.
 */
async function gitBlindSpots(
  dataRepo: string,
  flagPaths: readonly string[],
  probePaths: readonly string[],
): Promise<{ hidden: string[]; ignoredHidden: Set<string> }> {
  const flags = await indexEntryFlags(dataRepo, [...flagPaths]);
  const tracked = new Set(flags.map((entry) => entry.path));
  const hidden = flags
    .filter((entry) => entry.assumeUnchanged || entry.skipWorktree)
    .map((entry) => entry.path);
  const untrackedPresent = probePaths.filter(
    (relPath) =>
      !tracked.has(relPath) &&
      existsSync(join(dataRepo, ...relPath.split("/"))),
  );
  const reported = new Set(
    untrackedPresent.length > 0
      ? (
          await statusPorcelainRecords(dataRepo, untrackedPresent, {
            untrackedFiles: "all",
          })
        ).map((record) => record.path)
      : [],
  );
  return {
    hidden,
    ignoredHidden: new Set(
      untrackedPresent.filter((relPath) => !reported.has(relPath)),
    ),
  };
}

/**
 * The batched answer goes stale while the picker holds the terminal, so the
 * interactive loop re-reads it per marked item just before acting. This narrows
 * the window but does not close it, because the promote transaction does not
 * enforce it.
 */
export async function unwatchedPathsForItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string[]> {
  const canonical = allCanonicalItemRelPaths(kind, name);
  const { hidden, ignoredHidden } = await gitBlindSpots(
    dataRepo,
    canonical,
    isCopyDirectoryItemKind(kind) ? [] : canonical,
  );
  return unwatchedPaths(kind, name, hidden, ignoredHidden);
}

/**
 * Ignored untracked files under a copy item's directory are out of scope:
 * promote replaces the directory wholesale and junk like `.DS_Store` would
 * disable nearly every copy row.
 */
function unwatchedPaths(
  kind: ItemKind,
  name: string,
  hidden: readonly string[],
  ignoredHidden: ReadonlySet<string>,
): string[] {
  const canonical = allCanonicalItemRelPaths(kind, name);
  const flagged = hidden.filter((path) =>
    canonical.some(
      (relPath) => path === relPath || path.startsWith(`${relPath}/`),
    ),
  );
  if (isCopyDirectoryItemKind(kind)) return flagged;
  const ignored = canonical.filter((relPath) => ignoredHidden.has(relPath));
  return [...new Set([...flagged, ...ignored])];
}

type FragmentContributionCache = Map<
  FragmentTarget,
  Promise<FragmentContributionState>
>;

async function itemState(
  opts: LoadPromoteCatalogOptions,
  kind: ItemKind,
  name: string,
  entry: DataLockEntryV4,
  contributionCache: FragmentContributionCache,
): Promise<State> {
  const lockedSha = entryIdentity(entry);
  const sourceCommitPresent = await commitExists(
    opts.dataRepo,
    entry.sourceCommit,
  );

  let currentSha: string | null;
  let fragmentOutputState: FragmentContributionState | null = null;
  if (isFragmentItemKind(kind)) {
    if (!sourceCommitPresent) {
      currentSha = lockedSha;
    } else {
      fragmentOutputState = await itemFragmentContributionState(
        opts,
        kind,
        name,
        entry,
        contributionCache,
      );
      currentSha =
        fragmentOutputState === "ok"
          ? lockedSha
          : fragmentOutputState === "missing"
            ? null
            : "fragment-output-drift";
    }
  } else {
    const installation = sourceCommitPresent
      ? await describeInstallation(
          opts.project,
          gitTreeSource({
            repo: opts.dataRepo,
            kind,
            name,
            commit: entry.sourceCommit,
          }),
          kind,
          name,
          opts.scope,
        )
      : null;
    currentSha = installation?.currentSha ?? null;
  }

  const upstream = await upstreamFactsForItem(
    opts.dataRepo,
    kind,
    name,
    "tree",
  );
  const upstreamChanged =
    upstream.upstreamSha !== lockedSha ||
    (upstream.sourceCommit !== null &&
      upstream.sourceCommit !== entry.sourceCommit);

  return deriveState({
    kind,
    source: "data",
    local: entry.local === true,
    lockedSha,
    currentSha,
    upstreamSha: upstream.upstreamSha,
    upstreamDirty: upstream.upstreamDirty,
    upstreamChanged,
    fragmentOutputState,
    sourceCommitPresent,
    sourceFiltered: await sourceFiltered(opts, kind, name, entry.sourceCommit),
  });
}

async function itemFragmentContributionState(
  opts: LoadPromoteCatalogOptions,
  kind: Extract<ItemKind, "settings" | "mcp" | "codex-config">,
  name: string,
  entry: DataLockEntryV4,
  cache: FragmentContributionCache,
): Promise<FragmentContributionState> {
  const targets = await lockedFragmentTargetsForItem(
    opts.dataRepo,
    kind,
    name,
    entry,
    opts.manifest,
  );
  let state: FragmentContributionState = "ok";
  for (const target of targets) {
    let pending = cache.get(target);
    if (!pending) {
      pending = fragmentContributionState(
        opts.project,
        opts.dataRepo,
        opts.manifest,
        opts.lock,
        target,
      );
      cache.set(target, pending);
    }
    const targetState = await pending;
    if (targetState === "missing") return "missing";
    if (targetState === "drifted") state = "drifted";
  }
  return state;
}

async function sourceFiltered(
  opts: LoadPromoteCatalogOptions,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<boolean> {
  try {
    const entries = await itemTreeEntriesAtCommit(
      gitTreeSource({ repo: opts.dataRepo, kind, name, commit }),
      kind,
    );
    return (
      (
        await filteredPathsAtCommit(opts.dataRepo, commit, [
          { kind, name, entries },
        ])
      ).length > 0
    );
  } catch {
    return false;
  }
}

async function offeredDetail(
  opts: LoadPromoteCatalogOptions,
  kind: ItemKind,
  name: string,
  state: State,
): Promise<string> {
  if (state === "source_dirty" || state === "source_dirty_and_output_drift") {
    const dirty = (
      await statusPorcelainRecords(
        opts.dataRepo,
        allCanonicalItemRelPaths(kind, name),
      )
    ).map((record) => record.path);
    const shelf = homeRelative(opts.dataRepo);
    const files =
      dirty.length > 0
        ? dirty.map((path) => `${shelf}/${path}`).join(", ")
        : shelf;
    const suffix =
      state === "source_dirty_and_output_drift" ? " · output drifted" : "";
    return `edit ${files}${suffix}`;
  }
  const suffix = state === "drifted_and_update" ? " · upstream moved" : "";
  return `edited ${installedLabel(opts.project, kind, name)}${suffix}`;
}

function installedLabel(project: string, kind: ItemKind, name: string): string {
  if (isCopyTargetFileItemKind(kind)) {
    const outputs = itemOutputTargets(project, kind, name)
      .filter((target) => existsSync(target.outputPath))
      .map((target) => relative(project, target.outputPath));
    return outputs.length > 0 ? outputs.join(", ") : `${kind}/${name}`;
  }
  if (isFragmentKind(kind)) {
    // Defensive label only: `drifted_local` cannot derive for a fragment kind.
    return `${kind}/${name}`;
  }
  return relative(project, installedPath(project, kind, name));
}
