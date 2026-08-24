import type { Command } from "commander";
import { existsSync } from "node:fs";
import { DEFAULT_INSTALL_MODE, homeRelative, initProjectRoot } from "../paths";
import { resolveDataRepo, resolveDataRepoOptional } from "../data-repo";
import type { InstallMode } from "../paths";
import { ensureClone, resolveDataInput } from "../data-bootstrap";
import { LOCAL_CONFIG_FILE, METADATA_DIR } from "../identity";
import { loadManifest, saveManifest } from "../manifest";
import { assertLockV4, loadLock, saveLock, systemKey } from "../lock";
import {
  SYSTEM_ITEMS,
  installSystemItem,
  installedMatchesSystemItem,
  shaOfSystemItem,
  CLI_VERSION,
} from "../bundled";
import { findInstallConflict } from "../installed";
import {
  assertDataRepoRoot,
  normalizeRemoteUrl,
  originRemoteUrl,
} from "../git";
import { globalOpts } from "../global-options";
import { PreconditionError } from "../errors";
import { localConfigPath, saveLocalConfig } from "../local-config";
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
        // A re-run after an interrupted init finds its own bundled content
        // sitting there with no lock entry. That is the recovery path, not an
        // unmanaged target — refusing it would strand the project. The test is
        // deliberately exact, so a leftover from an *older* capshelf (whose
        // bundled content differs) or a torn write still refuses; the message
        // below says that deleting it is safe, because init reinstalls it.
        if (await installedMatchesSystemItem(project, item, installMode)) {
          continue;
        }
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

      // `local.json` is written LAST, because the guard at the top of this
      // command keys on its existence. Writing it earlier let an interruption
      // (ENOSPC, read-only .capshelf/, Ctrl-C, a concurrent process) leave a
      // project that init refuses as "already initialized" while `apply`
      // reports nothing tracked, with no supported way out. With this order
      // "already initialized" is true exactly when init finished, and a plain
      // re-run is the recovery.
      await saveManifest(project, manifest);
      await saveLock(project, assertLockV4(lock, "capshelf init"));
      await saveLocalConfig(project, {
        dataRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      });

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
      // The offer runs HERE, after `local.json` — the completion marker this
      // command's own guard keys on — is already on disk. Everything below is
      // an ordinary `add` against a project that is fully initialized, so a
      // cancelled picker, a refused item, or a Ctrl-C at the prompt leaves a
      // working project whose recovery is `capshelf add`. Running it before
      // the writes would put an interactive prompt inside the window where an
      // interruption strands the project, which is the failure mode the write
      // order was designed to remove.
      console.log("");
      const picked =
        opts.pick === false ? null : await offerShelf(cmd, dataRepo);
      // An absent terminal is not an error here. `init` still succeeded, and
      // the hints below are the non-interactive path to the same place.
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
    });
}

/**
 * Offer the shelf, and never fail the init for it.
 *
 * Everything above this point has already been written and reported as
 * successful, so a throw here would print `✗` under a `✓` and exit non-zero
 * for a project that is correctly initialized. The offer is also the one part
 * of `init` that reads the *data repo's* catalog, which has its own refusals —
 * an unsafe item name, an unreadable sidecar — that belong to `ls` and `add`,
 * where the user asked for the shelf. Report and carry on; `capshelf add`
 * afterwards surfaces the same failure with the right exit code.
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
      // The path init just resolved, cloned, and checked. Never the raw
      // `--data` value, which may be a remote URL.
      dataRepo,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`⚠ could not offer the shelf: ${detail.split("\n")[0]}`);
    console.error("  the project is initialized; run capshelf ls to see why");
    return null;
  }
}

function assertUpstreamFlagMatchesBootstrap(
  opts: InitOptions,
  bootstrapUpstream: string,
): void {
  if (typeof opts.upstream !== "string") return;
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
