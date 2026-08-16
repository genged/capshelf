import type { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { lstatOrNull } from "../fs-utils";
import { join } from "node:path";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
  listMasterItems,
  shaOfGitVisibleItem,
} from "../master";
import { homeRelative, findProjectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { isBundleRef, loadBundle, memberRef } from "../bundles";
import {
  entryIdentity,
  loadLocalLock,
  loadLock,
  emptyLock,
  dataKey,
  systemKey,
} from "../lock";
import type { Lock, LockEntry } from "../lock";
import type { MasterItem } from "../master";
import { shortIdentity } from "../pin";
import { loadManifest } from "../manifest";
import {
  captureCommittedItemNeeds,
  emptyNeeds,
  loadDataItemMetadata,
  loadSystemItemMetadata,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata, ItemNeeds } from "../metadata";
import { findSystemItem, shaOfSystemItem } from "../bundled";
import { assertIsGitRepo, headSha, sourceVisibleFilesUnderPath } from "../git";
import { globalOpts } from "../global-options";
import { NotFoundError, PreconditionError } from "../errors";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { isIgnoredDotEntry } from "../dotfiles";
import {
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  shaOfFragmentItem,
  sourceMatchesCliTarget,
  sourceTargetForCli,
} from "../fragments";
import type { FragmentSourceTarget } from "../fragments";
import {
  RUNTIME_TARGET_LABELS,
  itemTargetCoverageAtCommit,
  printTargetCoverage,
  restrictCoverage,
  targetCoverageJson,
  unknownTargetCoverage,
} from "../target-coverage";
import type { TargetCoverageReport } from "../target-coverage";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import { deriveNeedsState } from "../status-core";
import { formatDeclaredNeeds } from "../needs-format";
import {
  currentSubagentSources,
  isSubagentTarget,
  shaOfCurrentSubagent,
} from "../subagents";

interface ShowOptions {
  json?: boolean;
  content?: boolean;
  target?: string;
}

export function registerShow(program: Command): void {
  program
    .command("show <item>")
    .description("print metadata and content for an item (data or system)")
    .option(
      "--target <target>",
      "runtime target for mcp or subagents: claude or codex",
    )
    .option("--json", "output JSON (no content dump)")
    .option("--no-content", "skip content dump")
    .action(async (itemRef: string, opts: ShowOptions, cmd: Command) => {
      // Bundle refs branch BEFORE parseItemRef: the parser rejects "bundles"
      // as an item kind, so testing afterwards would be dead code behind an
      // exit-1 throw.
      const bundleName = isBundleRef(itemRef);
      if (bundleName !== null) {
        await showBundle(bundleName, opts, cmd);
        return;
      }

      const ref = parseItemRef(itemRef);
      // Browse-only: works inside a project (showing install/tracking status)
      // or anywhere with --data / $CAPSHELF_HOME (locks default to empty), so an
      // item can be inspected before its shelf is adopted.
      const project = findProjectRoot();
      const manifest = project ? await loadManifest(project) : null;
      const lock = project ? await loadLock(project) : emptyLock();
      const localLock = project ? await loadLocalLock(project) : emptyLock();

      const systemItem = findSystemItem(ref.name);
      if (
        systemItem &&
        (ref.kind === undefined || systemItem.kind === ref.kind)
      ) {
        await showSystem(ref.name, lock, localLock, opts);
        return;
      }

      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project: project ?? undefined,
      });
      await assertIsGitRepo(dataRepo);
      const item = await findMasterItemByRef(dataRepo, ref);
      if (!item) {
        throw new NotFoundError(`not found: ${itemRef}`);
      }
      if (
        !isCopyDirectoryItemKind(item.kind) &&
        !isCopyTargetFileItemKind(item.kind) &&
        !isFragmentItemKind(item.kind)
      ) {
        throw new Error(`no show strategy for ${item.kind}/${item.name}`);
      }
      const cliTarget = sourceTargetForCli(opts.target);
      if (opts.target !== undefined && !isSubagentTarget(opts.target)) {
        throw new PreconditionError(
          `invalid target "${opts.target}"; must be claude or codex`,
        );
      }
      if (
        !isFragmentItemKind(item.kind) &&
        item.kind !== "subagents" &&
        cliTarget
      ) {
        throw new PreconditionError(
          "--target is only valid for mcp fragments or subagents",
        );
      }
      if (isFragmentItemKind(item.kind) && item.kind !== "mcp" && cliTarget) {
        throw new PreconditionError("--target is only valid for mcp fragments");
      }
      const fragmentSources = isFragmentItemKind(item.kind)
        ? (
            await currentFragmentSourcesForItem(dataRepo, item.kind, item.name)
          ).filter((source) => sourceMatchesCliTarget(source, cliTarget))
        : [];
      const subagentSources =
        item.kind === "subagents"
          ? (
              await currentSubagentSources(project ?? "", dataRepo, item.name)
            ).filter(
              (source) =>
                opts.target === undefined || source.target === opts.target,
            )
          : [];
      const projectEntry = lock.items[dataKey(item.kind, item.name)];
      const lockEntry =
        projectEntry ?? localLock.items[dataKey(item.kind, item.name)] ?? null;
      // `update` needs an item this project tracks; the canonical-path
      // sentence needs nothing, so browse-only show prints it alone.
      const tracked = project !== null && lockEntry !== null;
      const itemLabel = `${item.kind}/${item.name}`;
      const wholeCoverage = await showTargetCoverage(
        project,
        dataRepo,
        item,
        lockEntry,
      );
      const coverage = wholeCoverage
        ? restrictCoverage(wholeCoverage, cliTarget)
        : null;
      // A canonical source reached through a symlink is not a source. The pin
      // refuses the item outright (`assertRegularBlobEntries`), and coverage
      // now reports mode-120000 entries as absent — so without this, `show`
      // would print "Codex absent" and then dump the link's target, which can
      // be any file the link points at, inside the item or not.
      for (const relPath of [
        ...fragmentSources.map((source) => source.relPath),
        ...subagentSources.map((source) => source.relPath),
      ]) {
        const stat = lstatOrNull(join(dataRepo, ...relPath.split("/")));
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
          throw new PreconditionError(
            `${relPath} is not a regular file\n` +
              "  capshelf never reads a canonical source through a symlink or a special file; the pin refuses this item too.",
          );
        }
      }
      if (isFragmentItemKind(item.kind) && fragmentSources.length === 0) {
        throw missingTargetSource(itemLabel, cliTarget, wholeCoverage, tracked);
      }
      if (item.kind === "subagents" && subagentSources.length === 0) {
        throw missingTargetSource(itemLabel, cliTarget, wholeCoverage, tracked);
      }
      const masterSha = isFragmentItemKind(item.kind)
        ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
        : item.kind === "subagents"
          ? await shaOfCurrentSubagent(project ?? "", dataRepo, item.name)
          : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
      const meta = await loadDataItemMetadata(item);
      printMetadataWarnings(meta);
      const committedNeeds = await captureCommittedItemNeeds(dataRepo, item);
      const lockedNeeds =
        lockEntry?.source === "data" ? (lockEntry.needs ?? null) : null;
      const needsState =
        lockEntry?.source === "data"
          ? deriveNeedsState(lockEntry.needs ?? null, committedNeeds.needs)
          : null;
      const runtimeWarnings = runtimeWarningsForItem(
        project ?? "",
        item.kind,
        item.name,
        {
          itemPath: item.path,
        },
      );
      const locks = [lock, localLock];

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: "data",
              kind: item.kind,
              name: item.name,
              path: item.path,
              masterSha,
              lockedSha: lockEntry ? entryIdentity(lockEntry) : null,
              ...(fragmentSources.length > 0 && {
                sources: fragmentSources.map((source) => ({
                  target: source.sourceTarget ?? source.target,
                  sourcePath: source.relPath,
                  outputPath: project
                    ? relativeProjectPath(
                        project,
                        fragmentOutputPath(project, source.target),
                      )
                    : null,
                })),
              }),
              ...(subagentSources.length > 0 && {
                sources: subagentSources.map((source) => ({
                  target: source.target,
                  sourcePath: source.relPath,
                  outputPath: project
                    ? relativeProjectPath(project, source.outputPath)
                    : null,
                })),
              }),
              ...(coverage && targetCoverageJson(coverage, project)),
              sourceCommit:
                lockEntry?.source === "data" ? lockEntry.sourceCommit : null,
              label:
                lockEntry?.source === "data" ? (lockEntry.label ?? null) : null,
              appliedAt: lockEntry?.appliedAt ?? null,
              metadata: metadataJson(meta, locks),
              lockedNeeds,
              needsState,
              ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`data/${item.kind}/${item.name}`);
      console.log(`  master sha: ${masterSha}`);
      if (lockEntry) {
        const lockedSha = entryIdentity(lockEntry);
        const drift = lockedSha !== masterSha ? " (update available)" : "";
        console.log(`  locked sha: ${shortIdentity(lockedSha)}${drift}`);
        if (lockEntry.source === "data") {
          console.log(`  source commit: ${lockEntry.sourceCommit}`);
          if (lockEntry.label) console.log(`  label:      ${lockEntry.label}`);
        }
        console.log(`  applied:    ${lockEntry.appliedAt}`);
      } else {
        console.log(`  not installed in this project`);
      }
      printMetadataBlock(meta, locks);
      if (
        lockEntry?.source === "data" &&
        (lockEntry.needs === null || needsState === "update_available")
      ) {
        console.log(
          `  locked needs: ${formatNeedsSummary(lockEntry.needs ?? null)}`,
        );
      }
      console.log(`  path:       ${item.path}`);
      if (coverage) {
        printTargetCoverage(coverage, itemLabel, {
          presentWord: "present",
          absentScope: lockEntry?.source === "data" ? "locked" : "item",
          tracked,
        });
      }

      if (runtimeWarnings.length > 0) {
        console.log("");
        printRuntimeWarnings(runtimeWarnings);
      }
      if (opts.content === false) return;

      if (isFragmentItemKind(item.kind)) {
        for (const source of fragmentSources) {
          console.log(`─── ${source.relPath} ─────────────────────`);
          console.log(
            await readFile(
              join(dataRepo, ...source.relPath.split("/")),
              "utf-8",
            ),
          );
        }
        return;
      }
      if (item.kind === "subagents") {
        for (const source of subagentSources) {
          console.log(`─── ${source.relPath} ─────────────────────`);
          console.log(
            await readFile(
              join(dataRepo, ...source.relPath.split("/")),
              "utf-8",
            ),
          );
          console.log(
            `  output: ${project ? relativeProjectPath(project, source.outputPath) : "(project required)"}`,
          );
        }
        return;
      }

      const info = await stat(item.path);
      if (info.isFile()) {
        console.log(`─── ${item.name} ─────────────────────`);
        console.log(await readFile(item.path, "utf-8"));
      } else {
        const files = await sourceVisibleFilesUnderPath(
          dataRepo,
          item.repoRelPath,
        );
        for (const file of files) {
          if (item.kind !== "pi-extensions" && file.includes("/")) continue;
          if (isIgnoredDotEntry(file) || isMetadataSidecarPath(file)) continue;
          console.log(`─── ${file} ─────────────────────`);
          console.log(await readFile(join(item.path, file), "utf-8"));
        }
      }
    });
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}

