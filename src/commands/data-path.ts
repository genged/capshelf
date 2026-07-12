import type { Command } from "commander";
import { globalOpts } from "../global-options";
import { loadManifest } from "../manifest";
import { projectRoot, resolveDataRepo } from "../paths";
import { normalizedManifestUpstream } from "../upstream-check";

interface DataPathOptions {
  json?: boolean;
}

export function registerDataPath(program: Command): void {
  program
    .command("data-path")
    .description(
      "print the resolved local data repo path for this project (read-only)",
    )
    .option("--json", "output JSON")
    .action(async (opts: DataPathOptions, cmd: Command) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              path: dataRepo,
              upstream: normalizedManifestUpstream(manifest),
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(dataRepo);
    });
}
