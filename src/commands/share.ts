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
      "resulting scope: local or project (default: local for skills and plugins that project Git does not track, project otherwise)",
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
    .option(
      "--adopt",
      "take ownership of a skill or plugin installed from a repository URL, or of a skill installed by skills.sh",
    )
    .option(
      "--yes",
      "authorize the commands a plugin runs in project scope without prompting",
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

async function shareWithoutItem(
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  // Compare with `!== undefined`, not truthiness: commander stores `--from ""`
  // as an empty string, which must still refuse.
  if (
    opts.from !== undefined ||
    opts.pick !== undefined ||
    opts.target !== undefined ||
    opts.to !== undefined ||
    opts.adopt !== undefined ||
    opts.yes !== undefined
  ) {
    throw new PreconditionError(
      "share --from, --pick, --target, --to, --adopt, and --yes require an item; run capshelf share with no flags to pick interactively",
    );
  }
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
  if (summary.outcome === "shared" && summary.failed.length > 0) {
    throw new ResultExitError(3);
  }
}

function collectPick(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}
