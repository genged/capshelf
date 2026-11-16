import type { GitReadMemo } from "./git-read-memo";
import { relative } from "node:path";
import {
  catFileBlobs,
  commitExists,
  literalPathspec,
  lsTreeEntriesForPathspecs,
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
 * Lists every candidate runtime target because an output file like `.mcp.json`
 * is only Claude Code's and says nothing about whether Codex or other agents
 * can call the server.
 */
export interface TargetCoverage {
  target: FragmentSourceTarget;
  sourcePath: string;
  present: boolean | null;
  outputPath: string | null;
}

/**
 * A closed set because callers branch on it: squash-merge re-pin guidance fits
 * an unreachable commit, not a corrupt object database.
 */
type CoverageUnknownReason =
  | "data repo unbound"
  | "data repo has no commits"
  | "locked commit unreachable"
  | "source tree unreadable";

export interface TargetCoverageReport {
  rows: TargetCoverage[];
  /**
   * Unknown coverage reports no gap: an unreadable state is not evidence of a
   * missing target.
   */
  state: "known" | "unknown";
  reason?: CoverageUnknownReason;
}

export interface TargetCoverageJson {
  target: FragmentSourceTarget;
  present: boolean | null;
  sourcePath: string;
  outputPath: string | null;
}

const INDENT = "  ";

export const RUNTIME_TARGET_LABELS: Record<FragmentSourceTarget, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Derived from the candidate lists, not a hardcoded pair, so a subagent or
 * fragment kind that gains a second target is covered automatically.
 */
function hasTargetCoverage(kind: ItemKind, name: string): boolean {
  if (kind === "subagents") return subagentCandidates(name).length > 1;
  if (isFragmentItemKind(kind)) {
    return fragmentSourceCandidates(kind, name).length > 1;
  }
  return false;
}

/**
 * Read at the commit, never the worktree: a worktree claim can disagree with
 * the written file, and a dirty deletion is invisible to the cleanliness gate.
 */
export async function itemTargetCoverageAtCommit(
  project: string | null,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
  /**
   * Set when the caller already proved the commit reachable, to avoid a second
   * identical `git cat-file -e` per row.
   */
  opts: { commitKnownPresent?: boolean; memo?: GitReadMemo } = {},
): Promise<TargetCoverageReport | null> {
  if (!hasTargetCoverage(kind, name)) return null;
  if (
    opts.commitKnownPresent !== true &&
    !(await commitExists(dataRepo, commit, opts.memo))
  ) {
    return unknownTargetCoverage(
      project,
      kind,
      name,
      "locked commit unreachable",
    );
  }
  const paths = await canonicalPathsAtCommit(
    dataRepo,
    kind,
    name,
    commit,
    opts.memo,
  );
  if (paths === null) {
    return unknownTargetCoverage(project, kind, name, "source tree unreadable");
  }
  return itemTargetCoverageInPaths(project, kind, name, paths);
}

/**
 * `add` passes its pin's entries because that `ls-tree` raises on failure
 * instead of reporting an absent source.
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
 * A failed read returns null, not absence, since a false known-absence would
 * suppress the Codex trust warning. Filter on mode because symlinks are blobs
 * with mode 120000 that `pinCurrentSource` rejects, and confirm each blob reads
 * so a corrupt object isn't reported as covered.
 */
async function canonicalPathsAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
  memo?: GitReadMemo,
): Promise<Set<string> | null> {
  try {
    const entries = await lsTreeEntriesForPathspecs(
      dataRepo,
      commit,
      allCanonicalItemRelPaths(kind, name).map(literalPathspec),
      { memo },
    );
    const regular = entries.filter(
      (entry) => entry.mode === "100644" || entry.mode === "100755",
    );
    // One `cat-file --batch` proves each content can be produced and asserts
    // the object is a blob, rather than inferring it from an exit status.
    await catFileBlobs(
      dataRepo,
      regular.map((entry) => entry.object),
      memo,
    );
    return new Set(regular.map((entry) => entry.path));
  } catch {
    return null;
  }
}

export function unknownTargetCoverage(
  project: string | null,
  kind: ItemKind,
  name: string,
  reason: CoverageUnknownReason,
): TargetCoverageReport | null {
  if (!hasTargetCoverage(kind, name)) return null;
  if (kind === "subagents") {
    const rows = subagentCoverage(
      project,
      name,
      subagentCandidates(name).map((candidate) => ({
        candidate,
        present: null,
      })),
    );
    return { rows, state: "unknown", reason };
  }
  if (!isFragmentItemKind(kind)) return null;
  const rows = fragmentCoverage(
    project,
    fragmentSourceCandidates(kind, name).map((source) => ({
      source,
      runtimeTarget: source.sourceTarget ?? null,
      present: null,
    })),
  );
  return { rows, state: "unknown", reason };
}

function absentTargets(report: TargetCoverageReport): TargetCoverage[] {
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

interface CoverageBlockOptions {
  presentWord?: "written" | "present";
  absentScope?: "item" | "locked";
}

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
 * Print the block even without a gap, so users learn the model from the table
 * instead of only on failure.
 */
export function formatTargetCoverageBlock(
  report: TargetCoverageReport,
  opts: CoverageBlockOptions = {},
): string[] {
  if (report.state === "unknown") {
    return [`${INDENT}targets: unknown (${report.reason ?? "not readable"})`];
  }
  if (report.rows.length === 0) return [];
  const presentWord = opts.presentWord ?? "present";
  return [
    `${INDENT}targets:`,
    ...report.rows.map((row) => {
      const label = RUNTIME_TARGET_LABELS[row.target].padEnd(8);
      const state = (row.present === true ? presentWord : "absent").padEnd(9);
      return `${INDENT}  ${label}${state}${coverageDetail(row, opts.absentScope ?? "item")}`;
    }),
  ];
}

/**
 * Name the gap as a fact about the canonical path in the data repo, not a
 * computed repair command. The sentence holds whether the source is missing
 * everywhere, present at HEAD but not at the lock, or only in the working tree.
 */
export function formatCoverageGap(
  report: TargetCoverageReport,
  itemRef: string,
  opts: { tracked: boolean },
): string[] {
  return absentTargets(report).flatMap((row) => [
    `${INDENT}${RUNTIME_TARGET_LABELS[row.target]} reads ${row.sourcePath} in your data repo.`,
    ...(opts.tracked
      ? [`${INDENT}Once it is committed there: capshelf update ${itemRef}`]
      : []),
  ]);
}

export interface PrintCoverageOptions {
  presentWord: "written" | "present";
  absentScope?: "item" | "locked";
  tracked: boolean;
  unknownGuidance?: string[];
}

/**
 * Prints the coverage block and, when a target is absent, the gap sentence. It
 * lives beside the formatters so `add`, `show`, and `share` share the loop and
 * the wording cannot drift.
 */
export function printTargetCoverage(
  report: TargetCoverageReport,
  itemRef: string,
  opts: PrintCoverageOptions,
): void {
  for (const line of formatTargetCoverageBlock(report, {
    presentWord: opts.presentWord,
    ...(opts.absentScope && { absentScope: opts.absentScope }),
  })) {
    console.log(line);
  }
  if (report.state === "unknown") {
    for (const line of opts.unknownGuidance ?? []) console.log(line);
    return;
  }
  for (const line of formatCoverageGap(report, itemRef, {
    tracked: opts.tracked,
  })) {
    console.log(line);
  }
}

export interface TargetCoverageFields {
  targetCoverage: TargetCoverageJson[];
  coverageState?: "unknown";
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
