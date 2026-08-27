/**
 * The interactive share path: `capshelf share` with no item.
 *
 * The picker lists every unmanaged config value as one row per legal `--pick`
 * path, the marks group into share invocations (`share-catalog.ts`), and each
 * item then runs through the same `shareFragment` a named share runs — which
 * re-reads the outputs, re-runs the extraction, and checks the data repo is
 * clean *after* the prompt, so a value that changed while the picker was open
 * fails its own row instead of being committed from a stale read.
 *
 * Best effort per item, like the `add` picker's install loop: a failure names
 * its reason and the command that retries that one item, and the other items
 * stay shared.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSystemItemName } from "../bundled";
import { resolveProjectDataRepo } from "../command-context";
import { askQuestion } from "../destructive-change";
import { PreconditionError } from "../errors";
import { reportItemFailure } from "./picker-report";
import { fragmentSourceCandidates } from "../fragments";
import { globalOpts } from "../global-options";
import { parseItemRef } from "../item-ref";
import { assertLockV4, dataKey, loadLocalLock, loadLock } from "../lock";
import type { Lock } from "../lock";
import { loadManifest } from "../manifest";
import type { FragmentItemKind } from "../master";
import { projectRoot, shellArg } from "../paths";
import { pickItems, pickTerminalUnavailable } from "../pick";
import { sanitizeDisplayText } from "../pick-core";
import type { PickUnavailableReason } from "../pick";
import {
  SHARE_KIND_ORDER,
  changedMarks,
  loadShareCatalog,
  plannedSharesFromMarks,
} from "../share-catalog";
import type { PlannedShare, SharePick } from "../share-catalog";
import { printShareUpstreamGuidance, shareFragment } from "./share";
import type { ShareOptions } from "./share";

export type InteractiveShareSummary =
  | { outcome: "unavailable"; reason: PickUnavailableReason }
  | { outcome: "cancelled" }
  | { outcome: "nothing-selected" }
  /** Every output is clean or absent; the picker never opened. */
  | { outcome: "empty" }
  | {
      outcome: "shared";
      shared: string[];
      skipped: string[];
      failed: string[];
    };

export async function runInteractiveShare(request: {
  share: ShareOptions;
  cmd: Command;
}): Promise<InteractiveShareSummary> {
  // Before any filesystem work: with no terminal there is nothing to offer,
  // and building the rows reads the outputs and the data repo.
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  // Fail a legacy lock before the prompt opens, not after a selection: the
  // refusal is the same one `shareFragment` makes, moved ahead of the
  // unbounded terminal hold.
  assertLockV4(projectLock, "capshelf share");
  const localLock = await loadLocalLock(project);
  const dataRepo = await resolveProjectDataRepo(project, manifest, request.cmd);
  const catalog = await loadShareCatalog({
    project,
    dataRepo,
    manifest,
    lock: projectLock,
  });

  if (catalog.rows.length === 0) {
    // An empty answer is a valid answer, like a `search` with no matches.
    console.log("nothing to share: no unmanaged values in");
    for (const output of catalog.outputs) {
      console.log(`  ${output.label}${output.exists ? "" : " (absent)"}`);
    }
    return { outcome: "empty" };
  }

  const picked = await pickItems({
    rows: catalog.rows,
    message: "Select config values to share",
    kindOrder: SHARE_KIND_ORDER,
    action: "share",
  });
  if (picked.kind === "unavailable") {
    return { outcome: "unavailable", reason: picked.reason };
  }
  if (picked.kind === "cancelled") return { outcome: "cancelled" };
  const marks = picked.refs
    .map((id) => catalog.picks.get(id))
    .filter((mark): mark is SharePick => mark !== undefined);
  if (marks.length === 0) return { outcome: "nothing-selected" };

  const shared: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const planned of plannedSharesFromMarks(marks)) {
    const name =
      planned.name ??
      (await promptItemName(planned.kind, {
        dataRepo,
        projectLock,
        localLock,
      }));
    if (name === null) {
      skipped.push(planned.kind);
      console.log(`- ${planned.kind} item skipped (no name)`);
      continue;
    }
    const ref = sanitizeDisplayText(`${planned.kind}/${name}`);
    try {
      // A server-derived name skipped the prompt, so it must pass the same
      // boundary a typed ref passes. The catalog disables such rows, but a
      // mark is data, and `shareFragment` takes the name without re-parsing —
      // an unvalidated name would create an item no named command can
      // address.
      if (planned.name !== null) {
        const refusal = itemNameRefusal(planned.kind, planned.name, {
          dataRepo,
          projectLock,
          localLock,
        });
        if (refusal !== null) throw new PreconditionError(refusal);
      }
      // Re-derive after the prompt, then act. The consent was for the values
      // the frame showed, and the prompt held the terminal for an unbounded
      // time — so first prove each marked value is still the one that was
      // offered, against a catalog rebuilt from fresh reads. A changed or
      // vanished value fails this row; it is not committed from a stale mark.
      const revalidated = await loadShareCatalog({
        project,
        dataRepo,
        manifest: await loadManifest(project),
        lock: await loadLock(project),
      });
      const changed = changedMarks(planned, revalidated.picks);
      if (changed.length > 0) {
        throw new PreconditionError(
          `${changed
            .map((mark) => mark.pick)
            .join(
              ", ",
            )} changed while the picker was open; nothing was committed for this item`,
        );
      }
      // `shareFragment` then reloads the manifest and lock, re-reads the
      // output, re-runs the extraction, and asserts the data repo clean,
      // which narrows the remaining window to the one every command has
      // between its own read and its own write.
      await shareFragment(
        planned.kind,
        name,
        "project",
        {
          ...(planned.picks.length > 0 && { pick: planned.picks }),
          ...(planned.target !== null && { target: planned.target }),
          ...(request.share.message !== undefined && {
            message: request.share.message,
          }),
          suppressGuidance: true,
          // The repository the catalog and the staleness check read. A
          // rebind while the picker was open must not move the destination.
          boundRepo: dataRepo,
        },
        request.cmd,
      );
      shared.push(ref);
    } catch (error) {
      failed.push(ref);
      reportItemFailure(
        ref,
        error,
        retryCommand(
          planned,
          name,
          request.share.message,
          globalOpts(request.cmd).data,
        ),
      );
      // The command's standing recovery note, surfaced here because the
      // interactive user never sees `share --help`: `shareFragment` commits
      // the fragment before persisting the manifest and lock, and a failure
      // between those two steps leaves an item the retry command would refuse
      // as already existing. `add` is the documented repair for that state.
      const addPrefix =
        globalOpts(request.cmd).data === undefined
          ? "capshelf"
          : `capshelf --data ${shellArg(globalOpts(request.cmd).data as string)}`;
      console.error(
        `  if the data-repo commit succeeded and only local tracking failed: ${addPrefix} add ${shellArg(ref)}`,
      );
    }
  }

  const parts = [`${shared.length} shared`];
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  console.log("");
  console.log(`${failed.length > 0 ? "!" : "✓"} ${parts.join(", ")}`);
  if (shared.length > 0) await printShareUpstreamGuidance(dataRepo);
  return { outcome: "shared", shared, skipped, failed };
}

