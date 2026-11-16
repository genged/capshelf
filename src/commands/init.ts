import type { Command } from "commander";
import { existsSync } from "node:fs";
import { DEFAULT_INSTALL_MODE, homeRelative, initProjectRoot } from "../paths";
import { resolveDataRepo, resolveDataRepoOptional } from "../data-repo";
import type { InstallMode } from "../paths";
import { ensureClone, resolveDataInput } from "../data-bootstrap";
import { LOCAL_CONFIG_FILE, METADATA_DIR } from "../identity";
import { loadManifest, saveManifest } from "../manifest";
import { assertWritableLock, loadLock, saveLock, systemKey } from "../lock";
import {
  SYSTEM_ITEMS,
  installedMatchesSystemItem,
  shaOfSystemItem,
  CLI_VERSION,
} from "../bundled";
import { findInstallConflict } from "../installed";
import { contentSourceFor } from "../item-source";
import type { SystemLockEntry } from "../lock";
import { materializeLockEntry } from "../materialize";
import { holdsOnlyMountPoints } from "../mount-points";
import {
  assertDataRepoRoot,
  normalizeRemoteUrl,
  originRemoteUrl,
} from "../git";
import { globalOpts } from "../global-options";
import { PreconditionError, firstErrorLine } from "../errors";
import { localConfigPath, saveLocalConfig } from "../local-config";
import { projectRegistryPath, registerProject } from "../project-registry";
import { UpstreamVerificationError } from "../upstream-check";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import { runInteractiveAdd } from "./add";
import type { InteractiveAddSummary } from "./add";
import { pickUnavailableMessage } from "../pick";

