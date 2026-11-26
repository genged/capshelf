/**
 * Each share re-reads its sources and checks the data repo is clean after the
 * prompt, so content changed while the picker was open fails its own row
 * instead of being committed from a stale read.
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
import { assertWritableLock, dataKey, loadLocalLock, loadLock } from "../lock";
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
  defaultCopyItemShareScope,
  shareCommandLine,
  shareCopyItem,
  shareFragment,
  shareSubagent,
} from "./share-named";
import type { ShareOptions } from "./share-named";

export type InteractiveShareSummary =
  | { outcome: "unavailable"; reason: PickUnavailableReason }
  | { outcome: "cancelled" }
  | { outcome: "nothing-selected" }
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
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  // Refuse a legacy lock before the prompt opens, not after a selection made
  // over an unbounded terminal hold.
  assertWritableLock(projectLock, "capshelf share");
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
    const scope =
      planned.kind === "subagents"
        ? "project"
        : (await defaultCopyItemShareScope(project, planned.kind, planned.name))
            .scope;
    const ref = sanitizeDisplayText(`${planned.kind}/${planned.name}`);
    const command = shareCommandLine({
      ref: `${planned.kind}/${planned.name}`,
      picks: [],
      target: planned.target,
      message: request.share.message,
      dataOverride,
    });
    try {
      await assertMarksFresh(planned, { project, dataRepo }, () => ref);
      const options: ShareOptions = {
        ...(request.share.message !== undefined && {
          message: request.share.message,
        }),
        suppressGuidance: true,
        // Pin the repo the catalog was read from so a `data bind` while the
        // picker is open cannot move the destination.
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
          null,
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
      // Validate server-derived names like typed refs: marks are data and
      // `shareFragment` doesn't re-parse, so a bad name would create an item no
      // command can address.
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
 * No default name is offered: a wrong default one Enter away is worse than
 * asking.
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
    // Require an exact round trip so parsing cannot change the name of the
    // item being created.
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
 * The prompt holds the terminal for unbounded time, so prove each mark still
 * matches what was offered, against fresh reads, before acting.
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
 * Surfaced here because interactive users never see `share --help`: a failure
 * after the data-repo commit but before manifest/lock persist leaves an item
 * retry refuses, and `add` repairs it.
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
