import type { Command } from "commander";
import { DEFAULT_INSTALL_MODE, homeRelative, initProjectRoot } from "../paths";
import { resolveDataRepo, resolveDataRepoOptional } from "../data-repo";
import type { InstallMode } from "../paths";
import { ensureClone, resolveDataInput } from "../data-bootstrap";
import { LOCAL_CONFIG_FILE, METADATA_DIR } from "../identity";
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
import { globalOpts } from "../global-options";
import { PreconditionError } from "../errors";
import { saveLocalConfig } from "../local-config";
import { UpstreamVerificationError } from "../upstream-check";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";

interface InitOptions {
  data?: string;
  dataDir?: string;
  claudeOnly?: boolean;
  json?: boolean;
  upstream?: string | false;
}

interface BootstrapInfo {
  url: string;
  upstream: string;
  clonePath: string;
  cloned: boolean;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "initialize capshelf for the current project (binds a data repo and installs system items without overwriting untracked targets)",
    )
    .option(
      "--data <path|url>",
      "local data repo path or remote data repo URL to bind this project to",
    )
    .option(
      "--data-dir <path>",
      "clone destination when --data is a remote data repo URL",
    )
    .option("--upstream <url>", "declared upstream URL for the data repo")
    .option("--no-upstream", "omit dataRepoUpstream even when origin exists")
    .option(
      "--claude-only",
      "install directly under .claude without .agents symlinks",
    )
    .option("--json", "output JSON")
    .action(async (opts: InitOptions, cmd: Command) => {
      const project = initProjectRoot();
      const manifest = await loadManifest(project);
      const installMode = resolveInstallMode(manifest.installMode, opts);
      const lock = await loadLock(project);

      // CLI-local --data wins, else global --data, else existing local/env
      // binding, else the committed upstream can bootstrap a cloned project.
      const input = opts.data ?? globalOpts(cmd).data;
      let dataRepo: string;
      let bootstrap: BootstrapInfo | undefined;
      if (input !== undefined) {
        const resolved = resolveDataInput(input, { dataDir: opts.dataDir });
        if (resolved.kind === "remote-bootstrap") {
          // A mismatched --upstream would bind the project to an upstream its
          // own clone can never satisfy; fail before cloning or writing state.
          assertUpstreamFlagMatchesBootstrap(opts, resolved.upstream);
          const { cloned } = await ensureClone(
            resolved.url,
            resolved.clonePath,
            resolved.upstream,
          );
          bootstrap = {
            url: resolved.url,
            upstream: resolved.upstream,
            clonePath: resolved.clonePath,
            cloned,
          };
          dataRepo = await resolveDataRepo({
            override: resolved.clonePath,
            manifest,
            project,
          });
        } else {
          if (opts.dataDir !== undefined) {
            throw new PreconditionError(
              "--data-dir requires --data <remote-data-repo-url>",
            );
          }
          dataRepo = await resolveDataRepo({
            override: resolved.path,
            manifest,
            project,
          });
        }
      } else {
        const resolved = await resolveDataRepoOptional({ manifest, project });
        if (resolved !== null) {
          if (opts.dataDir !== undefined) {
            throw new PreconditionError(
              "--data-dir requires --data <remote-data-repo-url>",
            );
          }
          dataRepo = resolved;
        } else if (manifest.dataRepoUpstream) {
          const resolved = resolveDataInput(manifest.dataRepoUpstream, {
            dataDir: opts.dataDir,
          });
          if (resolved.kind !== "remote-bootstrap") {
            throw new Error(
              `dataRepoUpstream must be a supported git remote URL: ${manifest.dataRepoUpstream}`,
            );
          }
          const { cloned } = await ensureClone(
            resolved.url,
            resolved.clonePath,
            resolved.upstream,
          );
          bootstrap = {
            url: resolved.url,
            upstream: resolved.upstream,
            clonePath: resolved.clonePath,
            cloned,
          };
          dataRepo = resolved.clonePath;
        } else {
          if (opts.dataDir !== undefined) {
            throw new PreconditionError(
              "--data-dir requires --data <remote-data-repo-url>",
            );
          }
          dataRepo = await resolveDataRepo({ manifest, project });
        }
      }

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
          throw new PreconditionError(
            `not installing system/${item.kind}/${item.name} — target already exists but is not managed by capshelf\n` +
              `  existing path: ${conflict}\n` +
              "  remove it manually or choose a different local skill name before running capshelf init",
          );
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
              ...(bootstrap && {
                bootstrap: {
                  url: bootstrap.url,
                  upstream: bootstrap.upstream,
                  clonePath: bootstrap.clonePath,
                  cloned: bootstrap.cloned,
                },
              }),
              installed,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (bootstrap) {
        console.log(
          bootstrap.cloned
            ? "cloned data repo:"
            : "using existing data repo clone:",
        );
        console.log(`  ${bootstrap.url}`);
        console.log(`  -> ${homeRelative(bootstrap.clonePath)}`);
        console.log("");
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
      if (bootstrap) {
        console.log("");
        console.log("bound project data repo:");
        console.log(`  ${METADATA_DIR}/${LOCAL_CONFIG_FILE}`);
        if (manifest.dataRepoUpstream) {
          console.log("");
          console.log("upstream:");
          console.log(`  ${manifest.dataRepoUpstream}`);
        }
      }
      console.log("");
      console.log("next:");
      console.log(
        "  capshelf search <task>       # find matching items and bundles",
      );
      console.log("  capshelf ls                  # browse the shelf");
      console.log("  capshelf add bundles/<name>  # install a curated bundle");
    });
}

