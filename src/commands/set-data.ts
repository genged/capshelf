import { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { isRemoteDataUrl } from "../data-bootstrap";
import { assertIsGitRepo } from "../git";
import { PRODUCT_NAME } from "../identity";
import { loadManifest } from "../manifest";
import { loadLock } from "../lock";
import { loadLocalConfig, saveLocalConfig } from "../local-config";
import { normalizePath, projectRoot } from "../paths";
import { verifyDataLockEntries } from "../lock-verify";
import { verifyDataRepoUpstream } from "../upstream-check";
import { PreconditionError } from "../errors";

interface SetDataOptions {
  json?: boolean;
}

export function buildSetData(name: string): Command {
  return new Command(name)
    .description("bind this project to a local clone of its data repo")
    .argument("<path>")
    .option("--json", "output JSON")
    .action(async (path: string, opts: SetDataOptions) => {
      if (isRemoteDataUrl(path)) {
        throw new PreconditionError(
          "set-data expects a local data repo path, not a remote data repo URL.\n\n" +
            "for a new project, bootstrap from the remote URL with:\n" +
            `  ${PRODUCT_NAME} init --data ${path}\n\n` +
            "for an existing project, clone it yourself and bind the local clone:\n" +
            `  git clone ${path} <path>\n` +
            `  ${PRODUCT_NAME} set-data <path>`,
        );
      }
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);
      const storedPath = storedDataRepoPath(path);
      const dataRepo = normalizePath(storedPath, project);

      try {
        await assertIsGitRepo(dataRepo);
      } catch (err) {
        // Preserve the historical behavior: any failure to validate the data
        // repo (including git being unavailable) surfaces as exit 3 here.
        throw new PreconditionError(
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
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
      if (opts.json) {
        console.log(JSON.stringify({ project, dataRepo }, null, 2));
        return;
      }
      console.log(`✓ data repo: ${storedPath}`);
    });
}

function storedDataRepoPath(path: string): string {
  if (path === "~" || path.startsWith("~/")) return path;
  return isAbsolute(path) ? path : resolve(path);
}
