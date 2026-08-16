import { relative } from "node:path";
import {
  commitExists,
  literalPathspec,
  lsTreeEntriesForPathspecs,
  showAtCommit,
} from "./git";
import {
  fragmentOutputPath,
  fragmentSourceCandidates,
  fragmentTargetPresenceInPaths,
  type FragmentSourceTarget,
  type TargetPresence,
} from "./fragments";
import { itemOutputTargets } from "./installed";
import {
  allCanonicalItemRelPaths,
  isFragmentItemKind,
  type ItemKind,
} from "./master";
import {
  subagentCandidates,
  subagentTargetPresenceInPaths,
  type SubagentTargetPresence,
} from "./subagents";

/**
 * Target coverage: for one item, every candidate runtime target, each marked
 * present or absent, with the output path it feeds.
 *
 * capshelf reports item → source → output file. The user thinks in
 * server → which of my agents can call it. `.mcp.json` is not a neutral fact;
 * it is Claude Code's project MCP file, and printing it alone said nothing
 * about Codex. This is the shape every command that *describes* an item uses,
 * so all of them say it in the same words.
 */
export interface TargetCoverage {
  target: FragmentSourceTarget;
  /** Canonical source path in the data repo, whether it is there or not. */
  sourcePath: string;
  /** true | false, or null when coverage could not be read at all. */
  present: boolean | null;
  /** Absolute path in the project this target feeds; null outside a project. */
  outputPath: string | null;
}

/**
 * Why coverage could not be read. A closed set, not free text, because callers
 * branch on it: the squash-merge re-pin guidance `status` gives belongs to an
 * unreachable commit and is wrong advice for a corrupt object database.
 */
export type CoverageUnknownReason =
  | "data repo unbound"
  | "data repo has no commits"
  | "locked commit unreachable"
  | "source tree unreadable";

export interface TargetCoverageReport {
  rows: TargetCoverage[];
  /**
   * "unknown" when presence could not be read at a commit — the data repo is
   * unbound, the locked sourceCommit is unreachable, or its objects do not
   * read. Every row then carries `present: null`, and no gap is reported: an
   * unknown gap is not a gap.
   */
  state: "known" | "unknown";
  /** Why coverage is unknown; set only when `state` is "unknown". */
  reason?: CoverageUnknownReason;
}

/** The `--json` row shape. `outputPath` is project-relative, as callers emit. */
export interface TargetCoverageJson {
  target: FragmentSourceTarget;
  present: boolean | null;
  sourcePath: string;
  outputPath: string | null;
}

export const RUNTIME_TARGET_LABELS: Record<FragmentSourceTarget, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Coverage applies only to kinds with more than one candidate target — today
 * `mcp` and `subagents`. `settings` and `codex-config` have one candidate each
 * and keep their single-path output unchanged. Derived from the candidate
 * lists rather than a hardcoded pair, so a third kind gaining a second target
 * is covered by construction.
 */
export function hasTargetCoverage(kind: ItemKind, name: string): boolean {
  if (kind === "subagents") return subagentCandidates(name).length > 1;
  if (isFragmentItemKind(kind)) {
    return fragmentSourceCandidates(kind, name).length > 1;
  }
  return false;
}

/**
 * Coverage for one item, read at `commit`. Never at the worktree: fragment
 * values are read with `readFragmentAtCommit` at the locked commit, so a
 * worktree-derived claim could disagree with the file capshelf actually wrote,
 * and a dirty deletion is invisible to the cleanliness gate — `add` accepts an
 * item whose pin still contains the source the worktree cannot see.
 *
 * Returns null for a kind with one candidate target. Degrades to an `unknown`
 * report when the commit is unreachable, so a caller that keeps producing rows
 * in that state (`status`, `add`'s already-installed branch) still gets one.
 */
