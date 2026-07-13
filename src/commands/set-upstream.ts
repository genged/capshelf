import { Command } from "commander";
import { normalizeRemoteUrl } from "../git";
import { loadManifest, saveManifest } from "../manifest";
import { projectRoot } from "../paths";
import { PreconditionError } from "../errors";

interface SetUpstreamOptions {
  json?: boolean;
}

export function buildSetUpstream(name: string): Command {
  return new Command(name)
    .description(
      "set the committed dataRepoUpstream URL in .capshelf/capshelf.json",
    )
    .argument("<url>")
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
