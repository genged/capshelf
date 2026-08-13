import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectDataRepo } from "../command-context";
import {
  confirmDestructiveChanges,
  createDestructiveChangePlan,
  type DestructiveChange,
} from "../destructive-change";
import { planCopyDirectoryDestruction } from "../destructive-preflight";
import { PreconditionError, ResultExitError } from "../errors";
import { atomicWriteFile } from "../fs-utils";
import { resolveCommit } from "../git";
import { PRODUCT_NAME } from "../identity";
import { parseLockKey } from "../installed";
import {
  LOCK_VERSION,
  isLockV4,
  loadLocalLock,
  loadLock,
  serializeLock,
} from "../lock";
import type { DataLockEntry, LockEntryV4, Lock, LockV4 } from "../lock";
import { legacyShaAtCommit } from "../lock-verify";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { itemRepoRelPath } from "../master";
import { materializeLockEntry } from "../materialize";
import { loadCommittedItemNeeds } from "../metadata";
import { localLockPath, lockPath, lockReadPath, projectRoot } from "../paths";
import {
  filteredPathsAtCommit,
  filterRefusalMessage,
  itemTreeEntriesAtCommit,
  pinItemAtCommit,
  pinCurrentSource,
} from "../pin";
import { needsEqual } from "../lock";
import { createDataLockEntry } from "../lock";
import { captureCommittedItemNeeds } from "../metadata";

type MigrationScope = "project" | "local";

type ConversionOutcome = "converted" | "repaired-legacy-identity";

interface ConvertedEntry {
  scope: MigrationScope;
  key: string;
  ref: string;
  outcome: ConversionOutcome;
  entry: LockEntryV4;
}

interface Blocker {
  scope: MigrationScope;
  key: string;
  ref: string;
  reason: string;
  detail: string[];
}

interface RepairSelection {
  repin: Set<string>;
  remove: Set<string>;
}

interface LockSnapshot {
  scope: MigrationScope;
  path: string;
  /** The bytes on disk before planning, or null when the file is absent. */
  before: string | null;
  lock: Lock;
}

interface MigrationPlan {
  snapshots: LockSnapshot[];
  converted: ConvertedEntry[];
  repinned: ConvertedEntry[];
  removed: Array<{ scope: MigrationScope; key: string; ref: string }>;
  blocked: Blocker[];
  candidates: Map<MigrationScope, LockV4>;
  changes: DestructiveChange[];
}

export function registerLock(program: Command): void {
  const lock = program
    .command("lock")
    .description("inspect and migrate this project's lock files");

  lock
    .command("migrate")
    .description(
      `convert the project and local locks to version ${LOCK_VERSION} in one transaction`,
    )
    .option("--dry-run", "plan the complete migration without writing")
    .option(
      "--repin <ref...>",
      "re-pin a blocked copy item or subagent to its current committed source",
    )
    .option(
      "--remove-item <ref...>",
      "remove a blocked item instead of migrating it",
    )
    .option("--yes", "authorize the installed-state loss a repair would cause")
    .option("--json", "output JSON")
    .action(
      async (
        opts: {
          dryRun?: boolean;
          repin?: string[];
          removeItem?: string[];
          yes?: boolean;
          json?: boolean;
        },
        cmd: Command,
      ) => {
        await runMigrate(opts, cmd);
      },
    );
}

