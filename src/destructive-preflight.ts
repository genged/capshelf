import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DestructiveChange } from "./destructive-change";
import { PreconditionError } from "./errors";
import type {
  FragmentContributionState,
  FragmentOutputPlan,
  FragmentTarget,
} from "./fragments";
import { showAtCommit } from "./git";
import { allRegularFiles } from "./gitignore";
import { installedPath } from "./installed";
import type { DataLockEntry, LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import { copyDirectoryReconciliationFiles } from "./materialize";
import type { CopyDirectoryItemKind } from "./master";
import type { Scope } from "./promote-core";
import { materializeSubagent, subagentSourcesAtCommit } from "./subagents";

export interface PlannedDestruction {
  changes: DestructiveChange[];
  snapshotParts: string[];
}

export async function planCopyDirectoryDestruction(opts: {
  project: string;
  dataRepo?: string;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  scope: Scope;
  currentEntry: LockEntry;
  selectedEntry: LockEntry;
  reviewCommand: string;
}): Promise<PlannedDestruction> {
  const current = await copyDirectoryReconciliationFiles({
    project: opts.project,
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    kind: opts.kind,
    name: opts.name,
    entry: opts.currentEntry,
    previousEntry: opts.currentEntry,
    scope: opts.scope,
  });
  await copyDirectoryReconciliationFiles({
    project: opts.project,
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    kind: opts.kind,
    name: opts.name,
    entry: opts.selectedEntry,
    previousEntry: opts.currentEntry,
    scope: opts.scope,
  });

  const root = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(root)) {
    return { changes: [], snapshotParts: [`missing:${root}`] };
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PreconditionError(
      `managed copy-item target is not a regular directory: ${root}`,
    );
  }

  const expectedByPath = new Map(
    current.expected.map((file) => [file.path, file]),
  );
  const preservedPaths = new Set(current.preserved.map((file) => file.path));
  const seen = new Set<string>();
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  for (const path of await allRegularFiles(root)) {
    seen.add(path);
    const fullPath = join(root, ...path.split("/"));
    const [info, content] = await Promise.all([
      lstat(fullPath),
      readFile(fullPath),
    ]);
    const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
    snapshotParts.push(`copy:${fullPath}:${mode}:${contentDigest(content)}`);
    const expected = expectedByPath.get(path);
    if (expected) {
      if (!content.equals(expected.content)) {
        changes.push(copyChange(opts, fullPath, "managed_content"));
      }
      if (mode !== expected.mode) {
        changes.push(copyChange(opts, fullPath, "executable_mode"));
      }
    } else if (!preservedPaths.has(path)) {
      changes.push(copyChange(opts, fullPath, "extra_local_path"));
    }
  }
  for (const path of expectedByPath.keys()) {
    if (!seen.has(path))
      snapshotParts.push(`copy:${join(root, ...path.split("/"))}:missing`);
  }
  return { changes, snapshotParts };
}

export async function planSubagentDestruction(opts: {
  project: string;
  dataRepo: string;
  name: string;
  key: string;
  scope: Scope;
  currentEntry: DataLockEntry;
  selectedEntry: DataLockEntry;
  reviewCommand: string;
}): Promise<PlannedDestruction> {
  await materializeSubagent({
    project: opts.project,
    dataRepo: opts.dataRepo,
    name: opts.name,
    entry: opts.selectedEntry,
    previousEntry: opts.currentEntry,
    dryRun: true,
  });
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  for (const source of await subagentSourcesAtCommit(
    opts.project,
    opts.dataRepo,
    opts.name,
    opts.currentEntry.sourceCommit,
  )) {
    if (!existsSync(source.outputPath)) {
      snapshotParts.push(`subagent:${source.outputPath}:missing`);
      continue;
    }
    const info = await lstat(source.outputPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PreconditionError(
        `managed subagent target is not a regular file: ${source.outputPath}`,
      );
    }
    const [current, expected] = await Promise.all([
      readFile(source.outputPath),
      showAtCommit(
        opts.dataRepo,
        opts.currentEntry.sourceCommit,
        source.relPath,
      ),
    ]);
    snapshotParts.push(
      `subagent:${source.outputPath}:${contentDigest(current)}`,
    );
    if (!current.equals(expected)) {
      changes.push({
        scope: opts.scope,
        item: `${opts.scope}/${opts.key}`,
        path: projectRelative(opts.project, source.outputPath),
        reason: "subagent_target",
        reviewCommand: opts.reviewCommand,
      });
    }
  }
  return { changes, snapshotParts };
}

export function planFragmentDestruction(opts: {
  project: string;
  plans: FragmentOutputPlan[];
  contributionStates: ReadonlyMap<FragmentTarget, FragmentContributionState>;
  reviewCommands: ReadonlyMap<FragmentTarget, string>;
}): PlannedDestruction {
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  for (const plan of opts.plans) {
    snapshotParts.push(
      `fragment:${plan.path}:${contentDigest(
        Buffer.from(plan.currentText ?? "\0missing", "utf8"),
      )}`,
    );
    if (!plan.changed) continue;
    const reviewCommand = opts.reviewCommands.get(plan.target);
    if (opts.contributionStates.get(plan.target) === "drifted") {
      changes.push({
        scope: "project",
        path: projectRelative(opts.project, plan.path),
        reason: "fragment_contribution",
        ...(reviewCommand && { reviewCommand }),
      });
    }
    if (plan.commentLoss) {
      changes.push({
        scope: "project",
        path: projectRelative(opts.project, plan.path),
        reason: "config_comments",
        ...(reviewCommand && { reviewCommand }),
      });
    }
  }
  return { changes, snapshotParts };
}

function copyChange(
  opts: {
    project: string;
    key: string;
    scope: Scope;
    reviewCommand: string;
  },
  fullPath: string,
  reason: "managed_content" | "executable_mode" | "extra_local_path",
): DestructiveChange {
  return {
    scope: opts.scope,
    item: `${opts.scope}/${opts.key}`,
    path: projectRelative(opts.project, fullPath),
    reason,
    reviewCommand: opts.reviewCommand,
  };
}

function projectRelative(project: string, path: string): string {
  const rel = relative(project, path);
  return rel || ".";
}

function contentDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
