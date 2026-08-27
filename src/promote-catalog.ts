/**
 * The promote picker's catalog: one row per tracked data item, marked
 * promotable or not by the same state machine `status` reports.
 *
 * The states come from `deriveState` (`status-core.ts`), and the facts feeding
 * it come from the helpers `status` itself reads (`upstreamFactsForItem`,
 * `describeInstallation`, `fragmentContributionState`), so the picker and the
 * report cannot disagree about what a state means. `promoteRowDisposition` is
 * the pure half: which states offer a row and which disable it, exhaustively.
 *
 * A disabled row stays visible and names its reason in the detail column. The
 * detail is where this picker earns its place: it names the file behind the
 * state, so a user who edited `.mcp.json` and expected a promote reads which
 * canonical source `promote` actually publishes.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { assertNever } from "./assert";
import {
  fragmentContributionState,
  isFragmentKind,
  lockedFragmentTargetsForItem,
} from "./fragments";
import type { FragmentContributionState } from "./fragments";
import { commitExists, indexEntryFlags, statusPorcelainRecords } from "./git";
import { entryIdentity } from "./lock";
import type { DataLockEntryV4, LockV4 } from "./lock";
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
import { deriveState } from "./status-core";
import type { State } from "./status-core";
import { upstreamFactsForItem } from "./upstream-facts";

export interface PromoteDisposition {
  offered: boolean;
  /** The disabled reason; absent exactly when the row is offered. */
  reason?: string;
}

/**
 * Whether one status state has something `promote` can publish.
 *
 * Four states are offered: the two local-edit states, the dirty canonical
 * source, and its output-drift combination. Everything else is a state
 * `promote` would refuse or no-op on, and the reason tells the user which
 * command acts on it instead.
 */
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
  lock: LockV4;
  scope: "project" | "local";
}

export async function loadPromoteCatalog(
  opts: LoadPromoteCatalogOptions,
): Promise<PromoteCatalog> {
  const items = Object.keys(opts.lock.items)
    .map((key) => ({ key, ...parseLockKey(key) }))
    .filter((item) => item.source === "data");

  // One `git ls-files -v` over every item's canonical paths, not one call per
  // item: an index flag or an ignore rule makes `git status` blind to a real
  // change, so a flagged row's "nothing to promote" would be the wrong reason.
  // Every kind is covered — a copy item's directory pathspec lists the tracked
  // files beneath it — because the blind spot is a property of porcelain, not
  // of fragments. The batched answer relabels exactly those rows.
  const canonicalPaths = items.flatMap((item) =>
    allCanonicalItemRelPaths(item.kind, item.name),
  );
  const trackedFlags = await indexEntryFlags(opts.dataRepo, canonicalPaths);
  const tracked = new Set(trackedFlags.map((entry) => entry.path));
  const hidden = trackedFlags
    .filter((entry) => entry.assumeUnchanged || entry.skipWorktree)
    .map((entry) => entry.path);
  // A canonical file that is present, untracked, and one `git status` stays
  // silent about even when asked for every untracked file: that is an ignore
  // rule, and `git add` refuses such a path, so promote cannot publish it. An
  // ordinary untracked source is reported `??` here, stays out of this set,
  // and promotes normally. File-path kinds only — a copy item's expected file
  // set cannot be enumerated from the catalog.
  const untrackedPresent = items
    .filter((item) => !isCopyDirectoryItemKind(item.kind))
    .flatMap((item) => allCanonicalItemRelPaths(item.kind, item.name))
    .filter(
      (relPath) =>
        !tracked.has(relPath) &&
        existsSync(join(opts.dataRepo, ...relPath.split("/"))),
    );
  const reported = new Set(
    untrackedPresent.length > 0
      ? (
          await statusPorcelainRecords(opts.dataRepo, untrackedPresent, {
            untrackedFiles: "all",
          })
        ).map((record) => record.path)
      : [],
  );
  const ignoredHidden = new Set(
    untrackedPresent.filter((relPath) => !reported.has(relPath)),
  );

  const rows: PickRow[] = [];
  for (const item of items) {
    const { kind, name, key } = item;
    const entry = opts.lock.items[key];
    if (entry?.source !== "data") continue;
    // Per item, not all-or-nothing: deriving one item's state can throw for
    // reasons that belong to that item alone (a missing source commit pulled
    // in through another fragment's contribution, an unreadable object), and
    // a named promote of an unrelated dirty item would still succeed. The
    // broken item degrades to a disabled row naming the failure.
    let state: State;
    try {
      state = await itemState(opts, kind, name, entry);
    } catch (error) {
      const reason =
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "unreadable")
          : String(error);
      rows.push({
        ref: `${kind}/${name}`,
        kind,
        name,
        tags: [],
        installed: false,
        disabled: true,
        detail: sanitizeDisplayText(`state unavailable: ${reason}`),
      });
      continue;
    }
    const disposition = promoteRowDisposition(state);

    // A path git is not watching disables the row in *every* state, not only
    // `ok`. The states come from `git status`, which cannot see these paths:
    // an `ok` row's "nothing to promote" would be the wrong reason, and an
    // offered row would invite a promote that rewrites the canonical tree
    // while git silently discards the hidden worktree edit. The row names the
    // path instead, which is the repairable fact.
    const unwatched = unwatchedPaths(kind, name, hidden, ignoredHidden);
    let detail: string;
    if (unwatched.length > 0) {
      detail = `git is not watching ${unwatched.join(", ")}`;
    } else if (disposition.offered) {
      detail = await offeredDetail(opts, kind, name, state);
    } else {
      detail = disposition.reason as string;
    }

    rows.push({
      ref: `${kind}/${name}`,
      kind,
      name,
      tags: [],
      installed: false,
      ...(disposition.offered && unwatched.length === 0
        ? {}
        : { disabled: true }),
      detail: sanitizeDisplayText(detail),
    });
  }
  return { rows };
}