async function runMigrate(
  opts: {
    dryRun?: boolean;
    repin?: string[];
    removeItem?: string[];
    yes?: boolean;
    json?: boolean;
  },
  cmd: Command,
): Promise<void> {
  const project = projectRoot();
  const manifest = await loadManifest(project);
  const snapshots = await readLockSnapshots(project);

  if (snapshots.every((snapshot) => isLockV4(snapshot.lock))) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            project,
            action: "already-current",
            version: LOCK_VERSION,
            converted: [],
            repairedLegacyIdentity: [],
            repinned: [],
            removed: [],
            blocked: [],
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`✓ already version ${LOCK_VERSION}`);
    return;
  }

  const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);
  const selection: RepairSelection = {
    repin: new Set(opts.repin ?? []),
    remove: new Set(opts.removeItem ?? []),
  };

  const plan = await planMigration({
    project,
    dataRepo,
    manifest,
    snapshots,
    selection,
  });

  if (plan.blocked.length > 0) {
    printBlocked(plan, opts.json === true);
    throw new ResultExitError(3);
  }

  if (opts.dryRun) {
    printPlan(plan, { dryRun: true, json: opts.json === true });
    return;
  }

  const destructivePlan = createDestructiveChangePlan(plan.changes);
  if (
    !(await confirmDestructiveChanges(destructivePlan, {
      operation: "Lock migration",
      json: opts.json === true,
      yes: opts.yes === true,
      dryRun: false,
      rerunCommand: `${PRODUCT_NAME} lock migrate --yes`,
    }))
  ) {
    return;
  }

  // Planning completes before publication. Re-read the original bytes so a
  // concurrent lock change aborts *before* anything is written rather than
  // leaving one converted file behind.
  await assertLockSnapshotsUnchanged(plan.snapshots);
  await publishMigration(project, dataRepo, manifest, plan);
  printPlan(plan, { dryRun: false, json: opts.json === true });
}

async function readLockSnapshots(project: string): Promise<LockSnapshot[]> {
  const projectPath = lockReadPath(project) ?? lockPath(project);
  const localPath = localLockPath(project);
  return [
    {
      scope: "project",
      path: projectPath,
      before: existsSync(projectPath)
        ? await readFile(projectPath, "utf-8")
        : null,
      lock: await loadLock(project),
    },
    {
      scope: "local",
      path: localPath,
      before: existsSync(localPath) ? await readFile(localPath, "utf-8") : null,
      lock: await loadLocalLock(project),
    },
  ];
}

async function assertLockSnapshotsUnchanged(
  snapshots: LockSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    const now = existsSync(snapshot.path)
      ? await readFile(snapshot.path, "utf-8")
      : null;
    if (now !== snapshot.before) {
      throw new PreconditionError(
        `${snapshot.path} changed while the migration was being planned; nothing was written`,
        { hint: "Re-run `capshelf lock migrate`." },
      );
    }
  }
}

/**
 * PIN-12. The default migration **does not select new source content**: for
 * every data entry it resolves the recorded commit, reads the kind-specific
 * committed tree, checks committed filter attributes, builds the pin through
 * the one constructor, and carries every non-identity field across unchanged.
 *
 * The old `sha` is audit evidence, not an input. The legacy hash is recomputed
 * from the recorded commit and compared; a disagreement is reported as
 * `repaired-legacy-identity` rather than silently dropped, because it is
 * exactly the contradiction — a lock that no command could satisfy — this
 * design exists to remove.
 */
