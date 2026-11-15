import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DestructiveChange } from "./destructive-change";
import { classifyInstalledFile, installDifferenceLabel } from "./install-diff";
import { PreconditionError } from "./errors";
import type {
  FragmentContributionState,
  FragmentOutputPlan,
  FragmentTarget,
} from "./fragments";
import type { GitReadMemo } from "./git-read-memo";
import { inventoryLocalTree } from "./gitignore";
import { marksPluginManifest } from "./plugin-runs";
import { isOnMount, readMountLayout } from "./mount-points";
import { installedPath } from "./installed";
import { isBundled, requireContentSource } from "./item-source";
import type { ContentSource } from "./item-source";
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
import {
  materializeSubagent,
  subagentSourceAtCommit,
  subagentSourcesAtCommit,
} from "./subagents";

export interface PlannedDestruction {
  changes: DestructiveChange[];
  snapshotParts: string[];
}

export async function planCopyDirectoryDestruction(opts: {
  project: string;
  /**
   * Built by the caller so an item whose root is not the canonical layout plans
   * against the tree it actually installs from.
   */
  currentSource: ContentSource | null;
  selectedSource: ContentSource | null;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  scope: Scope;
  currentEntry: LockEntry;
  selectedEntry: LockEntry;
  reviewCommand: string;
  /**
   * Set by `update` and `lock migrate`: an unreadable previous pin is repaired
   * by planning against the selected entry rather than refused. `apply` and
   * `revert` leave it unset because the previous entry is their target, so a
   * failure to read it must reach the caller.
   */
  repairUnresolvableCurrent?: boolean;
  memo?: GitReadMemo;
}): Promise<PlannedDestruction> {
  const readReconciliationFiles = async (
    entry: LockEntry,
    candidate: ContentSource | null,
  ) => {
    // Called inside the async function on purpose: a missing source then
    // rejects like an unreadable current entry, which
    // `repairUnresolvableCurrent` catches below.
    const source = requireContentSource(candidate, opts.kind, opts.name);
    return await copyDirectoryReconciliationFiles({
      project: opts.project,
      source,
      manifest: opts.manifest,
      kind: opts.kind,
      name: opts.name,
      entry,
      previous: { entry, source },
      scope: opts.scope,
      memo: opts.memo,
    });
  };
  const current =
    opts.repairUnresolvableCurrent === true &&
    opts.currentEntry !== opts.selectedEntry
      ? await readReconciliationFiles(
          opts.currentEntry,
          opts.currentSource,
        ).catch(() =>
          readReconciliationFiles(opts.selectedEntry, opts.selectedSource),
        )
      : await readReconciliationFiles(opts.currentEntry, opts.currentSource);

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

  // A system entry records only a hash, and the bundled bytes it described are
  // gone once the bundle moves. Per-file classification against the incoming
  // bundle would report every bundled update as loss. Instead, an install that
  // still hashes to `currentEntry.sha` holds exactly what capshelf wrote and
  // counts as pristine, as in `status` drift. Any edit changes the hash, so a
  // real local change still reaches consent.
  const currentSource = requireContentSource(
    opts.currentSource,
    opts.kind,
    opts.name,
  );
  const pristineSystemInstall =
    isBundled(currentSource) &&
    (await shaOfInstalledForScope(
      opts.project,
      opts.kind,
      opts.name,
      opts.scope,
    )) === currentSource.sha;

  const expectedByPath = new Map(
    current.expected.map((file) => [file.path, file]),
  );
  const preservedPaths = new Set(current.preserved.map((entry) => entry.path));
  // Managed paths are classified against the current entry to avoid reporting
  // routine updates as loss, but only the selected entry knows a local-state
  // path it pins will be destroyed.
  const selectedPaths =
    opts.currentEntry === opts.selectedEntry
      ? null
      : await readReconciliationFiles(opts.selectedEntry, opts.selectedSource)
          .then((files) => new Set(files.expected.map((file) => file.path)))
          .catch(() => null);
  const seen = new Set<string>();
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  const inventory = await inventoryLocalTree(root);
  for (const path of inventory.files) {
    seen.add(path);
    const fullPath = join(root, ...path.split("/"));
    // A kept ignored file is recorded by type only so cache writes don't
    // invalidate consent; paths the selected entry writes and plugin manifests
    // keep their digest because they are destroyed or decide what runs.
    if (
      preservedPaths.has(path) &&
      selectedPaths?.has(path) !== true &&
      !marksPluginManifest(path, false)
    ) {
      snapshotParts.push(`copy:${fullPath}:preserved:file`);
      continue;
    }
    const [info, content] = await Promise.all([
      lstat(fullPath),
      readFile(fullPath),
    ]);
    const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
    snapshotParts.push(`copy:${fullPath}:${mode}:${contentDigest(content)}`);
    const expected = expectedByPath.get(path);
    if (expected) {
      const difference = classifyInstalledFile({
        path,
        installed: content,
        pinned: expected.content,
        installedMode: mode,
        pinnedMode: expected.mode,
      });
      const detail = installDifferenceLabel(difference);
      if (!content.equals(expected.content)) {
        changes.push(
          copyChange(opts, fullPath, "managed_content", detail ?? undefined),
        );
      }
      if (mode !== expected.mode) {
        changes.push(copyChange(opts, fullPath, "executable_mode"));
      }
    } else if (!preservedPaths.has(path)) {
      changes.push(
        copyChange(
          opts,
          fullPath,
          "extra_local_path",
          installDifferenceLabel({ path, kind: "visible-extra" }) ?? undefined,
        ),
      );
    } else if (selectedPaths?.has(path) === true) {
      changes.push(copyChange(opts, fullPath, "managed_content"));
    }
  }
  for (const object of inventory.irregular) {
    seen.add(object.path);
    snapshotParts.push(
      await irregularSnapshotPart(root, object.path, object.type),
    );
    // Preserved symlinks survive replacement; unpreserved symlinks require
    // consent because replacement deletes them. Reconciliation refuses other
    // non-regular objects because replacement cannot recreate them.
    if (!preservedPaths.has(object.path)) {
      changes.push(
        copyChange(
          opts,
          join(root, ...object.path.split("/")),
          "extra_local_path",
          installDifferenceLabel({
            path: object.path,
            kind: "visible-extra",
          }) ?? undefined,
        ),
      );
    }
  }
  for (const path of expectedByPath.keys()) {
    if (!seen.has(path))
      snapshotParts.push(`copy:${join(root, ...path.split("/"))}:missing`);
  }
  return {
    // For a pristine bundled install only content claims are dropped, because
    // its hash matching the entry's sha witnesses bytes alone. Mode flips and
    // extra local paths stay real loss. `snapshotParts` still catches edits
    // between plan and write.
    changes: pristineSystemInstall
      ? changes.filter((change) => change.reason !== "managed_content")
      : changes,
    snapshotParts,
  };
}

