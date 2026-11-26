/**
 * Each marked item runs through `promoteOne`, which reloads project state and
 * re-runs its stale gate because the picker can wait unboundedly; a failure
 * doesn't stop the other items.
 */
import type { Command } from "commander";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { globalOpts } from "../global-options";
import { PreconditionError } from "../errors";
import { parseItemRef } from "../item-ref";
import { assertWritableLock } from "../lock";
import { reportItemFailure } from "./picker-report";
import { capshelfCommandPrefix, shellArg } from "../paths";
import { pickItems, pickTerminalUnavailable } from "../pick";
import type { PickUnavailableReason } from "../pick";
import { loadPromoteCatalog, unwatchedPathsForItem } from "../promote-catalog";
import { printShareUpstreamGuidance } from "./share-named";
import { promoteOne } from "./promote-named";
import type { PromoteOptions } from "./promote-named";
import {
  decodePromotePreviewGuard,
  encodePromotePreviewGuard,
  preparePromotePreview,
} from "../promote-preview";

export type InteractivePromoteSummary =
  | { outcome: "unavailable"; reason: PickUnavailableReason }
  | { outcome: "cancelled" }
  | { outcome: "nothing-selected" }
  | { outcome: "empty" }
  | { outcome: "promoted"; promoted: string[]; failed: string[] };

export async function runInteractivePromote(request: {
  promote: PromoteOptions;
  cmd: Command;
}): Promise<InteractivePromoteSummary> {
  // Checked before any filesystem work: with no terminal there is nothing to
  // offer, and building the rows reads the project, the outputs, and the data
  // repo.
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  const scope = request.promote.local
    ? ("local" as const)
    : ("project" as const);
  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd: request.cmd });
  const dataRepo = await resolveProjectDataRepo(project, manifest, request.cmd);
  const lock = assertWritableLock(
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
    preview: async (row) => {
      if (row.kind === "bundles") {
        throw new Error("the promote picker cannot contain bundle rows");
      }
      const preview = await preparePromotePreview({
        project,
        dataRepo,
        lock,
        scope,
        kind: row.kind,
        name: row.name,
      });
      return {
        text: preview.text,
        version: encodePromotePreviewGuard(preview.guard),
      };
    },
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
      // Re-check hidden paths after the prompt wait so a flag or ignore rule
      // set meanwhile fails the row instead of discarding a hidden edit.
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
      // promoteOne reloads project state so stale and clean-repo checks run
      // after the prompt; no message is asked because the per-item default says
      // more than one shared message.
      const result = await promoteOne(
        ref,
        {
          ...(request.promote.local && { local: true }),
          ...(request.promote.message !== undefined && {
            message: request.promote.message,
          }),
          suppressGuidance: true,
          // Pin the repo the catalog was read from so a rebind during the
          // picker cannot move the destination.
          boundRepo: dataRepo,
          ...(picked.previewVersions?.[ref] !== undefined && {
            previewGuard: decodePromotePreviewGuard(
              picked.previewVersions[ref],
            ),
          }),
        },
        request.cmd,
      );
      committed = committed || result.committed;
      promoted.push(ref);
    } catch (error) {
      failed.push(ref);
      // Report the full message: the stale refusal puts its resolution commands
      // after the first line.
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
