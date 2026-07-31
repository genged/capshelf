#!/usr/bin/env bun
import { Command, CommanderError, type CommandOptions } from "commander";
import { CLI_VERSION } from "./bundled";
import { registerInit } from "./commands/init";
import { registerLs } from "./commands/ls";
import { registerShow } from "./commands/show";
import { registerSearch } from "./commands/search";
import { registerStatus } from "./commands/status";
import { registerAdd } from "./commands/add";
import { registerRm } from "./commands/rm";
import { registerGetPath } from "./commands/get-path";
import { registerApply } from "./commands/apply";
import { registerRevert } from "./commands/revert";
import { registerKeepLocal } from "./commands/keep-local";
import { registerUpdate } from "./commands/update";
import { registerPromote } from "./commands/promote";
import { registerShare } from "./commands/share";
import { registerMove } from "./commands/move";
import { buildSetData } from "./commands/set-data";
import { buildSetUpstream } from "./commands/set-upstream";
import { buildDataPath } from "./commands/data-path";
import { buildSyncData } from "./commands/sync-data";
import { registerSelfUpdate } from "./commands/self-update";
import { registerMarketplace } from "./commands/marketplace";
import { CliError } from "./errors";
import { HOME_ENV, PRODUCT_NAME } from "./identity";
import { runStartupSelfUpdate } from "./self-update";

export function createProgram(): Command {
  const program = new Command();

  // Commander 12 retains parsed option state. Constructing a fresh command
  // tree for every main() call keeps the exported entry point reentrant.
  // Intercept Commander's usage-layer exits so an in-process caller receives
  // an exit code instead of having its host process terminated.
  program.exitOverride();
  program
    .name(PRODUCT_NAME)
    .description("manage shared coding-agent config across projects")
    .version(CLI_VERSION)
    .option(
      "-d, --data <path>",
      `override data repo with a local path (resolution: --data > .capshelf/local.json > $${HOME_ENV}, no implicit default); remote data repo URLs are accepted by init only`,
    );

  registerInit(program);
  registerLs(program);
  registerShow(program);
  registerSearch(program);
  registerStatus(program);
  registerAdd(program);
  registerRm(program);
  registerGetPath(program);
  registerApply(program);
  registerRevert(program);
  registerKeepLocal(program);
  registerUpdate(program);
  registerPromote(program);
  registerShare(program);
  registerMove(program);
  registerSelfUpdate(program);
  registerMarketplace(program);

  // Data-repo commands are grouped under `capshelf data <sub>` for a
  // consistent, scannable surface. The original top-level names
  // (set-data/data-path/sync-data/set-upstream) remain as hidden aliases so
  // existing scripts and muscle memory keep working.
  const data = program
    .command("data")
    .description("bind, inspect, sync, or set the upstream of the data repo");
  addPreparedCommand(data, buildSetData("bind"));
  addPreparedCommand(data, buildDataPath("path"));
  addPreparedCommand(data, buildSyncData("sync"));
  addPreparedCommand(data, buildSetUpstream("upstream"));
  addPreparedCommand(program, buildSetData("set-data"), { hidden: true });
  addPreparedCommand(program, buildDataPath("data-path"), { hidden: true });
  addPreparedCommand(program, buildSyncData("sync-data"), { hidden: true });
  addPreparedCommand(program, buildSetUpstream("set-upstream"), {
    hidden: true,
  });

  return program;
}

function addPreparedCommand(
  parent: Command,
  command: Command,
  options?: CommandOptions,
): void {
  parent.addCommand(command.copyInheritedSettings(parent), options);
}

/**
 * Parse argv and run the matched command, returning the process exit code.
 * This is the only place that decides exit codes for domain failures, and it
 * never calls `process.exit`, so it is callable in-process from tests.
 *
 * Commander usage-layer exits (help, --version, unknown command, missing
 * argument) are translated into return codes too.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();
  try {
    const selfUpdateExit = await runStartupSelfUpdate(argv);
    if (selfUpdateExit !== null) return selfUpdateExit;
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    // Commander already emitted help, version, or a usage diagnostic before
    // exitOverride() threw. Preserve that output and return its requested code
    // without printing a second error.
    if (err instanceof CommanderError) return err.exitCode;

    // Options are parsed before the action runs, so by the time an action
    // throws --json (if present) is on argv. Match the command's own output
    // channel: agents that pass --json get a JSON error envelope, not prose.
    return reportError(err, argv.includes("--json"));
  }
}

function reportError(err: unknown, json: boolean): number {
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  // ResultExitError carries no message: the command already printed its own
  // report (its --json payload is on stdout), so the boundary prints nothing.
  const message =
    err instanceof CliError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const hint = err instanceof CliError ? err.hint : undefined;

  if (json) {
    if (message) {
      console.error(
        JSON.stringify({
          error: { message, ...(hint && { hint }), exitCode },
        }),
      );
    }
    return exitCode;
  }

  if (message) {
    console.error(`✗ ${message}`);
    if (hint) console.error(`  ${hint}`);
  }
  if (
    !(err instanceof CliError) &&
    process.env.CAPSHELF_DEBUG &&
    err instanceof Error &&
    err.stack
  ) {
    console.error(err.stack);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
