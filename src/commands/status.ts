import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { findProjectRoot, projectRoot } from "../paths";
import { resolveDataRepoOptional } from "../data-repo";
import { entryIdentity, loadLocalLock, loadLock } from "../lock";
import type { Lock, LockEntry } from "../lock";
import { describeInstallation, isTreePinned } from "../install-identity";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import type { ItemKind } from "../master";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "../master";
import { itemOutputTargets, parseLockKey, shaOfInstalled } from "../installed";
import { PreconditionError, ResultExitError } from "../errors";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../global-options";
import { parseItemRef } from "../item-ref";
import { commitExists, isGitWorkTreeRoot } from "../git";
import { upstreamFactsForItem } from "../upstream-facts";
import {
  listClaudePlugins,
  listSkillsShSkills,
  listUserSkills,
  withUserSkillShadows,
} from "../external";
import type { ExternalUserSkill } from "../external";
import {
  buildStatusDiff,
  copyDirectoryModeDrifted,
  currentCopyDirectoryItemSha,
} from "../status-diff";
import type { StatusDiff } from "../status-diff";
import {
  codexProjectTrustWarnings,
  isStrictRuntimeWarning,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  fragmentContributionState,
  lockedFragmentTargetsForItem,
  type FragmentContributionState,
} from "../fragments";
import {
  deriveNeedsState,
  assertNoScopeCollisions,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type StatusAxes,
  type StatusRow,
} from "../status-core";
import {
  filteredPathsAtCommit,
  itemTreeEntriesAtCommit,
  type FilteredPath,
} from "../pin";
import { formatStatusHuman, formatUserSkillsHuman } from "../status-format";
import { captureCommittedItemNeeds } from "../metadata";
import type { ItemNeeds } from "../metadata";
import {
  shaOfInstalledSubagent,
  subagentTargetStatusAtCommit,
} from "../subagents";

interface StatusOptions {
  json?: boolean;
  strict?: boolean;
  diff?: boolean;
  project?: boolean;
  local?: boolean;
  user?: boolean;
}

