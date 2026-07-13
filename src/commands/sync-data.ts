import { Command } from "commander";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadManifest } from "../manifest";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../global-options";
import { ResultExitError } from "../errors";
import { formatSyncHuman, syncData } from "../data-sync";

interface SyncDataOptions {
  json?: boolean;
}

export function buildSyncData(name: string): Command {
  return new Command(name)
    .description(
      "fetch the bound data repo's origin and fast-forward when safe (the only network command)",
    )
    .option("--json", "output JSON")
    .action(async (opts: SyncDataOptions, cmd: Command) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      // resolveDataRepo runs the standard upstream verification when the
      // manifest declares dataRepoUpstream (wrong origin fails with exit 4
      // before any fetch). A declared upstream is not required: sync-data
      // syncs against whatever `origin` is.
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      const report = await syncData(dataRepo);
      const { exitCode, ...json } = report;
      if (opts.json) {
        // The full report always prints before any non-zero exit.
        console.log(JSON.stringify(json, null, 2));
      } else {
        console.log(formatSyncHuman(report).join("\n"));
      }
      if (exitCode !== 0) throw new ResultExitError(exitCode);
    });
}
