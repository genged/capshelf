import type { Command } from "commander";
import { normalizeRemoteUrl } from "../git";
import { loadManifest, saveManifest } from "../manifest";
import { projectRoot } from "../paths";

export function registerSetUpstream(program: Command): void {
  program
    .command("set-upstream <url>")
    .description(
      "set the committed dataRepoUpstream URL in .capshelf/capshelf.json",
    )
    .action(async (url: string) => {
      const normalized = normalizeRemoteUrl(url);
      if (!normalized) throw new Error(`unsupported git remote URL: ${url}`);

      const project = projectRoot();
      const manifest = await loadManifest(project);
      manifest.dataRepoUpstream = normalized;
      await saveManifest(project, manifest);
      console.log(`✓ data repo upstream: ${normalized}`);
    });
}
