import { Command } from "commander";
import {
  DEFAULT_INSTALL_MODE,
  projectRoot,
  resolveDataRepo,
} from "../paths";
import type { InstallMode } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import { loadLock, saveLock, systemKey } from "../lock";
import {
  SYSTEM_ITEMS,
  installSystemItem,
  shaOfSystemItem,
  CLI_VERSION,
} from "../bundled";
import { findInstallConflict } from "../installed";
import { assertIsGitRepo, normalizeRemoteUrl, originRemoteUrl } from "../git";
import { globalOpts } from "../cli";
import { saveLocalConfig } from "../local-config";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";

interface InitOptions {
  data?: string;
  claudeOnly?: boolean;
  json?: boolean;
  upstream?: string | false;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "initialize capshelf for the current project (binds a data repo and installs system items without overwriting untracked targets)",
    )
    .option("--data <path>", "data repo to bind this project to")
    .option("--upstream <url>", "declared upstream URL for the data repo")
    .option("--no-upstream", "omit dataRepoUpstream even when origin exists")
    .option("--claude-only", "install directly under .claude without .agents symlinks")
    .option("--json", "output JSON")
    .action(async (opts: InitOptions, cmd: Command) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const installMode = resolveInstallMode(manifest.installMode, opts);
      const lock = await loadLock(project);

      // CLI-local --data wins, else global --data, else env, else default
      const override = opts.data ?? globalOpts(cmd).data;
      const dataRepo = await resolveDataRepo({ override, manifest, project });

      // Fail BEFORE writing any state if the data repo isn't a usable git repo.
      // Otherwise we'd silently bind the project to a bad path that ls/add can't use.
      await assertIsGitRepo(dataRepo);

      manifest.installMode = installMode;
      const upstream = await initUpstream(dataRepo, opts);
      if (upstream) manifest.dataRepoUpstream = upstream;
      else delete manifest.dataRepoUpstream;

      for (const item of SYSTEM_ITEMS) {
        const key = systemKey(item.kind, item.name);
        const conflict = findInstallConflict(
          project,
          item.kind,
          item.name,
          installMode,
        );
        if (lock.items[key] === undefined && conflict) {
          console.error(
            `✗ not installing system/${item.kind}/${item.name} — target already exists but is not managed by capshelf`,
          );
          console.error(`  existing path: ${conflict}`);
          console.error(
            "  remove it manually or choose a different local skill name before running capshelf init",
          );
          process.exit(3);
        }
      }

      const installed: {
        kind: string;
        name: string;
        sha: string;
        dst: string;
        runtimeWarnings?: RuntimeWarning[];
      }[] = [];
      for (const item of SYSTEM_ITEMS) {
        const dst = await installSystemItem(project, item, installMode);
        const sha = await shaOfSystemItem(item);
        const runtimeWarnings = runtimeWarningsForItem(
          project,
          item.kind,
          item.name,
        );
        lock.items[systemKey(item.kind, item.name)] = {
          source: "system",
          sha,
          cliVersion: CLI_VERSION,
          appliedAt: new Date().toISOString(),
        };
        installed.push({
          kind: item.kind,
          name: item.name,
          sha,
          dst,
          ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
        });
      }

      await saveManifest(project, manifest);
      await saveLocalConfig(project, {
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      });
      await saveLock(project, lock);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              project,
              installMode,
              dataRepo,
              dataRepoUpstream: manifest.dataRepoUpstream ?? null,
              installed,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`✓ initialized at ${project}`);
      console.log(`  install mode: ${installMode}`);
      console.log(`  data repo: ${dataRepo}`);
      if (manifest.dataRepoUpstream) {
        console.log(`  data repo upstream: ${manifest.dataRepoUpstream}`);
      }
      for (const i of installed) {
        console.log(`✓ system/${i.kind}/${i.name} @ ${i.sha}`);
        console.log(`  ${i.dst}`);
        printRuntimeWarnings(i.runtimeWarnings);
      }
    });
}

async function initUpstream(
  dataRepo: string,
  opts: InitOptions,
): Promise<string | null> {
  if (hasUpstreamFlag() && hasNoUpstreamFlag()) {
    throw new Error("--upstream and --no-upstream cannot be used together");
  }
  if (opts.upstream === false) return null;
  if (opts.upstream) {
    const normalized = normalizeRemoteUrl(opts.upstream);
    if (!normalized) throw new Error(`unsupported git remote URL: ${opts.upstream}`);
    return normalized;
  }

  const origin = await originRemoteUrl(dataRepo);
  return origin ? normalizeRemoteUrl(origin) : null;
}

function hasUpstreamFlag(argv: string[] = process.argv): boolean {
  return argv.some((arg) => arg === "--upstream" || arg.startsWith("--upstream="));
}

function hasNoUpstreamFlag(argv: string[] = process.argv): boolean {
  return argv.includes("--no-upstream");
}

function resolveInstallMode(
  manifestMode: InstallMode | undefined,
  opts: InitOptions,
): InstallMode {
  if (opts.claudeOnly) return "claude-only";
  return manifestMode ?? DEFAULT_INSTALL_MODE;
}