/**
 * The unwatched paths of one item, from fresh git reads.
 *
 * The catalog's batched answer goes stale while the picker holds the terminal
 * for an unbounded time, so the interactive loop re-asks per marked item just
 * before acting. This narrows the window; the enforcement inside the promote
 * transaction itself belongs to the deferred blind-spots patch, and the named
 * command's behavior is unchanged.
 */
export async function unwatchedPathsForItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string[]> {
  const canonical = allCanonicalItemRelPaths(kind, name);
  const flags = await indexEntryFlags(dataRepo, canonical);
  const tracked = new Set(flags.map((entry) => entry.path));
  const hidden = flags
    .filter((entry) => entry.assumeUnchanged || entry.skipWorktree)
    .map((entry) => entry.path);
  if (isCopyDirectoryItemKind(kind)) {
    return unwatchedPaths(kind, name, hidden, new Set());
  }
  const untrackedPresent = canonical.filter(
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
  return unwatchedPaths(
    kind,
    name,
    hidden,
    new Set(untrackedPresent.filter((relPath) => !reported.has(relPath))),
  );
}

/**
 * The item's canonical paths that git is not watching: index-flagged tracked
 * files (any kind — a copy item's flagged file matches by directory prefix),
 * plus the ignore-hidden files the loader probed for the file-path kinds.
 *
 * An ignored *untracked* file beneath a copy item's directory is deliberately
 * out of scope. `promote` has always replaced the managed directory
 * wholesale, and routine ignored junk (`.DS_Store`, editor droppings) is
 * present in most such directories — a probe would disable nearly every copy
 * row for files nobody wants preserved, and precious-versus-junk is not
 * decidable here.
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

/** The same facts `status` gathers for one row, fed to the same state machine. */
async function itemState(
  opts: LoadPromoteCatalogOptions,
  kind: ItemKind,
  name: string,
  entry: DataLockEntryV4,
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
          opts.dataRepo,
          kind,
          name,
          entry.sourceCommit,
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
    const targetState = await fragmentContributionState(
      opts.project,
      opts.dataRepo,
      opts.manifest,
      opts.lock,
      target,
    );
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
      opts.dataRepo,
      kind,
      name,
      commit,
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

/**
 * The detail for an offered row: which file the promote reads.
 *
 * A local-edit state names the installed path the user edited; a dirty-source
 * state names the data-repo canonical file, which is the fact `promote --help`
 * never states.
 */
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
    // Offered fragment states never reach here (`drifted_local` cannot derive
    // for a fragment kind), so this is a defensive label only.
    return `${kind}/${name}`;
  }
  return relative(project, installedPath(project, kind, name));
}