/**
 * Coverage is read at a commit, never at the worktree. An installed item is
 * described by what the project actually has — its locked `sourceCommit`. For
 * an item nothing has pinned, `HEAD` is what a later `add` would pin.
 */
async function showTargetCoverage(
  project: string | null,
  dataRepo: string,
  item: MasterItem,
  lockEntry: LockEntry | null,
): Promise<TargetCoverageReport | null> {
  if (lockEntry?.source === "data") {
    return await itemTargetCoverageAtCommit(
      project,
      dataRepo,
      item.kind,
      item.name,
      lockEntry.sourceCommit,
    );
  }
  const head = await headSha(dataRepo).catch(() => null);
  if (head === null) {
    return unknownTargetCoverage(
      project,
      item.kind,
      item.name,
      "data repo has no commits",
    );
  }
  return await itemTargetCoverageAtCommit(
    project,
    dataRepo,
    item.kind,
    item.name,
    head,
  );
}

/**
 * `--target <t>` on an item with no `<t>` source keeps refusing with exit 3:
 * turning a documented failure into a success would break scripts. Only the
 * message improves — it names the canonical path a `<t>` source belongs at.
 */
function missingTargetSource(
  itemLabel: string,
  target: FragmentSourceTarget | null,
  coverage: TargetCoverageReport | null,
  tracked: boolean,
): PreconditionError {
  if (target === null) {
    return new PreconditionError(`no matching source for ${itemLabel}`);
  }
  const row = coverage?.rows.find((candidate) => candidate.target === target);
  // `show` dumps the data repo's working tree, but coverage is read at a
  // commit, so the two can disagree — and they say opposite things to the
  // user. Telling someone to author and commit a file that is already
  // committed, and merely absent from their working tree, sends them to the
  // wrong repair.
  //
  // It states the fact and stops, for the reason this design withdrew every
  // other computed repair: a printed command has to succeed in the exact state
  // it is printed in, and this one cannot. `git checkout -- <path>` fixes an
  // uncommitted deletion and fails on a staged one or on a target a later
  // upstream commit removed — and `present` here only says the commit this
  // project reads has the file, never which of those happened.
  if (row?.present === true) {
    return new PreconditionError(
      [
        `${itemLabel} has no ${target} source in the data repo's working tree`,
        `  ${row.sourcePath} is present at the commit this project reads.`,
        ...(tracked
          ? [
              `  Restore it in the data repo, or commit the deletion, then: capshelf update ${itemLabel}`,
            ]
          : ["  Restore it in the data repo, or commit the deletion."]),
      ].join("\n"),
    );
  }
  return new PreconditionError(
    [
      `${itemLabel} has no ${target} source`,
      // Not `formatCoverageGap`: that one is gap-gated, and this refusal must
      // still name where the source belongs when coverage is `unknown` — a
      // state where there is no known gap to report but the path is still true.
      ...(row
        ? [
            `  ${RUNTIME_TARGET_LABELS[target]} reads ${row.sourcePath} in your data repo.`,
            ...(tracked
              ? [`  Once it is committed there: capshelf update ${itemLabel}`]
              : []),
          ]
        : []),
    ].join("\n"),
  );
}

