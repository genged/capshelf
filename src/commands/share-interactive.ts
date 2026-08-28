/**
 * The interactive share path: `capshelf share` with no item.
 *
 * The picker lists every unmanaged config value as one row per legal `--pick`
 * path, plus every untracked skill, Pi extension, and subagent output found
 * on disk (`share-scan.ts`). The marks group into share invocations
 * (`share-catalog.ts`, `share-scan.ts`), and each one then runs through the
 * same command a named share runs — which re-reads its sources and checks the
 * data repo is clean *after* the prompt, so content that changed while the
 * picker was open fails its own row instead of being committed from a stale
 * read.
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
import { isFragmentKindName } from "../master";
import type { FragmentItemKind } from "../master";
import { capshelfCommandPrefix, projectRoot, shellArg } from "../paths";
import { pickItems, pickTerminalUnavailable } from "../pick";
import { sanitizeDisplayText } from "../pick-core";
import type { PickUnavailableReason } from "../pick";
import {
  SHARE_KIND_ORDER,
  changedMarks,
  loadShareCatalog,
  plannedSharesFromMarks,
} from "../share-catalog";
import type { SharePick } from "../share-catalog";
import { plannedItemSharesFromMarks } from "../share-scan";
import type { ItemSharePick } from "../share-scan";
import {
  printShareUpstreamGuidance,
  shareCommandLine,
  shareCopyItem,
  shareFragment,
  shareSubagent,
} from "./share";
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
    localLock,
  });

  if (catalog.rows.length === 0) {
    // An empty answer is a valid answer, like a `search` with no matches.
    console.log("nothing to share: no unmanaged values or untracked items in");
    for (const location of [...catalog.outputs, ...catalog.scanned]) {
      console.log(`  ${location.label}${location.exists ? "" : " (absent)"}`);
    }
    return { outcome: "empty" };
  }

  const picked = await pickItems({
    rows: catalog.rows,
    message: "Select items and config values to share",
    kindOrder: SHARE_KIND_ORDER,
    action: "share",
  });
  if (picked.kind === "unavailable") {
    return { outcome: "unavailable", reason: picked.reason };
  }
  if (picked.kind === "cancelled") return { outcome: "cancelled" };
  const marks = picked.refs
    .map((id) => catalog.picks.get(id))
    .filter((mark): mark is SharePick | ItemSharePick => mark !== undefined);
  if (marks.length === 0) return { outcome: "nothing-selected" };
  const fragmentMarks = marks.filter(isFragmentSharePick);
  const itemMarks = marks.filter(
    (mark): mark is ItemSharePick => !isFragmentSharePick(mark),
  );

  const shared: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const dataOverride = globalOpts(request.cmd).data;
  for (const planned of plannedItemSharesFromMarks(itemMarks)) {
    // The named command's own default: skills adopt into local scope,
    // Pi extensions and subagents into project scope, so the printed
    // equivalent command needs no --to flag.
    const scope = planned.kind === "skills" ? "local" : "project";
    const ref = sanitizeDisplayText(`${planned.kind}/${planned.name}`);
    // The equivalent line after a success and the retry line after a failure
    // are the same string for an on-disk item, because the item's name was
    // never chosen in the frame.
    const command = shareCommandLine({
      ref: `${planned.kind}/${planned.name}`,
      picks: [],
      target: planned.target,
      message: request.share.message,
      dataOverride,
    });
    try {
      // The digest proves the directory or file is still the content the
      // frame offered.
      await assertMarksFresh(planned, { project, dataRepo }, () => ref);
      const options: ShareOptions = {
        ...(request.share.message !== undefined && {
          message: request.share.message,
        }),
        suppressGuidance: true,
        // The repository the catalog and the staleness check read. A rebind
        // while the picker was open must not move the destination.
        boundRepo: dataRepo,
      };
      if (planned.kind === "subagents") {
        await shareSubagent(
          planned.name,
          "project",
          {
            ...options,
            ...(planned.target !== null && { target: planned.target }),
          },
          request.cmd,
        );
      } else {
        await shareCopyItem(
          planned.kind,
          planned.name,
          scope,
          options,
          request.cmd,
        );
      }
      console.log(`  ${command}`);
      shared.push(ref);
    } catch (error) {
      failed.push(ref);
      reportItemFailure(ref, error, command);
      printAddRepairHint(ref, scope, dataOverride);
    }
  }
  for (const planned of plannedSharesFromMarks(fragmentMarks)) {
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
      await assertMarksFresh(planned, { project, dataRepo }, (changed) =>
        changed.map((mark) => mark.pick).join(", "),
      );
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
        shareCommandLine({
          ref: `${planned.kind}/${name}`,
          picks: planned.picks,
          target: planned.target,
          message: request.share.message,
          dataOverride,
        }),
      );
      printAddRepairHint(ref, "project", dataOverride);
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

function isFragmentSharePick(
  mark: SharePick | ItemSharePick,
): mark is SharePick {
  return isFragmentKindName(mark.kind);
}

/**
 * Re-derive after the prompt, then act. The consent was for the content the
 * frame showed, and the prompt held the terminal for an unbounded time — so
 * first prove each marked value is still the one that was offered, against a
 * catalog rebuilt from fresh reads. A changed or vanished mark fails its row;
 * it is not committed from a stale read.
 */
async function assertMarksFresh<M extends { id: string; digest: string }>(
  planned: { marks: M[] },
  ctx: { project: string; dataRepo: string },
  describeChanged: (changed: M[]) => string,
): Promise<void> {
  const revalidated = await loadShareCatalog({
    project: ctx.project,
    dataRepo: ctx.dataRepo,
    manifest: await loadManifest(ctx.project),
    lock: await loadLock(ctx.project),
    localLock: await loadLocalLock(ctx.project),
  });
  const changed = changedMarks(planned, revalidated.picks);
  if (changed.length > 0) {
    throw new PreconditionError(
      `${describeChanged(changed)} changed while the picker was open; nothing was committed for this item`,
    );
  }
}

/**
 * The command's standing recovery note, surfaced here because the interactive
 * user never sees `share --help`: every share path commits to the data repo
 * before persisting the manifest and lock, and a failure between those two
 * steps leaves an item the retry command would refuse as already existing.
 * `add` is the documented repair for that state.
 */
function printAddRepairHint(
  ref: string,
  scope: "project" | "local",
  dataOverride: string | undefined,
): void {
  console.error(
    `  if the data-repo commit succeeded and only local tracking failed: ${capshelfCommandPrefix(dataOverride)} add ${scope === "local" ? "--local " : ""}${shellArg(ref)}`,
  );
}