interface InitOptions {
  data?: string;
  dataDir?: string;
  claudeOnly?: boolean;
  json?: boolean;
  upstream?: string | false;
  pick?: boolean;
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
    .option(
      "--no-pick",
      "skip the interactive picker and install no data items",
    )
    .option("--json", "output JSON")
    .action(async (opts: InitOptions, cmd: Command) => {
      const project = initProjectRoot();
      if (existsSync(localConfigPath(project))) {
        throw new PreconditionError(
          `capshelf is already initialized for this machine at ${project}`,
          {
            hint:
              "init is only for new projects or fresh clones without .capshelf/local.json.\n" +
              "  use 'capshelf data bind <path>' to change the local data repo,\n" +
              "  use 'capshelf data upstream <url>' to change its committed upstream, or\n" +
              "  use 'capshelf update' to update managed items.",
          },
        );
      }
      const manifest = await loadManifest(project);
      const installMode = resolveInstallMode(manifest.installMode, opts);
      const lock = await loadLock(project);

      const input = opts.data ?? globalOpts(cmd).data;
      let dataRepo: string;
      let bootstrap: BootstrapInfo | undefined;
      if (input !== undefined) {
        const resolved = resolveDataInput(input, { dataDir: opts.dataDir });
        if (resolved.kind === "remote-bootstrap") {
          // Fail before cloning or writing state: a mismatched --upstream can
          // never be satisfied by the clone.
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

      // Fail before writing state, or the project binds to a path that `ls` and
      // `add` can't use.
      await assertDataRepoRoot(dataRepo);

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
        if (lock.items[key] !== undefined || !conflict) continue;
        // Matching bundled content from an interrupted init is the recovery
        // path, not an unmanaged target; leftovers whose content differs from
        // the bundled item still refuse.
        if (await installedMatchesSystemItem(project, item, installMode)) {
          continue;
        }
        // `rm` or a failed write leaves a bare mount point for items with a
        // mounted volume; the write fills it and keeps the volume.
        if (await holdsOnlyMountPoints(conflict)) continue;
        throw new PreconditionError(
          `not installing system/${item.kind}/${item.name} — target already exists but is not managed by capshelf\n` +
            `  existing path: ${conflict}\n` +
            "  remove it manually or choose a different local skill name before running capshelf init\n" +
            `  if an interrupted init left it there, deleting it is safe — capshelf reinstalls ${item.kind}/${item.name} from the binary`,
        );
      }

      const installed: {
        kind: string;
        name: string;
        sha: string;
        dst: string;
        runtimeWarnings?: RuntimeWarning[];
      }[] = [];
      // System items use the `update` writer, which keeps ignored local state
      // and mounted volumes and reads the install mode from the manifest, so
      // save the manifest first.
      await saveManifest(project, manifest);
      for (const item of SYSTEM_ITEMS) {
        const key = systemKey(item.kind, item.name);
        const sha = await shaOfSystemItem(item);
        const entry: SystemLockEntry = {
          source: "system",
          sha,
          cliVersion: CLI_VERSION,
          appliedAt: new Date().toISOString(),
        };
        const previous = lock.items[key];
        const { path: dst } = await materializeLockEntry({
          project,
          source: contentSourceFor({
            entry,
            kind: item.kind,
            name: item.name,
          }),
          kind: item.kind,
          name: item.name,
          key,
          manifest,
          entry,
          ...(previous !== undefined && {
            previous: {
              entry: previous,
              source: contentSourceFor({
                entry: previous,
                kind: item.kind,
                name: item.name,
              }),
            },
          }),
          scope: "project",
        });
        const runtimeWarnings = runtimeWarningsForItem(
          project,
          item.kind,
          item.name,
        );
        lock.items[key] = entry;
        installed.push({
          kind: item.kind,
          name: item.name,
          sha,
          dst,
          ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
        });
      }

      // Write `local.json` last: the already-initialized guard keys on it, so
      // an interruption leaves the project re-runnable.
      await saveManifest(project, manifest);
      await saveLock(project, assertWritableLock(lock, "capshelf init"));
      await saveLocalConfig(project, {
        dataRepo,
        skills: [],
        plugins: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      });
      // A registry write failure is reported but must not fail an init that
      // already succeeded.
      const registryPath = projectRegistryPath();
      let registryError: string | null = null;
      try {
        await registerProject(project, registryPath);
      } catch (error) {
        registryError = firstErrorLine(error);
      }

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
              registry: {
                path: registryPath,
                ...(registryError !== null && { error: registryError }),
              },
            },
            null,
            2,
          ),
        );
        if (registryError !== null) {
          console.error(
            `⚠ could not register the project for capshelf ui: ${registryError}`,
          );
        }
        return;
      }
      if (bootstrap) {
        console.log(
          bootstrap.cloned
            ? "cloned data repo:"
            : "using existing data repo clone:",
        );
        console.log(`  ${bootstrap.url}`);
        // Absolute, not `~`-relative: in a container `~` is often a folder
        // the user cannot see, and the short form hides that.
        console.log(`  -> ${bootstrap.clonePath}`);
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
      if (registryError === null) {
        console.log(
          `  registered for capshelf ui: ${homeRelative(registryPath)}`,
        );
      } else {
        console.error(
          `⚠ could not register the project for capshelf ui: ${registryError}`,
        );
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
      // Offer after `local.json` is written so a cancelled picker or Ctrl-C
      // leaves a working project recoverable with `capshelf add`.
      console.log("");
      const picked =
        opts.pick === false ? null : await offerShelf(cmd, dataRepo);
      if (picked?.outcome === "unavailable") {
        console.log(
          `(skipping the picker — ${pickUnavailableMessage(picked.reason)})`,
        );
      }

      const installedAny =
        picked?.outcome === "installed" && picked.added.length > 0;
      console.log("");
      console.log("next:");
      console.log(
        `  capshelf add                 # pick ${installedAny ? "more items" : "items"} from the shelf`,
      );
      console.log(
        "  capshelf search <task>       # find matching items and bundles",
      );
      console.log("  capshelf ls                  # browse the shelf");
      console.log("  capshelf add bundles/<name>  # install a curated bundle");
      console.log(
        "  capshelf share               # put this project's config on the shelf",
      );
    });
}

/**
 * Never fail init for the offer: everything is already written, and catalog
 * refusals belong to `ls` and `add`.
 */
async function offerShelf(
  cmd: Command,
  dataRepo: string,
): Promise<InteractiveAddSummary | null> {
  try {
    return await runInteractiveAdd({
      add: {},
      cmd,
      message: "Select items to install from the shelf",
      // Pass the resolved path, not the raw `--data` value, which may be a
      // remote URL.
      dataRepo,
    });
  } catch (error) {
    console.error(`⚠ could not offer the shelf: ${firstErrorLine(error)}`);
    console.error("  the project is initialized; run capshelf ls to see why");
    return null;
  }
}

function assertUpstreamFlagMatchesBootstrap(
  opts: InitOptions,
  bootstrapUpstream: string,
): void {
  if (opts.upstream === undefined || opts.upstream === false) return;
  const normalized = normalizeRemoteUrl(opts.upstream);
  if (!normalized) {
    throw new PreconditionError(`unsupported git remote URL: ${opts.upstream}`);
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
    throw new PreconditionError(
      "--upstream and --no-upstream cannot be used together",
    );
  }
  if (opts.upstream === false) return null;
  if (opts.upstream) {
    const normalized = normalizeRemoteUrl(opts.upstream);
    if (!normalized)
      throw new PreconditionError(
        `unsupported git remote URL: ${opts.upstream}`,
      );
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
