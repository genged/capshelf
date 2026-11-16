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
import { registerLock } from "./commands/lock";
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
import { registerUi } from "./commands/ui";
import { CliError } from "./errors";
import { HOME_ENV, PRODUCT_NAME } from "./identity";
import { runStartupSelfUpdate } from "./self-update";

export function createProgram(): Command {
  const program = new Command();

  // Commander 12 retains parsed option state, so build a fresh tree per call;
  // exitOverride keeps in-process callers from having their host terminated.
  program.exitOverride();
  program
    .name(PRODUCT_NAME)
    .description(
      "shared coding-agent config, pinned per project — a change in one repo never disturbs another until that repo asks for it",
    )
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
  registerLock(program);
  registerUpdate(program);
  registerPromote(program);
  registerShare(program);
  registerMove(program);
  registerSelfUpdate(program);
  registerMarketplace(program);
  registerUi(program);

  // The old top-level names (set-data, data-path, sync-data, set-upstream) stay
  // as hidden aliases so existing scripts keep working.
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
 * Returns the exit code instead of calling `process.exit`, including for
 * Commander usage exits, so tests can run it in-process.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();
  try {
    const selfUpdateExit = await runStartupSelfUpdate(argv);
    if (selfUpdateExit !== null) return selfUpdateExit;
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;

    // Options are parsed before the action runs, so --json on argv matches the
    // command's output channel and agents get a JSON error envelope.
    return reportError(err, argv.includes("--json"));
  }
}

function reportError(cause: unknown, json: boolean): number {
  const exitCode = cause instanceof CliError ? cause.exitCode : 1;
  // ResultExitError carries no message because the command already printed its
  // own report.
  const message =
    cause instanceof CliError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const hint = cause instanceof CliError ? cause.hint : undefined;

  if (json) {
    if (message) {
      // Written to the stream directly because Bun colorizes console.error on a
      // TTY, which would wrap the JSON envelope in ANSI escapes.
      process.stderr.write(
        `${JSON.stringify({
          error: { message, ...(hint && { hint }), exitCode },
        })}\n`,
      );
    }
    return exitCode;
  }

  if (message) {
    console.error(`✗ ${message}`);
    if (hint) console.error(`  ${hint}`);
  }
  if (
    !(cause instanceof CliError) &&
    process.env.CAPSHELF_DEBUG &&
    cause instanceof Error &&
    cause.stack
  ) {
    console.error(cause.stack);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
