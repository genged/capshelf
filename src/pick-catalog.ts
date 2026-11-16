/**
 * Read-only: malformed bundles or sidecars become warnings and visible rows;
 * errors are raised in runInteractiveAdd where state can change.
 */
import { isSystemItemName } from "./bundled";
import { listBundles, memberCountSummary } from "./bundles";
import type { Lock } from "./lock";
import { listMasterItems } from "./master";
import { loadDataItemMetadata } from "./metadata";
import { sanitizeDisplayText } from "./pick-core";
import type { PickRow } from "./pick-core";

export interface PickCatalog {
  rows: PickRow[];
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
    // Malformed bundles are listed (and refuse on install) because a silently
    // hidden bundle looks like one the shelf lacks.
    rows.push({
      ref: `bundles/${bundle.name}`,
      kind: "bundles",
      name: bundle.name,
      ...(bundle.description !== undefined && {
        description: bundle.description,
      }),
      tags: bundle.tags,
      // Bundles are manifest macros and never locked, so they are always
      // offered; install skips members already present.
      installed: false,
      detail: bundle.malformed ? "malformed" : memberCountSummary(bundle),
    });
  }

  // Items colliding with system item names are hidden because `add` refuses
  // them and installed detection would miss them (system copy is locked under
  // system/).
  const dataItems = (await listMasterItems(opts.dataRepo)).filter(
    (item) => !isSystemItemName(item.name),
  );
  const metas = await Promise.all(
    dataItems.map((item) => loadDataItemMetadata(item)),
  );
  dataItems.forEach((item, index) => {
    const meta = metas[index]!;
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
  });

  // Warnings echo untrusted data-repo text to a live terminal, so strip control
  // sequences to stop a shelf painting over or driving the terminal.
  return {
    rows,
    warnings: [...new Set(warnings)].map(sanitizeDisplayText),
  };
}

/**
 * Both locks count because `add` refuses an item installed at the other scope
 * as a cross-scope conflict.
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
