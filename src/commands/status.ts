import type { Command, Command as CmdType } from "commander";
import { findProjectRoot, projectRoot } from "../paths";
import { loadLocalLock, loadLock } from "../lock";
import { loadRemotesLock, saveRemotesLock } from "../remotes-lock";
import { checkRemoteUpstreams } from "../remote-status";
import type { UpstreamFetchReport } from "../remote-status";
import { loadManifest } from "../manifest";
import { PreconditionError, ResultExitError } from "../errors";
import { CLI_VERSION } from "../bundled";
import { globalOpts } from "../global-options";
import { parseItemRef } from "../item-ref";
import { listUserSkills, withUserSkillShadows } from "../external";
import type { ExternalUserSkill } from "../external";
import type { StatusDiff, StatusDiffView } from "../status-diff";
import { assertNoScopeCollisions } from "../status-core";
import { formatStatusHuman, formatUserSkillsHuman } from "../status-format";
import {
  buildStatusReport,
  collectStatusDiffs,
  filterUserSkillsForRef,
  resolveStatusDataRepo,
  rowFailsStrict,
} from "../status-report";

interface StatusOptions {
  json?: boolean;
  checkUpstream?: boolean;
  strict?: boolean;
  diff?: boolean;
  diffView?: string;
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
    .option(
      "--diff",
      "show installed and committed upstream diffs against the locked content",
    )
    .option(
      "--diff-view <view>",
      "select installed, upstream, or all (implies --diff)",
    )
    .option("--project", "show committed project-scope items only")
    .option("--local", "show clone-local items only")
    .option("--user", "show user-level runtime skills only")
    .option(
      "--check-upstream",
      "fetch every tracked remote repository and report which pins moved",
    )
    .action(
      async (
        itemRef: string | undefined,
        opts: StatusOptions,
        cmd: CmdType,
      ) => {
        const diffView = parseDiffView(opts.diffView);
        if (opts.diffView !== undefined) opts.diff = true;
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
        const loadedRemotes = await loadRemotesLock(project);
        assertNoScopeCollisions(projectLock, localLock);
        const dataRepo = await resolveStatusDataRepo({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });

        // The one fetch `status` performs, and only when the flag asks for it.
        // The freshness it measures is saved before the report is built, so
        // the rows are computed from the record on disk.
        const check = opts.checkUpstream
          ? await checkRemoteUpstreams({ remotes: loadedRemotes })
          : null;
        if (check) {
          if (!opts.json) printFetches(check.fetches);
          // Only when something was measured. `checkRemoteUpstreams` produces
          // one entry per distinct upstream, so an empty list means the project
          // holds no pulled skills — and `saveRemotesLock` would then create the
          // record *and* append a line to the committed `.capshelf/.gitignore`,
          // leaving a dirty worktree behind a command that only reports.
          if (check.fetches.length > 0) {
            await saveRemotesLock(project, check.remotes);
          }
        }
        const remotes = check?.remotes ?? loadedRemotes;

        const ref = itemRef ? parseItemRef(itemRef) : undefined;
        const report = await buildStatusReport({
          project,
          manifest,
          projectLock,
          localLock,
          remotes,
          dataRepo,
          ref,
          scope: { project: opts.project, local: opts.local },
        });
        const {
          rows,
          external,
          externalClaudePlugins,
          externalUserSkills,
          personalClaudeExternal,
        } = report;

        const diffs: StatusDiff[] = opts.diff
          ? await collectStatusDiffs({
              project,
              dataRepo,
              manifest,
              projectLock,
              localLock,
              rows,
              view: diffView,
            })
          : [];

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                project,
                dataRepo,
                cliVersion: CLI_VERSION,
                count: rows.length,
                items: rows,
                ...(check && { fetches: check.fetches }),
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
          if (opts.diff) {
            printDiffs(
              diffs,
              rows.some((row) => row.needsState === "update_available"),
            );
          }
        }

        if (opts.strict && rows.some(rowFailsStrict)) {
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
  if (opts.checkUpstream) {
    throw new PreconditionError(
      "--check-upstream is not supported with --user; user-level skills have no capshelf pin",
    );
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

function printDiffs(diffs: StatusDiff[], needsChanged: boolean): void {
  console.log("");
  if (diffs.length === 0) {
    console.log(
      needsChanged
        ? "(no content differences; declared needs changed)"
        : "(no content differences)",
    );
    return;
  }

  for (const [index, diff] of diffs.entries()) {
    if (index > 0) console.log("");
    console.log(`diff ${diff.item} [locked -> ${diff.view}]`);
    if (diff.text === null) {
      console.log(`${diff.view} diff unavailable: ${diff.unavailableReason}`);
    } else {
      process.stdout.write(diff.text);
    }
    if (diff.note) console.log(`note: ${diff.note}`);
  }
}

/** One line per repository, before the report, the way `data sync` reports. */
function printFetches(fetches: UpstreamFetchReport[]): void {
  for (const fetch of fetches) {
    const detail = !fetch.ok
      ? `failed — ${fetch.stderr.split("\n")[0] ?? "no output"}`
      : fetch.newCommits === null || fetch.newCommits === 0
        ? "up to date"
        : `${fetch.newCommits} new ${fetch.newCommits === 1 ? "commit" : "commits"}`;
    console.log(`  fetching  ${fetch.upstream} ... ${detail}`);
  }
  if (fetches.length > 0) console.log("");
}

function parseDiffView(value: string | undefined): StatusDiffView {
  if (value === undefined) return "all";
  if (value === "installed" || value === "upstream" || value === "all") {
    return value;
  }
  throw new PreconditionError(
    `invalid --diff-view ${value}; expected installed, upstream, or all`,
  );
}
