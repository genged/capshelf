#!/usr/bin/env bun
import { Command } from "commander";
import { CLI_VERSION } from "./bundled";
import { registerInit } from "./commands/init";
import { registerLs } from "./commands/ls";
import { registerShow } from "./commands/show";
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
import { registerSetData } from "./commands/set-data";
import { registerSetUpstream } from "./commands/set-upstream";
import { CliError } from "./errors";
import { HOME_ENV, PRODUCT_NAME } from "./identity";

const program = new Command();

program
  .name(PRODUCT_NAME)
  .description("manage shared Claude Code / Codex config across projects")
  .version(CLI_VERSION)
  .option(
    "-d, --data <path>",
    `override data repo (resolution: --data > .capshelf/local.json > $${HOME_ENV}, no implicit default)`,
  );

registerInit(program);
registerLs(program);
registerShow(program);
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
registerSetData(program);
registerSetUpstream(program);

/**
 * Parse argv and run the matched command, returning the process exit code.
 * This is the only place that decides exit codes for domain failures, and it
 * never calls `process.exit`, so it is callable in-process from tests.
 *
 * Commander still owns usage-layer exits (help, --version, unknown command,
 * missing argument); those are not routed through here.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  if (err instanceof CliError) {
    // A message-less CliError (ResultExitError) only sets the code; the command
    // has already printed its own report.
    if (err.message) {
      console.error(`✗ ${err.message}`);
      if (err.hint) console.error(`  ${err.hint}`);
    }
    return err.exitCode;
  }
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.CAPSHELF_DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}

export interface GlobalOptions {
  data?: string;
}

export function globalOpts(cmd: Command): GlobalOptions {
  // Walk up to root command
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return root.opts() as GlobalOptions;
}
