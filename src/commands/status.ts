import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { existsSync } from "node:fs";
import { findProjectRoot, projectRoot } from "../paths";
import { resolveDataRepoOptional } from "../data-repo";
import { loadLocalLock, loadLock } from "../lock";
import type { Lock, LockEntry } from "../lock";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import type { ItemKind } from "../master";
import { isFragmentItemKind } from "../master";
import { shaOfInstalled, parseLockKey } from "../installed";
import { PreconditionError, ResultExitError } from "../errors";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../global-options";
import { parseItemRef } from "../item-ref";
import { commitExists, isGitRepo } from "../git";
import { upstreamFactsForItem } from "../upstream-facts";
import {
  listClaudePlugins,
  listSkillsShSkills,
  listUserSkills,
  withUserSkillShadows,
} from "../external";
import type { ExternalUserSkill } from "../external";
import { buildStatusDiff, currentCopyItemSha } from "../status-diff";
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
  assertNoScopeCollisions,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type StatusRow,
} from "../status-core";
import { formatStatusHuman, formatUserSkillsHuman } from "../status-format";

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
          (await isGitRepo(resolvedDataRepo))
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
          let currentSha = isFragmentItemKind(kind)
            ? await shaOfInstalled(project, kind, itemName)
            : await currentCopyItemSha({
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
          let fragmentOutputState: FragmentContributionState | null = null;
          if (source === "data" && isFragmentItemKind(kind)) {
            if (sourceCommitPresent === false) {
              currentSha = entry.sha;
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
              const upstream = await upstreamFactsForItem(
                dataRepo,
                kind,
                itemName,
              );
              upstreamSha = upstream.upstreamSha;
              upstreamDirty = upstream.upstreamDirty;
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
            sourceCommitPresent,
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
