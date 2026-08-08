import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DestructiveChange } from "./destructive-change";
import { PreconditionError } from "./errors";
import type {
  FragmentContributionState,
  FragmentOutputPlan,
  FragmentTarget,
} from "./fragments";
import { showAtCommit } from "./git";
import { inventoryLocalTree } from "./gitignore";
import { installedPath } from "./installed";
import { shaOfInstalledForScope } from "./item-snapshot";
import type { DataLockEntry, LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import {
  copyDirectoryReconciliationFiles,
  lockedCopyDirectoryFiles,
} from "./materialize";
import type { NamedFile } from "./merge-tree";
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

  const root = installedPath(
    opts.project,
    opts.kind,
    opts.name,
    opts.manifest?.installMode,
  );
  if (!existsSync(root)) {
    return { changes: [], snapshotParts: [`missing:${root}`] };
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PreconditionError(
      `managed copy-item target is not a regular directory: ${root}`,
    );
  }

  // A system entry records what capshelf last wrote, not something it can read
  // back: the binary carries one copy of the bundled tree, so once that content
  // moves, the superseded bytes are gone. Per-file classification therefore
  // compares the install against the *incoming* bundle, which would report
  // every routine bundled update as managed-content loss.
  //
  // The aggregate question the entry can still answer is the one that matters:
  // an install that still hashes to `currentEntry.sha` holds exactly the bytes
  // capshelf wrote, so replacing them with a newer bundle destroys nothing. Any
  // edit to a managed file changes that hash, so a real local change still
  // reaches the consent boundary. This is the same comparison `status` uses to
  // call an item drifted — capshelf prompts for a bundled update exactly when
  // `status` says the install diverged.
  const pristineSystemInstall =
    opts.currentEntry.source === "system" &&
    (await shaOfInstalledForScope(
      opts.project,
      opts.kind,
      opts.name,
      opts.scope,
    )) === opts.currentEntry.sha;

  const expectedByPath = new Map(
    current.expected.map((file) => [file.path, file]),
  );
  const preservedPaths = new Set(current.preserved.map((entry) => entry.path));
  const seen = new Set<string>();
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  const inventory = await inventoryLocalTree(root);
  for (const path of inventory.files) {
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
  for (const object of inventory.irregular) {
    seen.add(object.path);
    snapshotParts.push(
      await irregularSnapshotPart(root, object.path, object.type),
    );
    // Preserved symlinks are carried across the replacement, so they are not
    // destroyed. Anything else here was already refused by the reconciliation
    // preflight above; listing it keeps the plan honest if that ever changes.
    if (!preservedPaths.has(object.path)) {
      changes.push(
        copyChange(
          opts,
          join(root, ...object.path.split("/")),
          "extra_local_path",
        ),
      );
    }
  }
  for (const path of expectedByPath.keys()) {
    if (!seen.has(path))
      snapshotParts.push(`copy:${join(root, ...path.split("/"))}:missing`);
  }
  return {
    // Only content claims are dropped: the sha witnesses bytes, so an
    // executable-mode flip or an extra local path is still real loss the user
    // has to authorize. `snapshotParts` is built from the installed tree in
    // both cases, so `assertDestructivePlanUnchanged` still catches an edit
    // made between the plan and the write.
    changes: pristineSystemInstall
      ? changes.filter((change) => change.reason !== "managed_content")
      : changes,
    snapshotParts,
  };
}

/**
 * Inventory every object that removal would delete, including ignored files
 * and symlinks.
 *
 * Untracking must not depend on the data repo. The locked file set is only
 * used to label a path as reproducible managed content rather than unique
 * local state, so when the source is unreachable — a deleted clone, a
 * garbage-collected or squash-orphaned `sourceCommit` — every installed path
 * degrades to `extra_local_path` and the user consents to the full deletion
 * list. Failing the command instead would strand the item: those are exactly
 * the situations where `rm` is what the user needs.
 */
export async function planCopyDirectoryRemoval(opts: {
  project: string;
  dataRepo?: string;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  scope: Scope;
  currentEntry: LockEntry;
  reviewCommand: string;
}): Promise<PlannedDestruction> {
  let expectedFiles: NamedFile[];
  try {
    expectedFiles = await lockedCopyDirectoryFiles({
      dataRepo: opts.dataRepo,
      manifest: opts.manifest,
      kind: opts.kind,
      name: opts.name,
      entry: opts.currentEntry,
    });
  } catch {
    expectedFiles = [];
  }
  const root = installedPath(
    opts.project,
    opts.kind,
    opts.name,
    opts.manifest?.installMode,
  );
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
    expectedFiles.map((file) => [file.path, file]),
  );
  const seen = new Set<string>();
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  const inventory = await inventoryLocalTree(root);
  for (const path of inventory.files) {
    seen.add(path);
    const fullPath = join(root, ...path.split("/"));
    const [info, content] = await Promise.all([
      lstat(fullPath),
      readFile(fullPath),
    ]);
    const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
    snapshotParts.push(`copy:${fullPath}:${mode}:${contentDigest(content)}`);
    const expected = expectedByPath.get(path);
    if (!expected) {
      changes.push(copyChange(opts, fullPath, "extra_local_path"));
      continue;
    }
    if (!content.equals(expected.content)) {
      changes.push(copyChange(opts, fullPath, "managed_content"));
    }
    if (mode !== expected.mode) {
      changes.push(copyChange(opts, fullPath, "executable_mode"));
    }
  }
  // Symlinks and other non-regular objects are deleted with the tree, so the
  // user must see them. Recording a symlink's target in the snapshot — not a
  // content digest, which a link does not have — is what lets
  // assertDestructivePlanUnchanged notice a retarget between prompt and write.
  for (const object of inventory.irregular) {
    seen.add(object.path);
    snapshotParts.push(
      await irregularSnapshotPart(root, object.path, object.type),
    );
    changes.push(
      copyChange(
        opts,
        join(root, ...object.path.split("/")),
        "extra_local_path",
      ),
    );
  }
  for (const path of expectedByPath.keys()) {
    if (!seen.has(path)) {
      snapshotParts.push(`copy:${join(root, ...path.split("/"))}:missing`);
    }
  }
  return { changes, snapshotParts };
}

async function irregularSnapshotPart(
  root: string,
  path: string,
  type: "symlink" | "other",
): Promise<string> {
  const fullPath = join(root, ...path.split("/"));
  const target =
    type === "symlink" ? await readlink(fullPath).catch(() => "") : "";
  return `copy:${fullPath}:${type}:${target}`;
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
    // Only `gate` targets reach the consent boundary. For strict-JSON targets
    // the comments were already stopping the consuming tool from loading the
    // file, so the rewrite repairs it — `applyFragmentOutputPlans` announces
    // that instead of asking the user to authorize keeping it broken. See
    // `commentLossPolicy`.
    if (plan.commentLoss && plan.commentPolicy === "gate") {
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