async function planMigration(input: {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  snapshots: LockSnapshot[];
  selection: RepairSelection;
}): Promise<MigrationPlan> {
  const converted: ConvertedEntry[] = [];
  const repinned: ConvertedEntry[] = [];
  const removed: MigrationPlan["removed"] = [];
  const blocked: Blocker[] = [];
  const changes: DestructiveChange[] = [];
  const candidates = new Map<MigrationScope, LockV4>();

  for (const snapshot of input.snapshots) {
    const candidate: LockV4 = { version: LOCK_VERSION, items: {} };
    for (const [key, entry] of Object.entries(snapshot.lock.items)) {
      if (entry.source === "system") {
        // System identity stays the bundled `sha`: those items carry no
        // source commit and nothing to re-derive.
        candidate.items[key] = entry;
        continue;
      }
      const parsed = parseLockKey(key);
      const ref = `${parsed.kind}/${parsed.name}`;
      const scopedRef = `${snapshot.scope}/${ref}`;

      if (
        input.selection.remove.has(ref) ||
        input.selection.remove.has(scopedRef)
      ) {
        removed.push({ scope: snapshot.scope, key, ref });
        continue;
      }

      const wantsRepin =
        input.selection.repin.has(ref) || input.selection.repin.has(scopedRef);
      try {
        const result = wantsRepin
          ? await repinEntry(input, snapshot.scope, parsed, entry)
          : await convertEntry(input, snapshot.scope, key, ref, entry);
        candidate.items[key] = result.entry;
        (wantsRepin ? repinned : converted).push(result);
        if (wantsRepin) {
          changes.push(
            ...(await plannedRepairLoss(
              input,
              snapshot.scope,
              key,
              parsed,
              entry,
              result.entry,
            )),
          );
        }
      } catch (error) {
        blocked.push({
          scope: snapshot.scope,
          key,
          ref,
          reason: error instanceof Error ? error.message : String(error),
          detail: repairChoices(ref, parsed.kind),
        });
      }
    }
    candidates.set(snapshot.scope, candidate);
  }

  // Strict-parse both complete candidates before anything is published. A
  // serializer that dropped a digest has to fail here, not after a write.
  for (const candidate of candidates.values()) serializeLock(candidate);

  return {
    snapshots: input.snapshots,
    converted,
    repinned,
    removed,
    blocked,
    candidates,
    changes,
  };
}

async function convertEntry(
  input: { dataRepo: string; manifest: Manifest },
  scope: MigrationScope,
  key: string,
  ref: string,
  entry: DataLockEntry,
): Promise<ConvertedEntry> {
  if (entry.sourcePinDigest !== undefined) {
    // Already version 4 — the other lock file is the one being converted.
    return { scope, key, ref, outcome: "converted", entry };
  }
  const parsed = parseLockKey(key);
  const resolved = await resolveCommit(input.dataRepo, entry.sourceCommit);
  if (resolved === null) {
    throw new Error(
      `source commit ${entry.sourceCommit} cannot be resolved in ${input.dataRepo}`,
    );
  }
  const entries = await itemTreeEntriesAtCommit(
    input.dataRepo,
    parsed.kind,
    parsed.name,
    resolved,
  );
  if (entries.length === 0) {
    throw new Error(
      `${itemRepoRelPath(parsed.kind, parsed.name)} has no committed content at ${resolved}`,
    );
  }
  const filtered = await filteredPathsAtCommit(input.dataRepo, resolved, [
    { kind: parsed.kind, name: parsed.name, entries },
  ]);
  if (filtered.length > 0) throw new Error(filterRefusalMessage(filtered));

  await assertNeedsProvenance(input, parsed, entry);

  const pin = await pinItemAtCommit(
    input.dataRepo,
    parsed.kind,
    parsed.name,
    resolved,
    { skipFilterCheck: true },
  );
  const outcome = await auditLegacySha(input, parsed, entry, resolved);
  return {
    scope,
    key,
    ref,
    outcome,
    entry: createDataLockEntry({
      pin,
      // `appliedAt` is preserved: the migration did not apply content.
      appliedAt: entry.appliedAt,
      needs: entry.needs ?? { network: [], env: [], bin: [] },
      needsSourceCommit: entry.needsSourceCommit ?? resolved,
      ...(entry.label !== undefined && { label: entry.label }),
      ...(entry.local === true && { local: true as const }),
      ...(entry.localReason !== undefined && {
        localReason: entry.localReason,
      }),
    }),
  };
}

/**
 * The legacy hash the entry recorded, recomputed from the commit it names.
 * A mismatch does not select different content — the commit was already what
 * `apply` materialized from — so it is reported, not repaired away silently.
 */
async function auditLegacySha(
  input: { dataRepo: string; manifest: Manifest },
  parsed: ReturnType<typeof parseLockKey>,
  entry: DataLockEntry,
  commit: string,
): Promise<ConversionOutcome> {
  if (entry.sha === undefined) return "converted";
  try {
    const legacy = await legacyShaAtCommit(
      input.dataRepo,
      input.manifest,
      parsed.kind,
      parsed.name,
      commit,
    );
    return legacy === entry.sha ? "converted" : "repaired-legacy-identity";
  } catch {
    return "repaired-legacy-identity";
  }
}

