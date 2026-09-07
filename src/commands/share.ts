/**
 * `capshelf share`: registers the command, then sends a named item to
 * `share-named.ts` and no item to the picker in `share-interactive.ts`. The
 * picker calls the named path, so the entry is the only module that imports
 * both.
 */
import type { Command } from "commander";
import { PreconditionError, ResultExitError } from "../errors";
import { pickUnavailableMessage } from "../pick";
import { runInteractiveShare } from "./share-interactive";
import { shareOne } from "./share-named";
import type { ShareOptions } from "./share-named";

export function registerShare(program: Command): void {
  program
    .command("share [item]")
    .description(
      "adopt an on-disk item into the data repo and track it here; with no item, pick unmanaged config values and untracked items interactively",
    )
    .option(
      "--to <scope>",
      "resulting scope: local or project (default: local for skills, project for Pi extensions, subagents, and fragments)",
    )
    .option("--from <path>", "source file for fragment or subagent items")
    .option(
      "--pick <path>",
      "extract an unmanaged value from the generated output instead of --from; repeatable (fragment items; mcp picks accept bare server names and default to the item name)",
      collectPick,
    )
    .option(
      "--target <target>",
      "runtime target for mcp or subagent items: claude or codex",
    )
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .addHelpText(
      "after",
      "\nRecovery: if the data-repo commit succeeds but local metadata is interrupted, rerun add <item> or add --local <item>.",
    )
    .action(
      async (itemRef: string | undefined, opts: ShareOptions, cmd: Command) => {
        if (itemRef === undefined) {
          await shareWithoutItem(opts, cmd);
          return;
        }
        await shareOne(itemRef, opts, cmd);
      },
    );
}

/**
 * The no-item branch: the interactive picker over unmanaged config values and
 * the untracked skills, Pi extensions, and subagents found on disk.
 */
async function shareWithoutItem(
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  // These flags describe one named share. With no item there is nothing for
  // them to describe, and silently ignoring a flag installs the wrong habit.
  // `!== undefined`, not truthiness: commander stores `--from ""` as an empty
  // string, and an explicitly supplied flag must refuse like any other.
  if (
    opts.from !== undefined ||
    opts.pick !== undefined ||
    opts.target !== undefined ||
    opts.to !== undefined
  ) {
    throw new PreconditionError(
      "share --from, --pick, --target, and --to require an item; run capshelf share with no flags to pick interactively",
    );
  }
  // `--json` names a scripted caller, and a script cannot answer a prompt.
  if (opts.json) {
    throw new PreconditionError(
      "share --json requires an item; the interactive picker needs a terminal",
      {
        hint: "pass an item ref (capshelf share settings/<name> --pick <path>), or run capshelf share without --json to pick interactively",
      },
    );
  }
  const summary = await runInteractiveShare({ share: opts, cmd });
  if (summary.outcome === "unavailable") {
    throw new PreconditionError(
      `cannot pick interactively — ${pickUnavailableMessage(summary.reason)}`,
      {
        hint: "name the item instead: capshelf share <kind>/<name> --pick <path>",
      },
    );
  }
  // Any failed item is a refusal the user needs a non-zero code for; each one
  // already printed its reason and its retry command.
  if (summary.outcome === "shared" && summary.failed.length > 0) {
    throw new ResultExitError(3);
  }
}

function collectPick(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}