export function registerStatus(program: Command): void {
  program
    .command("status [item]")
    .description("drift / update report for the current project")
    .option("--json", "output JSON")
    .option(
      "--strict",
      "exit 4 if any item is neither up-to-date nor kept-local",
    )
    .option("--diff", "show local drift diff against the locked content")
    .option("--project", "show committed project-scope items only")
    .option("--local", "show clone-local items only")
    .option("--user", "show user-level runtime skills only")
    .action(
      async (
        itemRef: string | undefined,
        opts: StatusOptions,
        cmd: CmdType,
      ) => {
        if (opts.user) {
          await statusUser(itemRef, opts);
          return;
        }

        const project = projectRoot();
        const manifest = await loadManifest(project);
        if (opts.project && opts.local) {
          throw new PreconditionError(
            "--project and --local cannot be used together",
          );
        }
        const projectLock = await loadLock(project);
        const localLock = await loadLocalLock(project);
        assertNoScopeCollisions(projectLock, localLock);
        // Status still produces a report when the data repo isn't configured
        // or has gone missing on disk: data items report missing_upstream
        // instead of crashing. Treating a configured-but-absent path as null
        // here degrades both fragment and copy items uniformly, and lets the
        // per-item master/git calls below surface genuine errors (ambiguous
        // refs, permission failures) instead of swallowing them.
        const resolvedDataRepo = await resolveDataRepoOptional({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });
        // A bound path that is not a git repo degrades like a missing one
        // (rows report missing_upstream) instead of crashing on raw git
        // errors during per-item upstream checks.
        const dataRepo =
          resolvedDataRepo &&
          existsSync(resolvedDataRepo) &&
          (await isGitWorkTreeRoot(resolvedDataRepo))
            ? resolvedDataRepo
            : null;

        const ref = itemRef ? parseItemRef(itemRef) : undefined;
        const targets = statusTargets(projectLock, localLock, ref, opts);
        const external = (await listSkillsShSkills(project)).filter(
          (skill) =>
            !ref ||
            (skill.name === ref.name &&
              (ref.kind === undefined || ref.kind === "skills")),
        );
        const externalClaudePlugins = (await listClaudePlugins(project)).filter(
          (plugin) =>
            !ref ||
            (ref.kind === undefined &&
              (plugin.id === ref.name || plugin.name === ref.name)),
        );
        const externalUserSkills =
          opts.project || opts.local
            ? []
            : filterUserSkillsForRef(
                withUserSkillShadows(
                  await listUserSkills(),
                  projectLock,
                  localLock,
                ),
                ref,
              );
        const externalSkillNames = new Set(external.map((skill) => skill.name));

        const rows: StatusRow[] = [];
        const fragmentStates = new Map<string, FragmentContributionState>();
        for (const target of targets) {
          const { scope, key } = target;
          const lock = scope === "local" ? localLock : projectLock;
          const { source, kind, name: itemName } = parseLockKey(key);
          if (kind === "skills" && externalSkillNames.has(itemName)) continue;

          const entry = lock.items[key]!;
          // Reachability must be gathered before computing currentSha: the
          // sourceCommit-dependent computations below (`git show` /
          // `ls-tree` at the pinned commit) would error out on an
          // unreachable pin. When the commit is missing they are skipped and
          // the row degrades to missing_source_commit instead of crashing.
          const sourceCommitPresent: boolean | null =
            entry.source === "data" && dataRepo
              ? await commitExists(dataRepo, entry.sourceCommit)
              : null;
          // Under lock version 4 the installed state is named the way Git
          // names it — a blob id per pinned path plus its mode — so the same
          // `sourcePinDigest` formula covers the pin, the install, and the
          // upstream. Mode is inside the digest, which is why `modeDrifted`
          // stays false on that path: an executable-bit flip is already a
          // different identity rather than a separate flag.
          const treeIdentity = entry.source === "data" && isTreePinned(entry);
          const installation =
            treeIdentity && entry.source === "data" && dataRepo
              ? await describeInstallation(
                  project,
                  dataRepo,
                  kind,
                  itemName,
                  entry.sourceCommit,
                )
              : null;
          let currentSha: string | null;
          let modeDrifted = false;
          if (treeIdentity && entry.source === "data" && dataRepo) {
            currentSha =
              sourceCommitPresent === false
                ? null
                : (installation?.currentSha ?? null);
          } else if (isFragmentItemKind(kind)) {
            currentSha = await shaOfInstalled(project, kind, itemName);
          } else if (isCopyDirectoryItemKind(kind)) {
            currentSha = await currentCopyDirectoryItemSha({
              project,
              dataRepo,
              manifest,
              source,
              kind,
              name: itemName,
              sourceCommit:
                entry.source === "data" && sourceCommitPresent !== false
                  ? entry.sourceCommit
                  : undefined,
            });
            if (currentSha !== null) {
              modeDrifted = await copyDirectoryModeDrifted({
                project,
                dataRepo,
                manifest,
                source,
                kind,
                name: itemName,
                sourceCommit:
                  entry.source === "data" && sourceCommitPresent !== false
                    ? entry.sourceCommit
                    : undefined,
              });
            }
          } else if (isCopyTargetFileItemKind(kind)) {
            currentSha =
              entry.source === "data" &&
              dataRepo &&
              sourceCommitPresent !== false
                ? await shaOfInstalledSubagent(
                    project,
                    dataRepo,
                    itemName,
                    entry.sourceCommit,
                  )
                : entryIdentity(entry);
          } else {
            throw new Error(`no status strategy for ${kind}/${itemName}`);
          }
          let fragmentOutputState: FragmentContributionState | null = null;
          if (source === "data" && isFragmentItemKind(kind)) {
            if (sourceCommitPresent === false) {
              currentSha = entryIdentity(entry);
            } else if (dataRepo) {
              const stateKey = `${scope}/${key}`;
              if (!fragmentStates.has(stateKey)) {
                fragmentStates.set(
                  stateKey,
                  await itemFragmentContributionState(
                    project,
                    dataRepo,
                    manifest,
                    lock,
                    kind,
                    itemName,
                    entry,
                  ),
                );
              }
              fragmentOutputState = fragmentStates.get(stateKey)!;
              currentSha =
                fragmentOutputState === "ok"
                  ? entryIdentity(entry)
                  : fragmentOutputState === "missing"
                    ? null
                    : "fragment-output-drift";
            } else {
              currentSha = entryIdentity(entry);
            }
          }

          let upstreamSha: string | null = null;
          let upstreamChanged = false;
          let upstreamDirty = false;
          let currentNeeds: ItemNeeds | undefined;
          if (source === "data") {
            if (dataRepo) {
              const upstream = await upstreamFactsForItem(
                dataRepo,
                kind,
                itemName,
                treeIdentity ? "tree" : "worktree",
              );
              upstreamSha = upstream.upstreamSha;
              upstreamDirty = upstream.upstreamDirty;
              upstreamChanged =
                upstreamSha !== entryIdentity(entry) ||
                (entry.source === "data" &&
                  upstream.sourceCommit !== null &&
                  upstream.sourceCommit !== entry.sourceCommit);
              if (upstreamSha !== null || upstreamDirty) {
                try {
                  currentNeeds = (
                    await captureCommittedItemNeeds(dataRepo, {
                      kind,
                      name: itemName,
                    })
                  ).needs;
                } catch {
                  currentNeeds = undefined;
                }
              }
            }
          } else {
            const sys = findSystemItem(itemName);
            upstreamSha =
              sys && sys.kind === kind ? await shaOfSystemItem(sys) : null;
            upstreamChanged = upstreamSha !== entryIdentity(entry);
          }

          // PIN-9 on the reporting path: one `check-attr` per item, against
          // the commit the pin names, so the verdict is identical in every
          // clone whether or not that clone holds the driver's key.
          const filteredPaths =
            treeIdentity &&
            entry.source === "data" &&
            dataRepo &&
            sourceCommitPresent !== false
              ? await filteredPathsForEntry(
                  dataRepo,
                  kind,
                  itemName,
                  entry.sourceCommit,
                )
              : [];
          const axes: StatusAxes | undefined =
            entry.source === "data" && treeIdentity
              ? {
                  pin:
                    sourceCommitPresent === false || installation === null
                      ? "unresolvable"
                      : installation.pinnedSha === entryIdentity(entry)
                        ? "valid"
                        : "mismatch",
                  sourceState:
                    filteredPaths.length > 0
                      ? "filtered"
                      : upstreamDirty
                        ? "dirty"
                        : "exact",
                  ...(installation !== null && {
                    installation: installation.axis,
                    installDifferences: installation.differences.filter(
                      (difference) => difference.kind !== "untouched",
                    ),
                  }),
                  ...(filteredPaths.length > 0 && { filteredPaths }),
                }
              : undefined;
          const state = deriveState({
            kind,
            source: entry.source,
            local: entry.source === "data" && entry.local === true,
            lockedSha: entryIdentity(entry),
            currentSha,
            modeDrifted,
            upstreamSha,
            upstreamDirty,
            upstreamChanged,
            fragmentOutputState,
            sourceCommitPresent,
            sourceFiltered: filteredPaths.length > 0,
          });
          const subagentTargets =
            kind === "subagents" &&
            entry.source === "data" &&
            dataRepo &&
            sourceCommitPresent !== false
              ? (
                  await subagentTargetStatusAtCommit(
                    project,
                    dataRepo,
                    itemName,
                    entry.sourceCommit,
                  )
                ).map((detail) => ({
                  ...detail,
                  outputPath: relative(project, detail.outputPath),
                }))
              : undefined;

          rows.push(
            buildStatusRow({
              scope,
              source,
              kind,
              name: itemName,
              entry,
              state,
              currentSha,
              modeDrifted,
              upstreamSha,
              upstreamDirty,
              needsState:
                entry.source === "data"
                  ? deriveNeedsState(entry.needs ?? null, currentNeeds)
                  : undefined,
              targets: subagentTargets,
              ...(axes !== undefined && { axes }),
              runtimeWarnings: [
                ...runtimeWarningsForItem(project, kind, itemName),
                ...codexWarningsForItem(project, kind, itemName),
              ],
            }),
          );
        }

        const diffs: StatusDiff[] = [];
        const personalClaudeExternal = personalClaudeExternals(rows);
        if (opts.diff) {
          const seenPaths = new Set<string>();
          for (const row of rows) {
            const rowLock = row.scope === "local" ? localLock : projectLock;
            const diff = await buildStatusDiff({
              project,
              dataRepo,
              manifest,
              lock: rowLock,
              row,
            });
            if (!diff || seenPaths.has(diff.path)) continue;
            seenPaths.add(diff.path);
            diffs.push(diff);
          }
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                project,
                dataRepo,
                cliVersion: CLI_VERSION,
                count: rows.length,
                items: rows,
                ...(opts.diff && { diffs }),
                external,
                externalClaudePlugins,
                externalUserSkills,
                personalClaudeExternal,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(
            formatStatusHuman({
              project,
              dataRepo,
              rows,
              external,
              externalClaudePlugins,
              externalUserSkills,
              personalClaudeExternal,
            }).join("\n"),
          );
          if (opts.diff) printDiffs(diffs);
        }

        if (
          opts.strict &&
          rows.some(
            (r) =>
              (r.state !== "ok" && r.state !== "kept-local") ||
              (r.runtimeWarnings?.some(isStrictRuntimeWarning) ?? false),
          )
        ) {
          throw new ResultExitError(4);
        }
      },
    );
}