async function assertNeedsProvenance(
  input: { dataRepo: string },
  parsed: ReturnType<typeof parseLockKey>,
  entry: DataLockEntry,
): Promise<void> {
  if (entry.needs == null || entry.needsSourceCommit == null) return;
  const resolved = await resolveCommit(input.dataRepo, entry.needsSourceCommit);
  if (resolved === null) {
    throw new Error(
      `recorded needs commit ${entry.needsSourceCommit} cannot be resolved`,
    );
  }
  const metadata = await loadCommittedItemNeeds(
    input.dataRepo,
    { kind: parsed.kind, name: parsed.name },
    resolved,
  );
  if (!needsEqual(metadata.needs, entry.needs)) {
    throw new Error(
      `recorded needs for ${parsed.kind}/${parsed.name} do not match ${resolved}`,
    );
  }
}

/**
 * An explicit `--repin`: update semantics inside the migration transaction.
 * It computes a new pin from the item's current committed source and captures
 * current needs. PIN-8 still forbids fragment repair — a fragment's former
 * contribution cannot be told apart from a project-local value once its commit
 * is gone.
 */
async function repinEntry(
  input: { dataRepo: string },
  scope: MigrationScope,
  parsed: ReturnType<typeof parseLockKey>,
  entry: DataLockEntry,
): Promise<ConvertedEntry> {
  const ref = `${parsed.kind}/${parsed.name}`;
  if (
    parsed.kind === "settings" ||
    parsed.kind === "mcp" ||
    parsed.kind === "codex-config"
  ) {
    throw new Error(
      `${ref} is a fragment; its contribution cannot be recovered from the merged output. Remove it and add it again instead.`,
    );
  }
  const pin = await pinCurrentSource(input.dataRepo, parsed.kind, parsed.name);
  const snapshot = await captureCommittedItemNeeds(input.dataRepo, {
    kind: parsed.kind,
    name: parsed.name,
  });
  return {
    scope,
    key: `data/${ref}`,
    ref,
    outcome: "repaired-legacy-identity",
    entry: createDataLockEntry({
      pin,
      ...snapshot,
      ...(entry.label !== undefined && { label: entry.label }),
      ...(entry.local === true && { local: true as const }),
      ...(entry.localReason !== undefined && {
        localReason: entry.localReason,
      }),
    }),
  };
}

async function plannedRepairLoss(
  input: { project: string; dataRepo: string; manifest: Manifest },
  scope: MigrationScope,
  key: string,
  parsed: ReturnType<typeof parseLockKey>,
  currentEntry: DataLockEntry,
  selectedEntry: LockEntryV4,
): Promise<DestructiveChange[]> {
  if (parsed.kind !== "skills" && parsed.kind !== "pi-extensions") return [];
  const planned = await planCopyDirectoryDestruction({
    project: input.project,
    dataRepo: input.dataRepo,
    manifest: input.manifest,
    kind: parsed.kind,
    name: parsed.name,
    key,
    scope,
    currentEntry,
    selectedEntry,
    reviewCommand: `${PRODUCT_NAME} status ${parsed.kind}/${parsed.name} --diff`,
    repairUnresolvableCurrent: true,
  }).catch(() => null);
  return planned?.changes ?? [];
}

function repairChoices(ref: string, kind: string): string[] {
  const isFragment =
    kind === "settings" || kind === "mcp" || kind === "codex-config";
  return [
    "restore or fetch the exact source commit, then retry migration",
    ...(isFragment
      ? [
          `remove and re-add the item: ${PRODUCT_NAME} lock migrate --remove-item ${ref}`,
        ]
      : [
          `re-pin it to its current committed source: ${PRODUCT_NAME} lock migrate --repin ${ref}`,
          `or remove it: ${PRODUCT_NAME} lock migrate --remove-item ${ref}`,
        ]),
  ];
}