function assertUpstreamFlagMatchesBootstrap(
  opts: InitOptions,
  bootstrapUpstream: string,
): void {
  if (typeof opts.upstream !== "string") return;
  const normalized = normalizeRemoteUrl(opts.upstream);
  if (!normalized) {
    throw new Error(`unsupported git remote URL: ${opts.upstream}`);
  }
  if (normalized === bootstrapUpstream) return;
  throw new UpstreamVerificationError(
    "--upstream conflicts with the remote data repo URL passed to --data.\n\n" +
      `  --data normalizes to:     ${bootstrapUpstream}\n` +
      `  --upstream normalizes to: ${normalized}\n\n` +
      "  pass matching URLs, or omit --upstream to record the --data identity",
  );
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
    if (!normalized)
      throw new Error(`unsupported git remote URL: ${opts.upstream}`);
    await assertDataRepoOriginMatchesUpstream(dataRepo, normalized);
    return normalized;
  }

  const origin = await originRemoteUrl(dataRepo);
  const normalized = origin ? normalizeRemoteUrl(origin) : null;
  if (normalized) return normalized;

  throw new PreconditionError(
    "could not determine a portable data repo upstream.\n\n" +
      `  data repo: ${homeRelative(dataRepo)}\n` +
      (origin ? `  origin: ${origin.trim()}\n\n` : "\n") +
      "capshelf records dataRepoUpstream so fresh clones know where shared items come from.\n\n" +
      "fix by one of:\n" +
      "  - configure the data repo's origin, then retry:\n" +
      `      git -C ${homeRelative(dataRepo)} remote ${origin ? "set-url" : "add"} origin <data-repo-url>\n` +
      "  - mark this project intentionally non-portable:\n" +
      "      capshelf init --data <path-or-url> --no-upstream",
  );
}

async function assertDataRepoOriginMatchesUpstream(
  dataRepo: string,
  upstream: string,
): Promise<void> {
  const origin = await originRemoteUrl(dataRepo);
  const normalizedOrigin = origin ? normalizeRemoteUrl(origin) : null;
  if (normalizedOrigin === upstream) return;

  throw new UpstreamVerificationError(
    "data repo origin does not match --upstream.\n\n" +
      `  data repo: ${homeRelative(dataRepo)}\n` +
      `  --upstream: ${upstream}\n` +
      `  origin:     ${origin ? (normalizedOrigin ?? origin.trim()) : "(no origin remote)"}\n\n` +
      "configure the clone's origin first, then retry:\n" +
      `  git -C ${homeRelative(dataRepo)} remote ${origin ? "set-url" : "add"} origin ${upstream}`,
  );
}

function hasUpstreamFlag(argv: string[] = process.argv): boolean {
  return argv.some(
    (arg) => arg === "--upstream" || arg.startsWith("--upstream="),
  );
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
