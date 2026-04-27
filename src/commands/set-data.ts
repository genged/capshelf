import { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { assertIsGitRepo } from "../git";
import { loadManifest } from "../manifest";
import { loadLock } from "../lock";
import { loadLocalConfig, saveLocalConfig } from "../local-config";
import { normalizePath, projectRoot } from "../paths";
import { verifyDataLockEntries } from "../lock-verify";
import { verifyDataRepoUpstream } from "../upstream-check";

export function registerSetData(program: Command): void {
  program
    .command("set-data <path>")
    .description("bind this project to a local clone of its data repo")
    .action(async (path: string) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);
      const storedPath = storedDataRepoPath(path);
      const dataRepo = normalizePath(storedPath, project);

      try {
        await assertIsGitRepo(dataRepo);
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(3);
      }

      await verifyDataRepoUpstream(dataRepo, manifest);
      await verifyDataLockEntries(dataRepo, manifest, lock);
      const existing = await loadLocalConfig(project);
      await saveLocalConfig(project, {
        dataRepo: storedPath,
        skills: existing?.skills ?? [],
        settings: existing?.settings ?? [],
        mcp: existing?.mcp ?? [],
      });
      console.log(`✓ data repo: ${storedPath}`);
    });
}

function storedDataRepoPath(path: string): string {
  if (path === "~" || path.startsWith("~/")) return path;
  return isAbsolute(path) ? path : resolve(path);
}
