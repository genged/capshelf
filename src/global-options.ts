import type { Command } from "commander";

/**
 * Leaf module so commands can read global options without importing cli.ts,
 * which would create an import cycle.
 */
export interface GlobalOptions {
  data?: string;
}

export function globalOpts(cmd: Command): GlobalOptions {
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return root.opts<GlobalOptions>();
}