/**
 * Preview a bundle: the literal member list with per-member availability and
 * install state ("installed" reads both locks, same definition as items).
 * Bundles have no content to dump and no fragment target to pick, so
 * `--target` and `--no-content` are rejected (exit 3). Malformed bundles
 * degrade: the warning and path stay visible (read path).
 */
async function showBundle(
  name: string,
  opts: ShowOptions,
  cmd: Command,
): Promise<void> {
  if (opts.target !== undefined) {
    throw new PreconditionError(
      `--target is not valid for bundles/${name} — bundles have no fragment target`,
    );
  }
  if (opts.content === false) {
    throw new PreconditionError(
      `--no-content is not valid for bundles/${name} — bundles have no content to dump`,
    );
  }

  const project = findProjectRoot();
  const manifest = project ? await loadManifest(project) : null;
  const lock = project ? await loadLock(project) : emptyLock();
  const localLock = project ? await loadLocalLock(project) : emptyLock();
  const dataRepo = await resolveDataRepo({
    override: globalOpts(cmd).data,
    manifest,
    project: project ?? undefined,
  });
  await assertIsGitRepo(dataRepo);

  const bundle = await loadBundle(dataRepo, name);
  if (!bundle) {
    throw new NotFoundError(
      `bundle not found in data repo (${dataRepo}): bundles/${name}`,
    );
  }
  for (const warning of new Set(bundle.warnings)) {
    console.error(`⚠ ${warning}`);
  }

  const masterItems = await listMasterItems(dataRepo);
  const available = new Set(masterItems.map((i) => `${i.kind}/${i.name}`));
  const masterByRef = new Map(
    masterItems.map((item) => [`${item.kind}/${item.name}`, item]),
  );
  const bundleNeeds = emptyNeeds();
  for (const member of bundle.members) {
    const item = masterByRef.get(memberRef(member));
    if (!item) continue;
    const metadata = await loadDataItemMetadata(item);
    mergeNeedsInto(bundleNeeds, metadata.needs);
  }
  const rows = bundle.members.map((member) => {
    const ref = memberRef(member);
    const key = dataKey(member.kind, member.name);
    const projectEntry = lock.items[key];
    const entry = projectEntry ?? localLock.items[key];
    return {
      ref,
      available: available.has(ref),
      installed: entry !== undefined,
      ...(entry && {
        scope: projectEntry ? ("project" as const) : ("local" as const),
        lockedSha: entryIdentity(entry),
      }),
    };
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          bundle: bundle.name,
          path: bundle.path,
          ...(bundle.description !== undefined && {
            description: bundle.description,
          }),
          tags: bundle.tags,
          needs: bundleNeeds,
          members: rows,
          ...(bundle.malformed !== undefined && {
            malformed: bundle.malformed,
          }),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`bundles/${bundle.name}  (${homeRelative(bundle.path)})`);
  if (bundle.description !== undefined) {
    console.log(`  description: ${bundle.description}`);
  }
  if (bundle.tags.length > 0) {
    console.log(`  tags:        ${bundle.tags.join(", ")}`);
  }
  printNeedsBlock(bundleNeeds);
  if (bundle.malformed !== undefined) {
    console.log(`  (bundle file is malformed — members unknown)`);
    return;
  }
  console.log("  members:");
  if (rows.length === 0) {
    console.log("    (none)");
  }
  for (const row of rows) {
    const state = !row.available
      ? "MISSING from data repo"
      : row.installed
        ? `installed (${row.scope}) @ ${shortIdentity(row.lockedSha)}`
        : "not installed";
    console.log(`    ${row.ref.padEnd(31)} ${state}`);
  }
  console.log(`  install:     capshelf add bundles/${bundle.name}`);
}

async function showSystem(
  name: string,
  lock: Lock,
  localLock: Lock,
  opts: ShowOptions,
): Promise<void> {
  const item = findSystemItem(name);
  if (!item) {
    throw new NotFoundError(`system item not found: ${name}`);
  }
  const bundledSha = await shaOfSystemItem(item);
  const lockEntry = lock.items[systemKey(item.kind, item.name)] ?? null;
  const meta = loadSystemItemMetadata(item);
  printMetadataWarnings(meta);
  const locks = [lock, localLock];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          source: "system",
          kind: item.kind,
          name: item.name,
          bundledSha,
          lockedSha: lockEntry ? entryIdentity(lockEntry) : null,
          cliVersion:
            lockEntry?.source === "system" ? lockEntry.cliVersion : null,
          appliedAt: lockEntry?.appliedAt ?? null,
          metadata: metadataJson(meta, locks),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`system/${item.kind}/${item.name}`);
  console.log(`  bundled sha: ${bundledSha}`);
  if (lockEntry) {
    const drift =
      entryIdentity(lockEntry) !== bundledSha
        ? " (cli upgraded — run apply)"
        : "";
    console.log(
      `  locked sha:  ${shortIdentity(entryIdentity(lockEntry))}${drift}`,
    );
    if (lockEntry.source === "system") {
      console.log(`  cli version: ${lockEntry.cliVersion}`);
    }
    console.log(`  applied:     ${lockEntry.appliedAt}`);
  } else {
    console.log(`  not installed in this project`);
  }
  printMetadataBlock(meta, locks);

  if (opts.content === false) return;
  for (const f of item.files) {
    console.log(`─── ${f.relPath} ─────────────────────`);
    console.log(f.content);
  }
}

