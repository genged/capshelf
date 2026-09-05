/**
 * The commands a status row can be resolved with, as the CLI would print
 * them. The web UI shows these beside each item, so every command must run
 * as printed from the project root: no placeholders, and every argument
 * quoted the way `shellArg` quotes it (`src/paths.ts`).
 */
import { capshelfCommandPrefix, shellArg } from "./paths";
import { allCanonicalItemRelPaths, isCopyDirectoryItemKind } from "./master";
import type { StatusRow } from "./status-core";

export interface StatusAction {
  /** The exact text to paste. */
  command: string;
  /** One sentence on what it does. */
  purpose: string;
}

export interface StatusActionOptions {
  /** The `--data` override this run used, repeated on every printed command. */
  dataOverride?: string;
  /** The resolved data repo, for the git commands a dirty shelf needs. */
  dataRepo?: string | null;
}

export function actionsForRow(
  row: StatusRow,
  options: StatusActionOptions = {},
): StatusAction[] {
  const prefix = capshelfCommandPrefix(options.dataOverride);
  const ref = shellArg(`${row.kind}/${row.name}`);
  const local = row.scope === "local" ? " --local" : "";
  const verb = (name: string, extra = ""): string =>
    `${prefix} ${name} ${ref}${local}${extra}`;
  const out: StatusAction[] = [];
  const add = (command: string, purpose: string): void => {
    if (out.some((action) => action.command === command)) return;
    out.push({ command, purpose });
  };
  const shelfEdit = (): void => {
    if (!options.dataRepo) return;
    const repo = shellArg(options.dataRepo);
    const paths = allCanonicalItemRelPaths(row.kind, row.name)
      .map(shellArg)
      .join(" ");
    add(
      `git -C ${repo} status --short -- ${paths}`,
      "Show the uncommitted edit in the data repo.",
    );
    add(
      `git -C ${repo} add -- ${paths} && git -C ${repo} commit`,
      "Commit the data repo edit, then run status again.",
    );
  };
  const system = row.source === "system";

  switch (row.state) {
    case "ok":
    case "source_filtered":
      break;
    case "update_available":
      add(
        verb("update"),
        system
          ? "Re-pin to the version bundled in this CLI."
          : "Take the shelf version.",
      );
      break;
    case "drifted_local":
      if (system) {
        add(
          verb("revert"),
          "Discard the edit and restore the bundled content.",
        );
        break;
      }
      add(verb("promote"), "Publish the edit to the shelf.");
      add(verb("keep-local"), "Keep the edit as intended divergence.");
      add(verb("revert"), "Discard the edit and restore the pin.");
      break;
    case "drifted_and_update":
      if (isCopyDirectoryItemKind(row.kind) && !system) {
        add(
          verb("update", " --merge"),
          "Merge the shelf change into the local edit.",
        );
      }
      add(
        verb("update"),
        "Take the shelf version. The command asks before it overwrites the edit.",
      );
      if (!system) {
        add(
          verb("promote", " --stale-ok"),
          "Publish the local edit over the newer shelf version.",
        );
        add(verb("keep-local"), "Keep the edit as intended divergence.");
      }
      add(verb("revert"), "Discard the edit and restore the pin.");
      break;
    case "missing_installed":
      add(verb("apply"), "Materialize the pinned content.");
      break;
    case "missing_output":
    case "output_drift":
      add(verb("apply"), "Rewrite the generated output from the pin.");
      break;
    case "missing_source_commit":
      add(
        `${prefix} data sync && ${verb("update")}`,
        "Fetch the shelf, then re-pin to a commit the clone can reach.",
      );
      break;
    case "missing_upstream":
      add(
        verb("rm"),
        system
          ? "Remove the item. This CLI no longer bundles it."
          : "Remove the item. The shelf no longer has it.",
      );
      break;
    case "upstream_dirty":
    case "source_dirty":
      shelfEdit();
      break;
    case "drifted_and_upstream_dirty":
      shelfEdit();
      add(verb("keep-local"), "Keep the edit as intended divergence.");
      add(verb("revert"), "Discard the edit and restore the pin.");
      break;
    case "source_dirty_and_output_drift":
      shelfEdit();
      add(verb("apply"), "Rewrite the generated output from the pin.");
      break;
    case "kept-local":
      add(
        verb("keep-local", " --unset"),
        "Resume reconciliation of this item.",
      );
      add(verb("revert"), "Restore the pin. The marker stays set.");
      break;
  }

  if (
    row.source === "data" &&
    (row.needsState === "update_available" || row.needsState === "unknown")
  ) {
    add(
      verb("update"),
      row.needsState === "unknown"
        ? "Record the requirements snapshot the lock does not have."
        : "Take the shelf's changed requirements declaration.",
    );
  }
  return out;
}