/**
 * Publish. Installed-state repairs run first, then both lock files. On any
 * failure the original lock bytes are restored, so no completed command can
 * leave one converted lock beside an unconverted one.
 */
async function publishMigration(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  plan: MigrationPlan,
): Promise<void> {
  const written: LockSnapshot[] = [];
  try {
    for (const repair of plan.repinned) {
      const parsed = parseLockKey(repair.key);
      if (parsed.kind !== "skills" && parsed.kind !== "pi-extensions") continue;
      await materializeLockEntry({
        project,
        dataRepo,
        manifest,
        key: repair.key,
        entry: repair.entry,
        scope: repair.scope,
        ignoreLocal: true,
      });
    }
    for (const snapshot of plan.snapshots) {
      const candidate = plan.candidates.get(snapshot.scope);
      if (!candidate) continue;
      if (snapshot.before === null && Object.keys(candidate.items).length === 0)
        continue;
      await mkdir(dirname(snapshot.path), { recursive: true });
      await atomicWriteFile(snapshot.path, serializeLock(candidate));
      written.push(snapshot);
    }
  } catch (error) {
    for (const snapshot of written) {
      if (snapshot.before === null) {
        await rm(snapshot.path, { force: true }).catch(() => {});
      } else {
        await atomicWriteFile(snapshot.path, snapshot.before).catch(() => {});
      }
    }
    throw error;
  }
}

function printBlocked(plan: MigrationPlan, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          action: "blocked",
          converted: refsOf(plan.converted),
          repairedLegacyIdentity: refsOf(
            plan.converted.filter(
              (entry) => entry.outcome === "repaired-legacy-identity",
            ),
          ),
          repinned: refsOf(plan.repinned),
          removed: plan.removed.map((entry) => `${entry.scope}/${entry.ref}`),
          blocked: plan.blocked.map((blocker) => ({
            scope: blocker.scope,
            ref: blocker.ref,
            reason: blocker.reason,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("Lock migration blocked:");
  for (const blocker of plan.blocked) {
    console.log(`  ${blocker.scope}/data/${blocker.ref}`);
    for (const line of blocker.reason.split("\n")) console.log(`    ${line}`);
    for (const choice of blocker.detail) console.log(`    ${choice}`);
  }
  console.log("No lock or installed file was changed.");
}

function printPlan(
  plan: MigrationPlan,
  opts: { dryRun: boolean; json: boolean },
): void {
  const repaired = plan.converted.filter(
    (entry) => entry.outcome === "repaired-legacy-identity",
  );
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          action: opts.dryRun ? "would-migrate" : "migrated",
          version: LOCK_VERSION,
          dryRun: opts.dryRun,
          converted: refsOf(plan.converted),
          repairedLegacyIdentity: refsOf(repaired),
          repinned: refsOf(plan.repinned),
          removed: plan.removed.map((entry) => `${entry.scope}/${entry.ref}`),
          blocked: [],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (opts.dryRun) {
    console.log(`Lock migration: → version ${LOCK_VERSION}`);
  } else {
    console.log(
      `✓ migrated project and local locks to version ${LOCK_VERSION}`,
    );
  }
  console.log(`  converted                  ${plan.converted.length}`);
  console.log(`  repaired legacy identity   ${repaired.length}`);
  if (plan.repinned.length > 0) {
    console.log(`  re-pinned                  ${plan.repinned.length}`);
  }
  if (plan.removed.length > 0) {
    console.log(`  removed                    ${plan.removed.length}`);
  }
  console.log("  blocked                    0");
  if (opts.dryRun) console.log("Dry run; nothing written.");
}

function refsOf(entries: ConvertedEntry[]): string[] {
  return entries.map((entry) => `${entry.scope}/${entry.ref}`);
}