/**
 * Ask for the new item's name, after the full-screen frame has closed (spec
 * decision 2). No default is offered: a wrong default one Enter away is worse
 * than a question. An empty answer skips the item; an unusable name prints its
 * reason and asks again — the same checks a named `share` would refuse on,
 * moved before anything is written.
 */
async function promptItemName(
  kind: FragmentItemKind,
  ctx: { dataRepo: string; projectLock: Lock; localLock: Lock },
): Promise<string | null> {
  for (;;) {
    const answer = (
      await askQuestion(`Name for the new ${kind} item (Enter to skip): `)
    ).trim();
    if (answer === "") return null;
    const refusal = itemNameRefusal(kind, answer, ctx);
    if (refusal === null) return answer;
    console.error(`✗ ${refusal}`);
  }
}

function itemNameRefusal(
  kind: FragmentItemKind,
  name: string,
  ctx: { dataRepo: string; projectLock: Lock; localLock: Lock },
): string | null {
  try {
    // Round trip, not just parse: the parser trims and splits, so a name with
    // surrounding whitespace or a slash parses into a *different* ref, and
    // the item it creates could never be addressed by the name it carries.
    const parsed = parseItemRef(`${kind}/${name}`);
    if (parsed.kind !== kind || parsed.name !== name) {
      return `"${name}" cannot be addressed as an item ref — pick another name`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (isSystemItemName(name)) {
    return `"${name}" is a system item name — pick another`;
  }
  for (const candidate of fragmentSourceCandidates(kind, name)) {
    if (existsSync(join(ctx.dataRepo, ...candidate.relPath.split("/")))) {
      return `data repo already has ${candidate.relPath} — pick another name`;
    }
  }
  const key = dataKey(kind, name);
  if (ctx.projectLock.items[key] || ctx.localLock.items[key]) {
    return `already tracked in this project: ${kind}/${name} — pick another name`;
  }
  return null;
}

function retryCommand(
  planned: PlannedShare,
  name: string,
  message: string | undefined,
  dataOverride: string | undefined,
): string {
  // Repeat `--data` only when this run used the override; see
  // `shareEquivalentCommand`.
  const prefix =
    dataOverride === undefined
      ? "capshelf"
      : `capshelf --data ${shellArg(dataOverride)}`;
  const parts = [`${prefix} share ${shellArg(`${planned.kind}/${name}`)}`];
  for (const pick of planned.picks) parts.push(`--pick ${shellArg(pick)}`);
  if (planned.target !== null) parts.push(`--target ${planned.target}`);
  if (message !== undefined) parts.push(`-m ${shellArg(message)}`);
  return parts.join(" ");
}
