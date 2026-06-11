import {
  aheadBehind,
  currentBranch,
  fastForwardTo,
  fetchOrigin,
  headSha,
  isRepoClean,
  originRemoteUrl,
  trackingRef,
} from "./git";
import { homeRelative } from "./paths";
import { assertNever } from "./assert";

/**
 * Explicit, opt-in network sync of the bound data repo. `sync-data` is the
 * only capshelf command (besides init bootstrap and self-update) that touches
 * the network. The clone is user-owned: the only ref movement performed here
 * is remote-tracking updates (`git fetch`) plus a fast-forward of the current
 * branch when that is provably safe. Everything else stops with guidance.
 */

export type SyncState =
  | "up_to_date"
  | "fast_forwarded"
  | "local_ahead"
  | "diverged"
  | "dirty_worktree"
  | "detached_head"
  | "no_tracking_ref"
  | "no_origin"
  | "fetch_failed";

export type SyncExitCode = 0 | 1 | 3 | 4;

export interface SyncFacts {
  hasOrigin: boolean;
  fetchOk: boolean;
  detached: boolean;
  branch: string | null;
  trackingRef: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
}

export interface SyncDecision {
  state: SyncState;
  /** fast-forward the current branch (the only branch mutation ever made) */
  integrate: boolean;
  exitCode: SyncExitCode;
}

/**
 * Pure outcome table for sync-data. Normative precedence (first match wins):
 *
 *   no_origin > fetch_failed > detached_head > no_tracking_ref
 *     > diverged > dirty_worktree > local_ahead > fast_forwarded > up_to_date
 *
 * The ordering mirrors the I/O sequence: no_origin precedes fetch_failed
 * because the fetch is never attempted without a remote, and the
 * detached/tracking checks precede the comparison states because ahead/behind
 * is undefined without a target. Within the comparison states, diverged beats
 * dirty_worktree (when ahead > 0 && behind > 0, dirtiness does not change the
 * core problem); dirtiness selects a state only when behind > 0 && ahead == 0
 * (it blocks an otherwise-possible fast-forward) — in every other state it is
 * reported via the `dirty` field but affects neither state nor exit code.
 */
export function decideSync(facts: SyncFacts): SyncDecision {
  if (!facts.hasOrigin) {
    return { state: "no_origin", integrate: false, exitCode: 3 };
  }
  if (!facts.fetchOk) {
    return { state: "fetch_failed", integrate: false, exitCode: 1 };
  }
  if (facts.detached) {
    return { state: "detached_head", integrate: false, exitCode: 3 };
  }
  if (facts.trackingRef === null) {
    return { state: "no_tracking_ref", integrate: false, exitCode: 3 };
  }
  const ahead = facts.ahead ?? 0;
  const behind = facts.behind ?? 0;
  if (ahead > 0 && behind > 0) {
    return { state: "diverged", integrate: false, exitCode: 4 };
  }
  if (facts.dirty && behind > 0) {
    return { state: "dirty_worktree", integrate: false, exitCode: 4 };
  }
  if (ahead > 0) {
    return { state: "local_ahead", integrate: false, exitCode: 0 };
  }
  if (behind > 0) {
    return { state: "fast_forwarded", integrate: true, exitCode: 0 };
  }
  return { state: "up_to_date", integrate: false, exitCode: 0 };
}

export interface SyncReport {
  dataRepo: string;
  origin: string | null;
  branch: string | null;
  trackingRef: string | null;
  fetched: boolean;
  state: SyncState;
  before: string | null;
  after: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  guidance: string;
  /** git's stderr; present only for fetch_failed */
  fetchStderr?: string;
  exitCode: SyncExitCode;
}

/**
 * The total I/O sequence for sync-data. Every run ends in exactly one outcome
 * state. The fetch runs before the detached-HEAD check, deliberately, so
 * remote-tracking refs are fresh even when capshelf refuses to move anything.
 */
export async function syncData(dataRepo: string): Promise<SyncReport> {
  const originRaw = await originRemoteUrl(dataRepo);
  const origin = originRaw === null ? null : originRaw.trim();
  if (origin === null) {
    return buildReport({
      dataRepo,
      origin,
      facts: emptyFacts(),
      fetched: false,
    });
  }

  const fetch = await fetchOrigin(dataRepo);
  if (!fetch.ok) {
    return buildReport({
      dataRepo,
      origin,
      facts: { ...emptyFacts(), hasOrigin: true },
      fetched: false,
      fetchStderr: fetch.stderr,
    });
  }

  const branch = await currentBranch(dataRepo);
  const dirty = !(await isRepoClean(dataRepo));
  if (branch === null) {
    return buildReport({
      dataRepo,
      origin,
      facts: {
        ...emptyFacts(),
        hasOrigin: true,
        fetchOk: true,
        detached: true,
        dirty,
      },
      fetched: true,
    });
  }

  const target = await trackingRef(dataRepo, branch);
  if (target === null) {
    return buildReport({
      dataRepo,
      origin,
      facts: { ...emptyFacts(), hasOrigin: true, fetchOk: true, branch, dirty },
      fetched: true,
    });
  }

  const { ahead, behind } = await aheadBehind(dataRepo, target);
  const facts: SyncFacts = {
    hasOrigin: true,
    fetchOk: true,
    detached: false,
    branch,
    trackingRef: target,
    ahead,
    behind,
    dirty,
  };
  const decision = decideSync(facts);
  const before = await headSha(dataRepo);
  let after = before;
  if (decision.integrate) {
    await fastForwardTo(dataRepo, target);
    after = await headSha(dataRepo);
  }
  return buildReport({ dataRepo, origin, facts, fetched: true, before, after });
}

