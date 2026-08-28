/**
 * The interactive promote path: `capshelf promote` with no item.
 *
 * The picker lists every tracked data item in the selected scope. A row whose
 * status state has something to promote is markable; every other row stays
 * visible, struck through, with its reason in the detail column
 * (`promote-catalog.ts`). Each marked item then runs through the same
 * `promoteOne` a named promote runs, which reloads the project state and
 * re-runs its stale gate after the unbounded prompt wait.
 *
 * Best effort per item, like the `add` picker's install loop: a failure names
 * its reason and the command that retries that one item, and the other items
 * stay promoted.
 */
import type { Command } from "commander";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { globalOpts } from "../global-options";
import { PreconditionError } from "../errors";
import { parseItemRef } from "../item-ref";
import { assertLockV4 } from "../lock";
import { reportItemFailure } from "./picker-report";
import { capshelfCommandPrefix, shellArg } from "../paths";
import { pickItems, pickTerminalUnavailable } from "../pick";
import type { PickUnavailableReason } from "../pick";
import { loadPromoteCatalog, unwatchedPathsForItem } from "../promote-catalog";
import { printShareUpstreamGuidance } from "./share";
import { promoteOne } from "./promote";
import type { PromoteOptions } from "./promote";

export type InteractivePromoteSummary =
  | { outcome: "unavailable"; reason: PickUnavailableReason }
  | { outcome: "cancelled" }
  | { outcome: "nothing-selected" }
  /** The scope tracks no data items; the picker never opened. */
  | { outcome: "empty" }
  | { outcome: "promoted"; promoted: string[]; failed: string[] };

export async function runInteractivePromote(request: {
  promote: PromoteOptions;
  cmd: Command;
}): Promise<InteractivePromoteSummary> {
  // Before any filesystem work: with no terminal there is nothing to offer,
  // and building the rows reads the project, the outputs, and the data repo.
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  const scope = request.promote.local
    ? ("local" as const)
    : ("project" as const);
  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd: request.cmd });
  const dataRepo = await resolveProjectDataRepo(project, manifest, request.cmd);
  const lock = assertLockV4(
    scope === "local" ? localLock : projectLock,
    "capshelf promote",
  );
  const catalog = await loadPromoteCatalog({
    project,
    dataRepo,
    manifest,
    lock,
    scope,
  });

  if (catalog.rows.length === 0) {
    // An empty answer is a valid answer, like a `search` with no matches.
    console.log(
      scope === "local"
        ? "nothing to promote: no local-scope data items tracked in this project"
        : "nothing to promote: no data items tracked in this project",
    );
    return { outcome: "empty" };
  }

  const picked = await pickItems({
    rows: catalog.rows,
    message: "Select items to promote",
    action: "promote",
  });
  if (picked.kind === "unavailable") {
    return { outcome: "unavailable", reason: picked.reason };
  }
  if (picked.kind === "cancelled") return { outcome: "cancelled" };
  if (picked.refs.length === 0) return { outcome: "nothing-selected" };

  const promoted: string[] = [];
  const failed: string[] = [];
  let committed = false;
  for (const ref of picked.refs) {
    try {
      // The catalog's git-hidden check went stale during the unbounded prompt
      // wait. Re-ask for this one item before acting: a flag or an ignore
      // rule set while the picker was open must fail the row, not let the
      // promote silently discard the hidden edit.
      const parsed = parseItemRef(ref);
      if (parsed.kind !== undefined) {
        const unwatched = await unwatchedPathsForItem(
          dataRepo,
          parsed.kind,
          parsed.name,
        );
        if (unwatched.length > 0) {
          throw new PreconditionError(
            `git is not watching ${unwatched.join(", ")}; nothing was promoted for this item`,
          );
        }
      }
      // Each item is one full named promote: `promoteOne` reloads the project
      // state, so the stale gate and the clean-repo checks run after the
      // prompt, not before it. The commit message is `-m` when given and the
      // per-item default otherwise; the picker asks for none, because one
      // message across several commits says less than the default does.
      const result = await promoteOne(
        ref,
        {
          ...(request.promote.local && { local: true }),
          ...(request.promote.message !== undefined && {
            message: request.promote.message,
          }),
          suppressGuidance: true,
          // The repository the catalog was read from. A rebind while the
          // picker was open must not move the destination.
          boundRepo: dataRepo,
        },
        request.cmd,
      );
      committed = committed || result.committed;
      promoted.push(ref);
    } catch (error) {
      failed.push(ref);
      // The full message, not its first line: promote's stale refusal carries
      // its resolution commands (`update --merge`, `--stale-ok`) in the lines
      // after the first, and a `drifted_and_update` row is offered exactly so
      // that guidance reaches the user.
      const dataOverride = globalOpts(request.cmd).data;
      reportItemFailure(
        ref,
        error,
        `${capshelfCommandPrefix(dataOverride)} promote ${shellArg(ref)}${request.promote.local ? " --local" : ""}${
          request.promote.message !== undefined
            ? ` -m ${shellArg(request.promote.message)}`
            : ""
        }`,
      );
    }
  }

  const parts = [`${promoted.length} promoted`];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  console.log("");
  console.log(`${failed.length > 0 ? "!" : "✓"} ${parts.join(", ")}`);
  if (committed) await printShareUpstreamGuidance(dataRepo);
  return { outcome: "promoted", promoted, failed };
}
