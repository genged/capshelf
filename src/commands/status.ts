import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { existsSync } from "node:fs";
import { projectRoot, resolveDataRepoOptional, homeRelative } from "../paths";
import { loadLocalLock, loadLock } from "../lock";
import type { Lock, LockEntry } from "../lock";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import type { ItemKind } from "../master";
import { isFragmentItemKind, shaOfGitVisibleItem, shaOfItem } from "../master";
import { installedPath, shaOfInstalled, parseLockKey } from "../installed";
import type { ItemSource } from "../installed";
import { ResultExitError } from "../errors";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../cli";
import { findMasterItemByRef, lockKeysForRef, parseItemRef } from "../item-ref";
import { isPathClean } from "../git";
import { listClaudePlugins, listSkillsShSkills } from "../external";
import type { ExternalClaudePlugin, ExternalSkill } from "../external";
import { buildStatusDiff } from "../status-diff";
import type { StatusDiff } from "../status-diff";
import {
  codexProjectTrustWarnings,
  isStrictRuntimeWarning,
  printRuntimeWarnings,
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

type State =
  | "ok"
  | "update_available"
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "missing_output"
  | "missing_upstream"
  | "upstream_dirty"
  | "source_dirty"
  | "drifted_and_upstream_dirty"
  | "output_drift"
  | "source_dirty_and_output_drift"
  | "kept-local";

interface StatusRow {
  scope: "project" | "local";
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: State;
  lockedSha: string;
  currentSha: string | null;
  /** master sha (data) or bundled sha (system); null if upstream is gone */
  upstreamSha: string | null;
  /** true when the data-repo item path has uncommitted changes */
  upstreamDirty?: boolean;
  /** for data items, the recorded source commit */
  sourceCommit?: string;
  local?: true;
  localReason?: string;
  /** for system items, the cliVersion that wrote the entry */
  cliVersion?: string;
  label?: string;
  runtimeWarnings?: RuntimeWarning[];
}

interface ExternalPersonalClaudeSkill {
  kind: "skills";
  name: string;
  path: string;
  warning: RuntimeWarning;
}

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
        // Optional: status should still produce a report when the data repo
        // isn't configured or has gone missing. Data items just report
        // missing_upstream in that case.
        const dataRepo = await resolveDataRepoOptional({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });

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
          let currentSha = await currentInstalledSha(
            project,
            kind,
            itemName,
            scope,
          );
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
              }).catch(() => null);
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

          let state: State;
          if (
            entry.source === "data" &&
            entry.local === true &&
            currentSha !== null
          ) {
            state = "kept-local";
          } else if (isFragmentItemKind(kind) && upstreamDirty) {
            state =
              fragmentOutputState === "drifted" ||
              fragmentOutputState === "missing"
                ? "source_dirty_and_output_drift"
                : "source_dirty";
          } else if (
            isFragmentItemKind(kind) &&
            fragmentOutputState === "missing"
          ) {
            state = "missing_output";
          } else if (
            isFragmentItemKind(kind) &&
            fragmentOutputState === "drifted"
          ) {
            state =
              upstreamSha !== null && upstreamSha !== entry.sha
                ? "drifted_and_update"
                : "output_drift";
          } else if (currentSha === null) state = "missing_installed";
          else if (upstreamDirty) {
            state =
              currentSha !== entry.sha
                ? "drifted_and_upstream_dirty"
                : "upstream_dirty";
          } else if (upstreamSha === null) state = "missing_upstream";
          else {
            const drifted = currentSha !== entry.sha;
            const update = upstreamSha !== entry.sha;
            if (drifted && update) state = "drifted_and_update";
            else if (drifted) state = "drifted_local";
            else if (update) state = "update_available";
            else state = "ok";
          }

          rows.push({
            scope,
            source,
            kind,
            name: itemName,
            state,
            lockedSha: entry.sha,
            currentSha,
            upstreamSha,
            ...(upstreamDirty && { upstreamDirty }),
            ...(entry.source === "data" && {
              sourceCommit: entry.sourceCommit,
              ...(entry.local === true && { local: true as const }),
              ...(entry.localReason !== undefined && {
                localReason: entry.localReason,
              }),
              ...(entry.label !== undefined && { label: entry.label }),
            }),
            ...(entry.source === "system" && {
              cliVersion: entry.cliVersion,
            }),
            ...runtimeWarningFields([
              ...runtimeWarningsForItem(project, kind, itemName),
              ...codexWarningsForItem(project, kind),
            ]),
          });
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
          printHuman(
            project,
            dataRepo,
            rows,
            external,
            externalClaudePlugins,
            personalClaudeExternal,
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

function glyph(s: State): string {
  switch (s) {
    case "ok":
      return "✓";
    case "update_available":
      return "⚠";
    case "drifted_local":
      return "✎";
    case "drifted_and_update":
      return "✎⚠";
    case "missing_installed":
      return "?";
    case "missing_output":
      return "?";
    case "missing_upstream":
      return "!";
    case "upstream_dirty":
      return "!";
    case "source_dirty":
      return "!";
    case "drifted_and_upstream_dirty":
      return "✎!";
    case "output_drift":
      return "✎";
    case "source_dirty_and_output_drift":
      return "✎!";
    case "kept-local":
      return "≠";
  }
}

function describe(r: StatusRow): string {
  switch (r.state) {
    case "ok":
      return "up-to-date";
    case "update_available":
      return r.source === "system"
        ? `update available → ${r.upstreamSha} (cli upgraded)`
        : `update available → ${r.upstreamSha}`;
    case "drifted_local":
      return `drifted (current ${r.currentSha})`;
    case "drifted_and_update":
      return `drifted + update available → ${r.upstreamSha}`;
    case "missing_installed":
      return "installed files missing — run: capshelf apply";
    case "missing_output":
      return "generated output missing — run: capshelf apply";
    case "missing_upstream":
      return r.source === "data"
        ? "no longer in data repo"
        : "no longer bundled in CLI";
    case "upstream_dirty":
      return "data repo has uncommitted changes for this item";
    case "source_dirty":
      return "data repo has uncommitted changes for this fragment";
    case "drifted_and_upstream_dirty":
      return "drifted + data repo has uncommitted changes for this item";
    case "output_drift":
      return "generated output drifted — run: capshelf apply";
    case "source_dirty_and_output_drift":
      return "generated output drifted + data repo has uncommitted fragment changes";
    case "kept-local":
      return r.localReason ? `kept local (${r.localReason})` : "kept local";
  }
}

function printHuman(
  project: string,
  dataRepo: string | null,
  rows: StatusRow[],
  external: ExternalSkill[],
  externalClaudePlugins: ExternalClaudePlugin[],
  personalClaudeExternal: ExternalPersonalClaudeSkill[],
): void {
  if (
    rows.length === 0 &&
    external.length === 0 &&
    externalClaudePlugins.length === 0 &&
    personalClaudeExternal.length === 0
  ) {
    console.log("(no items tracked)");
    return;
  }
  console.log(
    `${project}  (${rows.length} item${rows.length === 1 ? "" : "s"})`,
  );
  console.log("");

  const projectRows = rows.filter((r) => r.scope === "project");
  const localRows = rows.filter((r) => r.scope === "local");

  if (projectRows.length > 0) {
    console.log("project/");
    for (const r of projectRows) printRow(r);
  }
  if (projectRows.length > 0 && localRows.length > 0) console.log("");
  if (localRows.length > 0) {
    const repoLabel = dataRepo
      ? `from ${homeRelative(dataRepo)}`
      : "no data repo configured — pass --data, set $CAPSHELF_HOME, or run init";
    console.log(`local/  (${repoLabel})`);
    for (const r of localRows) printRow(r);
  }
  if (external.length > 0) {
    if (rows.length > 0) console.log("");
    console.log("external/  (managed by skills.sh)");
    for (const skill of external) {
      const id = `skills/${skill.name}`.padEnd(34);
      console.log(`  •   ${id} ${skill.source}`);
    }
  }
  if (externalClaudePlugins.length > 0) {
    if (rows.length > 0 || external.length > 0) {
      console.log("");
    }
    console.log("external/  (Claude plugins)");
    for (const plugin of externalClaudePlugins) {
      const id = `plugins/${plugin.id}`.padEnd(34);
      const status = plugin.enabled ? "enabled" : "disabled";
      console.log(
        `  •   ${id} ${status} ${plugin.scope} ${homeRelative(plugin.settingsPath)}`,
      );
    }
  }
  if (personalClaudeExternal.length > 0) {
    if (
      rows.length > 0 ||
      external.length > 0 ||
      externalClaudePlugins.length > 0
    ) {
      console.log("");
    }
    console.log("external/  (Personal Claude)");
    for (const skill of personalClaudeExternal) {
      const id = `skills/${skill.name}`.padEnd(34);
      console.log(`  ⚠   ${id} ${homeRelative(skill.path)}`);
      console.log(`      ${skill.warning.message}`);
    }
  }
}

function printRow(r: StatusRow): void {
  const g = glyph(r.state).padEnd(3);
  const id = `${r.source}/${r.kind}/${r.name}`.padEnd(39);
  const label = r.label ? ` ${r.label}` : "";
  console.log(`  ${g} ${id} ${r.lockedSha}${label}  ${describe(r)}`);
  printRuntimeWarnings(r.runtimeWarnings, "    ");
}

function statusTargets(
  projectLock: Lock,
  localLock: Lock,
  ref: ReturnType<typeof parseItemRef> | undefined,
  opts: StatusOptions,
): Array<{ scope: "project" | "local"; key: string }> {
  const includeProject = !opts.local;
  const includeLocal = !opts.project;
  const projectKeys = ref
    ? lockKeysForRef(projectLock, ref)
    : Object.keys(projectLock.items);
  const localKeys = ref
    ? lockKeysForRef(localLock, ref)
    : Object.keys(localLock.items);
  return [
    ...(includeProject
      ? projectKeys.map((key) => ({ scope: "project" as const, key }))
      : []),
    ...(includeLocal
      ? localKeys.map((key) => ({ scope: "local" as const, key }))
      : []),
  ];
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

function assertNoScopeCollisions(projectLock: Lock, localLock: Lock): void {
  const projectKeys = new Set(Object.keys(projectLock.items));
  const collisions = Object.keys(localLock.items).filter((key) =>
    projectKeys.has(key),
  );
  if (collisions.length === 0) return;
  throw new Error(
    `item is owned by both project and local scope: ${collisions.join(", ")}\n` +
      "  remove one owner before checking status; local scope does not shadow project scope",
  );
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

function runtimeWarningFields(
  runtimeWarnings: RuntimeWarning[],
): Pick<StatusRow, "runtimeWarnings"> {
  return runtimeWarnings.length > 0 ? { runtimeWarnings } : {};
}

function personalClaudeExternals(
  rows: StatusRow[],
): ExternalPersonalClaudeSkill[] {
  const out: ExternalPersonalClaudeSkill[] = [];
  for (const row of rows) {
    if (row.kind !== "skills") continue;
    for (const warning of row.runtimeWarnings ?? []) {
      if (warning.type !== "shadowed_by_personal_claude_skill") continue;
      out.push({
        kind: "skills",
        name: row.name,
        path: warning.path,
        warning,
      });
    }
  }
  return out;
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