function emptyFacts(): SyncFacts {
  return {
    hasOrigin: false,
    fetchOk: false,
    detached: false,
    branch: null,
    trackingRef: null,
    ahead: null,
    behind: null,
    dirty: false,
  };
}

function buildReport(input: {
  dataRepo: string;
  origin: string | null;
  facts: SyncFacts;
  fetched: boolean;
  before?: string;
  after?: string;
  fetchStderr?: string;
}): SyncReport {
  const decision = decideSync(input.facts);
  return {
    dataRepo: input.dataRepo,
    origin: input.origin,
    branch: input.facts.branch,
    trackingRef: input.facts.trackingRef,
    fetched: input.fetched,
    state: decision.state,
    before: input.before ?? null,
    after: input.after ?? null,
    ahead: input.facts.ahead,
    behind: input.facts.behind,
    dirty: input.facts.dirty,
    guidance: syncGuidance(decision.state, input.dataRepo),
    ...(input.fetchStderr !== undefined && { fetchStderr: input.fetchStderr }),
    exitCode: decision.exitCode,
  };
}

export function syncGuidance(state: SyncState, dataRepo: string): string {
  const repo = homeRelative(dataRepo);
  switch (state) {
    case "up_to_date":
      return "already up to date";
    case "fast_forwarded":
      return "run `capshelf status` in each bound project";
    case "local_ahead":
      return `to share your promoted commits: git -C ${repo} push`;
    case "diverged":
      return "reconcile in the data repo with git (rebase or merge), then re-run sync-data";
    case "dirty_worktree":
      return "commit, stash, or discard the data-repo changes, then re-run sync-data";
    case "detached_head":
      return "check out a branch in the data repo, then re-run sync-data";
    case "no_tracking_ref":
      return "push the branch or switch to a shared branch, then re-run sync-data";
    case "no_origin":
      return `add a remote and retry: git -C ${repo} remote add origin <url>`;
    case "fetch_failed":
      return "check the network, authentication, or the remote URL, then retry";
    default:
      return assertNever(state);
  }
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Human rendering of a sync report. Returns lines; the command joins and
 * prints them (including the ✗ line for stop states) before signaling the
 * exit code, so the full report always lands before a non-zero exit.
 */
export function formatSyncHuman(report: SyncReport): string[] {
  const repo = homeRelative(report.dataRepo);
  const lines: string[] = [];
  if (report.fetched && report.origin !== null) {
    lines.push("fetched origin:", `  ${report.origin}`, "");
  }
  switch (report.state) {
    case "up_to_date":
      lines.push(`${report.branch} is up to date with ${report.trackingRef}.`);
      break;
    case "fast_forwarded":
      lines.push(
        `fast-forwarded ${report.branch}:`,
        `  ${shortSha(report.before)} -> ${shortSha(report.after)}  (${plural(report.behind ?? 0, "new commit")})`,
        "",
        "next, in each project bound to this data repo:",
        "  capshelf status            # see update_available items",
        "  capshelf update <item>     # opt in per item",
      );
      break;
    case "local_ahead":
      lines.push(
        `${report.branch} is ahead of ${report.trackingRef} by ${plural(report.ahead ?? 0, "commit")} (nothing to pull).`,
        "",
        "to share your promoted commits:",
        `  git -C ${repo} push`,
      );
      break;
    case "diverged":
      lines.push(
        `✗ ${report.branch} and ${report.trackingRef} have diverged (${plural(report.ahead ?? 0, "local commit")}, ${plural(report.behind ?? 0, "upstream commit")}).`,
        "",
        "  capshelf never rewrites or merges your data-repo history.",
        "  reconcile with git, then re-run sync-data:",
        `    git -C ${repo} status`,
        `    git -C ${repo} rebase ${report.trackingRef}    # or merge`,
        `    git -C ${repo} push`,
      );
      break;
    case "dirty_worktree":
      lines.push(
        `✗ ${report.trackingRef} has ${plural(report.behind ?? 0, "new commit")}, but the data repo worktree has`,
        "  uncommitted changes; not fast-forwarding over them.",
        "",
        "  commit, stash, or discard first:",
        `    git -C ${repo} status --short`,
        "  then re-run: capshelf sync-data",
      );
      break;
    case "detached_head":
      lines.push(
        "✗ the data repo is on a detached HEAD; capshelf will not move it.",
        "",
        "  check out a branch, then re-run sync-data:",
        `    git -C ${repo} switch <branch>`,
      );
      break;
    case "no_tracking_ref":
      lines.push(
        `✗ branch ${report.branch} has no upstream tracking ref and origin has no`,
        "  branch of that name; nothing to fast-forward.",
        "",
        "  if this is a proposal branch, push it:",
        `    git -C ${repo} push -u origin ${report.branch}`,
        "  or switch back to a shared branch:",
        `    git -C ${repo} switch <shared-branch>`,
      );
      break;
    case "no_origin":
      lines.push(
        `✗ data repo at ${repo} has no \`origin\` remote to sync from.`,
        "",
        "  add one and retry:",
        `    git -C ${repo} remote add origin <url>`,
        "    capshelf sync-data",
      );
      break;
    case "fetch_failed":
      lines.push(
        `✗ failed to fetch origin for ${repo}`,
        "",
        "  git reported:",
        ...(report.fetchStderr ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => `    ${line}`),
        "",
        "  check the network, authentication, or the remote URL, then retry.",
      );
      break;
    default:
      return assertNever(report.state);
  }
  return lines;
}

function shortSha(sha: string | null): string {
  return (sha ?? "").slice(0, 7);
}