/**
 * Removal must not depend on the data repo: when the source is unreachable
 * every path becomes `extra_local_path` and needs consent, since failing would
 * strand the item.
 */
export async function planCopyDirectoryRemoval(opts: {
  project: string;
  /**
   * Null means the bytes are unreadable: every installed path becomes
   * `extra_local_path`, is named in the prompt, and is deleted only with
   * consent.
   */
  currentSource: ContentSource | null;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  scope: Scope;
  reviewCommand: string;
}): Promise<PlannedDestruction> {
  let expectedFiles: NamedFile[];
  try {
    expectedFiles = await lockedCopyDirectoryFiles({
      source: requireContentSource(opts.currentSource, opts.kind, opts.name),
      manifest: opts.manifest,
      kind: opts.kind,
      name: opts.name,
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
  // Removal keeps mounted volumes, so mount paths are neither listed nor read,
  // and the layout is snapshotted so a mount change after consent refuses the
  // write.
  const layout = await readMountLayout(root);
  const snapshotParts: string[] = [`mounts:${[...layout.mounts].join(",")}`];
  const inventory = await inventoryLocalTree(root);
  for (const path of inventory.files) {
    seen.add(path);
    if (isOnMount(layout, path)) continue;
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
  // A symlink's target, not a content digest, is recorded in the snapshot so a
  // retarget between prompt and write is detected.
  for (const object of inventory.irregular) {
    seen.add(object.path);
    if (isOnMount(layout, object.path)) continue;
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
  repairUnresolvableCurrent?: boolean;
  memo?: GitReadMemo;
}): Promise<PlannedDestruction> {
  const repairable =
    opts.repairUnresolvableCurrent === true &&
    opts.currentEntry !== opts.selectedEntry;
  await materializeSubagent({
    project: opts.project,
    dataRepo: opts.dataRepo,
    name: opts.name,
    entry: opts.selectedEntry,
    previousEntry: opts.currentEntry,
    dryRun: true,
    memo: opts.memo,
  });
  // Compare against the previous pin, or the selected commit when that pin is
  // unresolvable and being repaired, so a target already holding the incoming
  // bytes isn't reported as loss.
  const basisEntry = repairable
    ? await subagentSourcesAtCommit(
        opts.project,
        opts.dataRepo,
        opts.name,
        opts.currentEntry.sourceCommit,
        opts.memo,
      ).then(
        () => opts.currentEntry,
        () => opts.selectedEntry,
      )
    : opts.currentEntry;
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  for (const source of await subagentSourcesAtCommit(
    opts.project,
    opts.dataRepo,
    opts.name,
    basisEntry.sourceCommit,
    opts.memo,
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
      subagentSourceAtCommit(
        opts.dataRepo,
        opts.name,
        basisEntry.sourceCommit,
        source.relPath,
        opts.memo,
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
    // Only `gate` targets need consent; for strict-JSON targets the comments
    // already break loading, so the rewrite repairs it (see
    // `commentLossPolicy`).
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
  detail?: string,
): DestructiveChange {
  return {
    scope: opts.scope,
    item: `${opts.scope}/${opts.key}`,
    path: projectRelative(opts.project, fullPath),
    reason,
    ...(detail !== undefined && { detail }),
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
