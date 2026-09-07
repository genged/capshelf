/**
 * `capshelf promote`: registers the command, then sends a named item to
 * `promote-named.ts` and no item to the picker in `promote-interactive.ts`.
 * The picker calls the named path, so the entry is the only module that
 * imports both.
 */
import type { Command } from "commander";
import { PreconditionError, ResultExitError } from "../errors";
import { pickUnavailableMessage } from "../pick";
import { runInteractivePromote } from "./promote-interactive";
import { promoteOne } from "./promote-named";
import type { PromoteOptions } from "./promote-named";

export function registerPromote(program: Command): void {
  program
    .command("promote [item]")
    .description(
      "push edits for an already-tracked data item into the data repo and bump the lock; with no item, pick from the promotable items interactively",
    )
    .option("--local", "promote a local-scope item")
    .option(
      "--stale-ok",
      "intentionally overwrite data-repo content newer than this project's lock",
    )
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .action(
      async (
        itemRef: string | undefined,
        opts: PromoteOptions,
        cmd: Command,
      ) => {
        if (itemRef === undefined) {
          await promoteWithoutItem(opts, cmd);
          return;
        }
        await promoteOne(itemRef, opts, cmd);
      },
    );
}

/** The no-item branch: the interactive picker over the tracked items. */
async function promoteWithoutItem(
  opts: PromoteOptions,
  cmd: Command,
): Promise<void> {
  // These flags are per-item judgments. `--stale-ok` authorizes overwriting
  // one item's newer upstream, and authorizing it for a pile of independent
  // marks would be consent to losses nobody enumerated.
  if (opts.staleOk) {
    throw new PreconditionError("promote --stale-ok requires an item");
  }
  // `--json` names a scripted caller, and a script cannot answer a prompt.
  if (opts.json) {
    throw new PreconditionError(
      "promote --json requires an item; the interactive picker needs a terminal",
      {
        hint: "pass an item ref (capshelf promote <kind>/<name>), or run capshelf promote without --json to pick interactively",
      },
    );
  }
  const summary = await runInteractivePromote({ promote: opts, cmd });
  if (summary.outcome === "unavailable") {
    throw new PreconditionError(
      `cannot pick interactively — ${pickUnavailableMessage(summary.reason)}`,
      {
        hint: "name the item instead: capshelf promote <kind>/<name>. Run capshelf status to see what changed.",
      },
    );
  }
  // Any failed item is a refusal the user needs a non-zero code for; each one
  // already printed its reason and its retry command.
  if (summary.outcome === "promoted" && summary.failed.length > 0) {
    throw new ResultExitError(3);
  }
}
