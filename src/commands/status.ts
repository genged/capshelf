import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { existsSync } from "node:fs";
import { projectRoot, resolveDataRepoOptional } from "../paths";
import { loadLocalLock, loadLock } from "../lock";
import type { Lock, LockEntry } from "../lock";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import type { ItemKind } from "../master";
import { isFragmentItemKind, shaOfGitVisibleItem, shaOfItem } from "../master";
import { installedPath, shaOfInstalled, parseLockKey } from "../installed";
import { ResultExitError } from "../errors";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../cli";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { isPathClean } from "../git";
import { listClaudePlugins, listSkillsShSkills } from "../external";
import { buildStatusDiff, currentCopyItemSha } from "../status-diff";
import type { StatusDiff } from "../status-diff";
import {
  codexProjectTrustWarnings,
  isStrictRuntimeWarning,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  allCanonicalFragmentRelPaths,
  fragmentContributionState,
  lockedFragmentTargetsForItem,
  shaOfFragmentItem,
  type FragmentContributionState,
} from "../fragments";
import {
  assertNoScopeCollisions,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type StatusRow,
} from "../status-core";
import { formatStatusHuman } from "../status-format";

interface StatusOptions {
  json?: boolean;
  strict?: boolean;
  diff?: boolean;
  project?: boolean;
  local?: boolean;
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
    .action(
      async (
        itemRef: string | undefined,
        opts: StatusOptions,
        cmd: CmdType,
      ) => {
        const project = projectRoot();
        const manifest = await loadManifest(project);
        if (opts.project && opts.local) {
          throw new Error("--project and --local cannot be used together");
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
        const dataRepo =
          resolvedDataRepo && existsSync(resolvedDataRepo)
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
        const externalSkillNames = new Set(external.map((skill) => skill.name));

        const rows: StatusRow[] = [];
        const fragmentStates = new Map<string, FragmentContributionState>();
        for (const target of targets) {
          const { scope, key } = target;
          const lock = scope === "local" ? localLock : projectLock;
          const { source, kind, name: itemName } = parseLockKey(key);
          if (kind === "skills" && externalSkillNames.has(itemName)) continue;

          const entry = lock.items[key]!;
          let currentSha = isFragmentItemKind(kind)
            ? await currentInstalledSha(project, kind, itemName, scope)
            : await currentCopyItemSha({
                project,
                dataRepo,
                manifest,
                source,
                kind,
                name: itemName,
                sourceCommit:
                  entry.source === "data" ? entry.sourceCommit : undefined,
              });
          let fragmentOutputState: FragmentContributionState | null = null;
          if (source === "data" && isFragmentItemKind(kind)) {
            if (dataRepo) {
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
                  ? entry.sha
                  : fragmentOutputState === "missing"
                    ? null
                    : "fragment-output-drift";
            } else {
              currentSha = entry.sha;
            }
          }

          let upstreamSha: string | null = null;
          let upstreamDirty = false;
          if (source === "data") {
            if (dataRepo) {
              const masterItem = await findMasterItemByRef(dataRepo, {
                kind,
                name: itemName,
              });
              if (masterItem) {
                upstreamDirty = isFragmentItemKind(kind)
                  ? await fragmentSourceDirty(dataRepo, kind, itemName)
                  : !(await isPathClean(dataRepo, masterItem.repoRelPath));
                upstreamSha = upstreamDirty
                  ? null
                  : isFragmentItemKind(kind)
                    ? await shaOfFragmentItem(dataRepo, kind, itemName)
                    : await shaOfGitVisibleItem(
                        dataRepo,
                        masterItem.repoRelPath,
                      );
              }
            }
          } else {
            const sys = findSystemItem(itemName);
            upstreamSha =
              sys && sys.kind === kind ? await shaOfSystemItem(sys) : null;
          }

          const state = deriveState({
            kind,
            source: entry.source,
            local: entry.source === "data" && entry.local === true,
            lockedSha: entry.sha,
            currentSha,
            upstreamSha,
            upstreamDirty,
            fragmentOutputState,
          });

          rows.push(
            buildStatusRow({
              scope,
              source,
              kind,
              name: itemName,
              entry,
              state,
              currentSha,
              upstreamSha,
              upstreamDirty,
              runtimeWarnings: [
                ...runtimeWarningsForItem(project, kind, itemName),
                ...codexWarningsForItem(project, kind),
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

async function currentInstalledSha(
  project: string,
  kind: ItemKind,
  name: string,
  scope: "project" | "local",
): Promise<string | null> {
  if (scope === "local" && kind === "skills") {
    const path = installedPath(project, kind, name);
    return existsSync(path) ? await shaOfItem(path) : null;
  }
  return await shaOfInstalled(project, kind, name);
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
): RuntimeWarning[] {
  if (kind !== "mcp" && kind !== "codex-config") return [];
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

async function fragmentSourceDirty(
  dataRepo: string,
  kind: Extract<ItemKind, "settings" | "mcp" | "codex-config">,
  name: string,
): Promise<boolean> {
  for (const relPath of allCanonicalFragmentRelPaths(kind, name)) {
    if (!(await isPathClean(dataRepo, relPath))) return true;
  }
  return false;
}