/**
 * PIN-9 for one item at one commit. `status` calls this per row rather than
 * grouping by commit: a project's items rarely share a source commit, so the
 * grouping the spec's cost table describes would save nothing here — the
 * saving is in a multi-item `update`, which pins them all at once.
 */
async function filteredPathsForEntry(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<FilteredPath[]> {
  try {
    const entries = await itemTreeEntriesAtCommit(dataRepo, kind, name, commit);
    return await filteredPathsAtCommit(dataRepo, commit, [
      { kind, name, entries },
    ]);
  } catch {
    return [];
  }
}

async function statusUser(
  itemRef: string | undefined,
  opts: StatusOptions,
): Promise<void> {
  if (opts.project || opts.local) {
    throw new PreconditionError(
      "--user cannot be combined with --project or --local",
    );
  }
  if (opts.diff) {
    throw new PreconditionError("--diff is not supported with --user");
  }

  const ref = itemRef ? parseItemRef(itemRef) : undefined;
  const project = currentProjectRootOrNull();
  const skills = await userSkillsWithProjectShadows(project);
  const filtered = filterUserSkillsForRef(skills, ref);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project,
          dataRepo: null,
          cliVersion: CLI_VERSION,
          count: filtered.length,
          items: [],
          externalUserSkills: filtered,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatUserSkillsHuman(filtered).join("\n"));
}

