import type { Command } from "commander";
import { ResultExitError } from "../errors";
import { executeSelfUpdateCommand } from "../self-update";

interface SelfUpdateOptions {
  yes?: boolean;
  check?: boolean;
}

export function registerSelfUpdate(program: Command): void {
  program
    .command("self-update")
    .description("check for and install a Homebrew update for capshelf")
    .option("--yes", "upgrade without prompting when an update is available")
    .option("--check", "report update status without upgrading or prompting")
    .action(async (opts: SelfUpdateOptions) => {
      const exitCode = await executeSelfUpdateCommand(opts);
      if (exitCode !== 0) throw new ResultExitError(exitCode);
    });
}