interface RelationState {
  ref: string;
  installed: boolean;
}

/**
 * "Installed" means present in either capshelf.lock.json or local.lock.json,
 * under either the data or system source prefix.
 */
function relationStates(refs: string[], locks: Lock[]): RelationState[] {
  return refs.map((ref) => ({
    ref,
    installed: locks.some(
      (lock) =>
        lock.items[`data/${ref}`] !== undefined ||
        lock.items[`system/${ref}`] !== undefined,
    ),
  }));
}

/** The always-present `metadata` JSON object appended to show --json. */
function metadataJson(
  meta: ItemMetadata,
  locks: Lock[],
): {
  description?: string;
  tags: string[];
  requires: RelationState[];
  conflictsWith: RelationState[];
  needs: ItemNeeds;
} {
  return {
    ...(meta.description !== undefined && { description: meta.description }),
    tags: meta.tags,
    requires: relationStates(meta.requires, locks),
    conflictsWith: relationStates(meta.conflictsWith, locks),
    needs: meta.needs,
  };
}

function printMetadataBlock(meta: ItemMetadata, locks: Lock[]): void {
  if (meta.description !== undefined) {
    console.log(`  description: ${meta.description}`);
  }
  if (meta.tags.length > 0) {
    console.log(`  tags:        ${meta.tags.join(", ")}`);
  }
  for (const [label, refs] of [
    ["requires:   ", meta.requires],
    ["conflicts:  ", meta.conflictsWith],
  ] as const) {
    if (refs.length === 0) continue;
    const states = relationStates(refs, locks)
      .map(
        (rel) =>
          `${rel.ref} (${rel.installed ? "installed" : "not installed"})`,
      )
      .join(", ");
    console.log(`  ${label} ${states}`);
  }
  printNeedsBlock(meta.needs);
}

function printNeedsBlock(needs: ItemNeeds): void {
  if (needs.network.length > 0) {
    console.log(`  needs network: ${needs.network.join(", ")}`);
  }
  const info = formatDeclaredNeeds(needs);
  if (info) console.log(`  ${info}`);
}

function formatNeedsSummary(needs: ItemNeeds | null): string {
  if (needs === null) return "(unknown; run capshelf update)";
  const parts = [
    ...(needs.network.length > 0
      ? [`network: ${needs.network.join(", ")}`]
      : []),
    ...(needs.env.length > 0 ? [`env: ${needs.env.join(", ")}`] : []),
    ...(needs.bin.length > 0 ? [`bin: ${needs.bin.join(", ")}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "(none)";
}

function mergeNeedsInto(target: ItemNeeds, source: ItemNeeds): void {
  for (const field of ["network", "env", "bin"] as const) {
    target[field] = [...new Set([...target[field], ...source[field]])].sort();
  }
}
