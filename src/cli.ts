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
import { GitUnavailableError } from "./git";
import { UpstreamVerificationError } from "./upstream-check";
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ ${msg}`);
  process.exit(exitCodeForError(err));
});

function exitCodeForError(err: unknown): number {
  if (err instanceof GitUnavailableError) return err.exitCode;
  if (err instanceof UpstreamVerificationError) return err.exitCode;
  return 1;
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
