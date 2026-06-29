import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { projectRoot } from "../paths";
import { ResultExitError } from "../errors";
import { globalOpts } from "../cli";
import { parseItemRef } from "../item-ref";
import type { StatusDiff } from "../status-diff";
import { isStrictRuntimeWarning } from "../runtime-warnings";
import { buildStatusReport } from "../status-report";
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
        if (opts.project && opts.local) {
          throw new Error("--project and --local cannot be used together");
        }
        const ref = itemRef ? parseItemRef(itemRef) : undefined;
        const report = await buildStatusReport({
          project,
          dataOverride: globalOpts(cmd).data,
          ref,
          opts,
        });

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(
            formatStatusHuman({
              project: report.project,
              dataRepo: report.dataRepo,
              rows: report.items,
              external: report.external,
              externalClaudePlugins: report.externalClaudePlugins,
              personalClaudeExternal: report.personalClaudeExternal,
            }).join("\n"),
          );
          if (opts.diff) printDiffs(report.diffs ?? []);
        }

        if (
          opts.strict &&
          report.items.some(
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