async function userSkillsWithProjectShadows(
  project: string | null,
): Promise<ExternalUserSkill[]> {
  const skills = await listUserSkills();
  if (!project) return skills;
  const projectLock = await loadLock(project);
  const localLock = await loadLocalLock(project);
  return withUserSkillShadows(skills, projectLock, localLock);
}

function currentProjectRootOrNull(): string | null {
  return findProjectRoot();
}

function filterUserSkillsForRef(
  skills: ExternalUserSkill[],
  ref: ReturnType<typeof parseItemRef> | undefined,
): ExternalUserSkill[] {
  if (!ref) return skills;
  if (ref.kind !== undefined && ref.kind !== "skills") return [];
  return skills.filter((skill) => skill.name === ref.name);
}

function printDiffs(diffs: StatusDiff[]): void {
  console.log("");
  if (diffs.length === 0) {
    console.log("(no local drift diff)");
    return;
  }

  for (const [index, diff] of diffs.entries()) {
    if (index > 0) console.log("");
    console.log(`diff ${diff.item}`);
    process.stdout.write(diff.text);
  }
}

function codexWarningsForItem(
  project: string,
  kind: ItemKind,
  name: string,
): RuntimeWarning[] {
  if (kind === "subagents") {
    const hasCodexTarget = itemOutputTargets(project, kind, name).some(
      ({ id, outputPath }) => id === "codex" && existsSync(outputPath),
    );
    return hasCodexTarget ? codexProjectTrustWarnings(project) : [];
  }
  if (kind !== "mcp" && kind !== "codex-config") {
    return [];
  }
  return codexProjectTrustWarnings(project);
}

async function itemFragmentContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  kind: Extract<ItemKind, "settings" | "mcp" | "codex-config">,
  name: string,
  entry: LockEntry,
): Promise<FragmentContributionState> {
  if (entry.source !== "data") return "ok";
  const targets = await lockedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
  );
  let state: FragmentContributionState = "ok";
  for (const target of targets) {
    const targetState = await fragmentContributionState(
      project,
      dataRepo,
      manifest,
      lock,
      target,
    );
    if (targetState === "missing") return "missing";
    if (targetState === "drifted") state = "drifted";
  }
  return state;
}
