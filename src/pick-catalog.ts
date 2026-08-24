/**
 * Build the picker's rows from a data repo: every installable item plus every
 * bundle, each marked with whether the project already has it.
 *
 * This is the read half. It never installs and never refuses — a malformed
 * bundle or an unreadable sidecar degrades into a warning and a visible row,
 * the same way `ls` keeps a broken item on the shelf. `runInteractiveAdd` in
 * `commands/add.ts` is where a bad row becomes an error, because that is where
 * it can change something.
 */
import { isSystemItemName } from "./bundled";
import { listBundles, memberCountSummary } from "./bundles";
import { dataKey } from "./lock";
import type { Lock } from "./lock";
import { listMasterItems } from "./master";
import { loadDataItemMetadata } from "./metadata";
import { sanitizeDisplayText } from "./pick-core";
import type { PickRow } from "./pick-core";

export interface PickCatalog {
  rows: PickRow[];
  /** Bundle and metadata parse warnings, deduped, for the caller to print. */
  warnings: string[];
}

export interface LoadPickCatalogOptions {
  dataRepo: string;
  projectLock: Lock;
  localLock: Lock;
}

export async function loadPickCatalog(
  opts: LoadPickCatalogOptions,
): Promise<PickCatalog> {
  const installed = installedRefs(opts.projectLock, opts.localLock);
  const warnings: string[] = [];
  const rows: PickRow[] = [];

  const bundles = await listBundles(opts.dataRepo);
  warnings.push(...bundles.warnings);
  for (const bundle of bundles.bundles) {
    warnings.push(...bundle.warnings);
    // A malformed bundle is listed and refuses on install rather than being
    // hidden: a bundle that silently vanishes from the picker looks like a
    // bundle the shelf does not have.
    rows.push({
      ref: `bundles/${bundle.name}`,
      kind: "bundles",
      name: bundle.name,
      ...(bundle.description !== undefined && {
        description: bundle.description,
      }),
      tags: bundle.tags,
      // A bundle is a manifest macro, never locked, so "installed" is not a
      // state it can be in. It is offered every time; members already present
      // are skipped by the install path.
      installed: false,
      detail: bundle.malformed ? "malformed" : memberCountSummary(bundle),
    });
  }

  for (const item of await listMasterItems(opts.dataRepo)) {
    // A data repo may hold an item whose name collides with a system item's.
    // `add` refuses those, so offering one would be offering a row that can
    // only fail. Installed detection would not even mark it present, because
    // the system copy is locked under `system/`, not `data/`.
    if (isSystemItemName(item.name)) continue;
    const meta = await loadDataItemMetadata(item);
    warnings.push(...meta.warnings);
    const ref = `${item.kind}/${item.name}`;
    rows.push({
      ref,
      kind: item.kind,
      name: item.name,
      ...(meta.description !== undefined && { description: meta.description }),
      tags: meta.tags,
      installed: installed.has(ref),
    });
  }

  // Warnings quote data-repo text back to the user, and some of it verbatim:
  // an unrecognised `includes` key goes straight into the message. The picker
  // prints these to a live terminal, and `capshelf init` does it without being
  // asked, so a shelf could paint over the frame or drive the terminal. Row
  // descriptions are filtered for the same reason.
  return {
    rows,
    warnings: [...new Set(warnings)].map(sanitizeDisplayText),
  };
}

/**
 * Refs already owned by either scope. Both locks count: an item installed at
 * local scope must not be offered at project scope, because `add` refuses that
 * as a cross-scope conflict rather than installing it.
 */
function installedRefs(projectLock: Lock, localLock: Lock): Set<string> {
  const refs = new Set<string>();
  for (const lock of [projectLock, localLock]) {
    for (const key of Object.keys(lock.items)) {
      if (key.startsWith("data/")) refs.add(key.slice("data/".length));
    }
  }
  return refs;
}

/** True when the ref names a lock entry in either scope. */
export function isRefInstalled(
  refs: { kind: string; name: string },
  projectLock: Lock,
  localLock: Lock,
): boolean {
  const key = dataKey(refs.kind, refs.name);
  return (
    projectLock.items[key] !== undefined || localLock.items[key] !== undefined
  );
}
