import type { Command } from "commander";
import { normalizeRemoteUrl } from "../git";
import { loadManifest, saveManifest } from "../manifest";
import { projectRoot } from "../paths";
import { PreconditionError } from "../errors";

interface SetUpstreamOptions {
  json?: boolean;
}

export function registerSetUpstream(program: Command): void {
  program
    .command("set-upstream <url>")
    .description(
      "set the committed dataRepoUpstream URL in .capshelf/capshelf.json",
    )
    .option("--json", "output JSON")
    .action(async (url: string, opts: SetUpstreamOptions) => {
      const normalized = normalizeRemoteUrl(url);
      if (!normalized) {
        throw new PreconditionError(`unsupported git remote URL: ${url}`);
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      manifest.dataRepoUpstream = normalized;
      await saveManifest(project, manifest);
      if (opts.json) {
        console.log(
          JSON.stringify({ project, dataRepoUpstream: normalized }, null, 2),
        );
        return;
      }
      console.log(`✓ data repo upstream: ${normalized}`);
    });
}