export async function itemTargetCoverageAtCommit(
  project: string | null,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<TargetCoverageReport | null> {
  if (!hasTargetCoverage(kind, name)) return null;
  if (!(await commitExists(dataRepo, commit))) {
    return unknownTargetCoverage(
      project,
      kind,
      name,
      "locked commit unreachable",
    );
  }
  const paths = await canonicalPathsAtCommit(dataRepo, kind, name, commit);
  if (paths === null) {
    return unknownTargetCoverage(project, kind, name, "source tree unreadable");
  }
  return itemTargetCoverageInPaths(project, kind, name, paths);
}

/**
 * Coverage from a tree listing the caller already has. `add` passes its pin's
 * entries: the pin is one `ls-tree` over the item's canonical paths, so it is
 * both the tree the install writes and a read that raises rather than
 * reporting a failure as an absent source.
 */
export function itemTargetCoverageInPaths(
  project: string | null,
  kind: ItemKind,
  name: string,
  repoRelPaths: Iterable<string>,
): TargetCoverageReport | null {
  if (!hasTargetCoverage(kind, name)) return null;
  if (kind === "subagents") {
    return known(
      subagentCoverage(
        project,
        name,
        subagentTargetPresenceInPaths(name, repoRelPaths),
      ),
    );
  }
  if (!isFragmentItemKind(kind)) return null;
  return known(
    fragmentCoverage(
      project,
      fragmentTargetPresenceInPaths(kind, name, repoRelPaths),
    ),
  );
}

/**
 * Which of an item's canonical paths are blobs at `commit`, in one `ls-tree`.
 *
 * `null` means the read failed, which is not the same as "the file is not
 * there". Probing each path with `git show` cannot tell the two apart — it
 * catches every git failure — and coverage that claims a known absence on a
 * failed read would let the Codex trust warning be suppressed on no evidence
 * and would report a gap that does not exist. Unmatched pathspecs are not an
 * error to `ls-tree`, so a genuinely absent file is an empty result, not a
 * failure.
 *
 * The filter is on mode, not type: Git stores a symlink as a `blob` with mode
 * `120000`, and `assertRegularBlobEntries` refuses exactly those, so a
 * committed `mcp/<n>/codex.toml` symlink would otherwise be reported as a
 * covered target for an item `pinCurrentSource` cannot pin at all.
 *
 * Membership in the tree is then confirmed by reading, because `present: true`
 * is read by every consumer as "this runtime is covered" — and a listed blob
 * that cannot be produced covers nothing. Without the read, a corrupt object
 * left `status` claiming full coverage for an item `apply` could not restore,
 * and left `targetCoverage` contradicting the `targets` array beside it.
 */
async function canonicalPathsAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<Set<string> | null> {
  try {
    const entries = await lsTreeEntriesForPathspecs(
      dataRepo,
      commit,
      allCanonicalItemRelPaths(kind, name).map(literalPathspec),
    );
    const listed = entries
      .filter((entry) => entry.mode === "100644" || entry.mode === "100755")
      .map((entry) => entry.path);
    for (const path of listed) {
      await showAtCommit(dataRepo, commit, path);
    }
    return new Set(listed);
  } catch {
    return null;
  }
}

/** Every candidate row with `present: null`, for a state that cannot be read. */
export function unknownTargetCoverage(
  project: string | null,
  kind: ItemKind,
  name: string,
  reason: CoverageUnknownReason,
): TargetCoverageReport | null {
  if (!hasTargetCoverage(kind, name)) return null;
  const rows =
    kind === "subagents"
      ? subagentCoverage(
          project,
          name,
          subagentCandidates(name).map((candidate) => ({
            candidate,
            present: null,
          })),
        )
      : isFragmentItemKind(kind)
        ? fragmentCoverage(
            project,
            fragmentSourceCandidates(kind, name).map((source) => ({
              source,
              runtimeTarget: source.sourceTarget ?? null,
              present: null,
            })),
          )
        : [];
  return { rows, state: "unknown", reason };
}

export function absentTargets(report: TargetCoverageReport): TargetCoverage[] {
  if (report.state === "unknown") return [];
  return report.rows.filter((row) => row.present === false);
}

export function coversTarget(
  report: TargetCoverageReport,
  target: FragmentSourceTarget,
): boolean {
  return report.rows.some(
    (row) => row.target === target && row.present === true,
  );
}

export interface CoverageBlockOptions {
  indent?: string;
  /** `add` and `share` wrote the covered outputs; `show` only describes them. */
  presentWord?: "written" | "present";
  /** Where an absent source was looked for. */
  absentScope?: "item" | "locked";
}

/** Narrow a report to one runtime target, for `show --target`. */
export function restrictCoverage(
  report: TargetCoverageReport,
  target: FragmentSourceTarget | null,
): TargetCoverageReport {
  if (target === null) return report;
  return {
    ...report,
    rows: report.rows.filter((row) => row.target === target),
  };
}

/**
 * The target block. It prints whether or not there is a gap: a user who sees
 * the table once learns the model, and a table that appears only on failure
 * teaches nothing.
 */
export function formatTargetCoverageBlock(
  report: TargetCoverageReport,
  opts: CoverageBlockOptions = {},
): string[] {
  const indent = opts.indent ?? "  ";
  if (report.state === "unknown") {
    return [`${indent}targets: unknown (${report.reason ?? "not readable"})`];
  }
  if (report.rows.length === 0) return [];
  const presentWord = opts.presentWord ?? "present";
  return [
    `${indent}targets:`,
    ...report.rows.map((row) => {
      const label = RUNTIME_TARGET_LABELS[row.target].padEnd(8);
      const state = (row.present === true ? presentWord : "absent").padEnd(9);
      return `${indent}  ${label}${state}${coverageDetail(row, opts.absentScope ?? "item")}`;
    }),
  ];
}

/**
 * Name the gap as a fact about the data repo, never as a computed command.
 *
 * The canonical path is fixed by the candidate list, so this sentence is true
 * whether the source is missing everywhere, present at HEAD but not at the
 * lock, or present only in the working tree — author or commit the file, then
 * `update` picks it up. An earlier design printed a repair command chosen from
 * the project's state; every review pass found another state where it refused.
 * The `update` line has the one precondition the path sentence does not: the
 * item must be tracked in a project.
 */
export function formatCoverageGap(
  report: TargetCoverageReport,
  itemRef: string,
  opts: { indent?: string; tracked: boolean },
): string[] {
  const indent = opts.indent ?? "  ";
  return absentTargets(report).flatMap((row) => [
    `${indent}${RUNTIME_TARGET_LABELS[row.target]} reads ${row.sourcePath} in your data repo.`,
    ...(opts.tracked
      ? [`${indent}Add it there, commit, then: capshelf update ${itemRef}`]
      : []),
  ]);
}

export interface TargetCoverageFields {
  targetCoverage: TargetCoverageJson[];
  coverageState?: "unknown";
  /** Why every row is `null`; set only alongside `coverageState`. */
  coverageReason?: string;
}

export function targetCoverageJson(
  report: TargetCoverageReport,
  project: string | null,
): TargetCoverageFields {
  return {
    targetCoverage: report.rows.map((row) => ({
      target: row.target,
      present: row.present,
      sourcePath: row.sourcePath,
      outputPath:
        row.outputPath !== null && project !== null
          ? relative(project, row.outputPath)
          : null,
    })),
    ...(report.state === "unknown" && {
      coverageState: "unknown" as const,
      ...(report.reason !== undefined && { coverageReason: report.reason }),
    }),
  };
}

function known(rows: TargetCoverage[]): TargetCoverageReport {
  return { rows, state: "known" };
}

function fragmentCoverage(
  project: string | null,
  presence: TargetPresence[],
): TargetCoverage[] {
  return presence.flatMap((row) =>
    row.runtimeTarget === null
      ? []
      : [
          {
            target: row.runtimeTarget,
            sourcePath: row.source.relPath,
            present: row.present,
            outputPath: project
              ? fragmentOutputPath(project, row.source.target)
              : null,
          },
        ],
  );
}

function subagentCoverage(
  project: string | null,
  name: string,
  presence: SubagentTargetPresence[],
): TargetCoverage[] {
  const outputs = project
    ? new Map(
        itemOutputTargets(project, "subagents", name).map(
          (target) => [target.id, target.outputPath] as const,
        ),
      )
    : null;
  return presence.map((row) => ({
    target: row.candidate.target,
    sourcePath: row.candidate.relPath,
    present: row.present,
    outputPath: outputs?.get(row.candidate.target) ?? null,
  }));
}

function coverageDetail(
  row: TargetCoverage,
  absentScope: "item" | "locked",
): string {
  if (row.present !== true) {
    return `no ${row.target} source ${absentScope === "locked" ? "at the locked commit" : "in this item"}`;
  }
  return row.outputPath ?? "(no project)";
}
