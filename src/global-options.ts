import type { Command } from "commander";

/**
 * Program-level options shared by every command. Lives in its own leaf module
 * (not cli.ts) so the command layer can read global options without importing
 * the entry point — cli.ts imports every command's `register*`, so a command
 * importing back from cli.ts would close a cycle spanning the whole app.
 */
export interface GlobalOptions {
  data?: string;
}

export function globalOpts(cmd: Command): GlobalOptions {
  // Global options live on the root command; walk up to it from any subcommand.
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return root.opts() as GlobalOptions;
}
