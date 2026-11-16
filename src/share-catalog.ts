import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { isSystemItemName } from "./bundled";
import { isAddressableItemName } from "./item-ref";
import {
  configDetailLabel,
  dedupeAncestorPaths,
  isPickableKey,
  walkConfigPaths,
} from "./config-paths";
import {
  isPlainConfigObject,
  mergeConfigObjects,
  stableStringifyConfig,
} from "./config-values";
import type { ConfigObject } from "./config-values";
import { firstErrorLine } from "./errors";
import { mcpServerContainerKey, unmanagedRemainder } from "./fragment-pick";
import {
  allFragmentTargets,
  fragmentKindForTarget,
  fragmentOutputSpec,
  fragmentValuesForTarget,
} from "./fragments";
import type { FragmentSourceTarget, FragmentTarget } from "./fragments";
import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import { ITEM_KINDS } from "./master";
import type { FragmentItemKind } from "./master";
import { pickRowId, sanitizeDisplayText } from "./pick-core";
import type { PickKind, PickRow } from "./pick-core";
import { scanUntrackedShareItems } from "./share-scan";
import type { ItemSharePick, ShareScanLocation } from "./share-scan";

export const SHARE_KIND_ORDER: readonly PickKind[] = ITEM_KINDS;

export interface SharePick {
  id: string;
  kind: FragmentItemKind;
  sourceTarget: FragmentSourceTarget | null;
  pick: string;
  /**
   * The picker holds the terminal for an unbounded time, so the digest lets the
   * post-prompt check reject values a concurrent tool changed after the user
   * saw them.
   */
  digest: string;
}

export interface ShareOutputState {
  target: FragmentTarget;
  label: string;
  exists: boolean;
}

export interface ShareCatalog {
  rows: PickRow[];
  picks: Map<string, SharePick | ItemSharePick>;
  outputs: ShareOutputState[];
  scanned: ShareScanLocation[];
}

export interface ShareOutputRemainder extends ShareOutputState {
  remainder: ConfigObject;
}

export async function loadShareCatalog(opts: {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  localLock: Lock;
}): Promise<ShareCatalog> {
  const [scan, perTarget] = await Promise.all([
    scanUntrackedShareItems({
      project: opts.project,
      dataRepo: opts.dataRepo,
      manifest: opts.manifest,
      projectLock: opts.lock,
      localLock: opts.localLock,
    }),
    Promise.all(
      allFragmentTargets().map((target) => readOutputState(opts, target)),
    ),
  ]);
  const remainders = perTarget.map((result) => result.remainder);
  const brokenRows = perTarget.flatMap((result) =>
    result.brokenRow ? [result.brokenRow] : [],
  );
  const built = shareCatalogRows(remainders);
  return {
    rows: [...scan.rows, ...brokenRows, ...built.rows],
    picks: new Map<string, SharePick | ItemSharePick>([
      ...scan.picks,
      ...built.picks,
    ]),
    outputs: remainders.map(({ target, label, exists }) => ({
      target,
      label,
      exists,
    })),
    scanned: scan.scanned,
  };
}

/**
 * Read per output, not all-or-nothing: one broken output must not hide the
 * other outputs' shareable values, which a named share would still read fine.
 */
async function readOutputState(
  opts: {
    project: string;
    dataRepo: string;
    manifest: Manifest;
    lock: Lock;
  },
  target: FragmentTarget,
): Promise<{ remainder: ShareOutputRemainder; brokenRow?: PickRow }> {
  const spec = fragmentOutputSpec(target);
  const outputPath = spec.outputPath(opts.project);
  const label = relative(opts.project, outputPath);
  if (!existsSync(outputPath)) {
    return { remainder: { target, label, exists: false, remainder: {} } };
  }
  try {
    const current = spec.parse(await readFile(outputPath, "utf-8"), label);
    const managed = spec.normalizeOutput(
      mergeConfigObjects(
        (
          await fragmentValuesForTarget({
            dataRepo: opts.dataRepo,
            manifest: opts.manifest,
            lock: opts.lock,
            target,
          })
        ).map((fragment) => fragment.value),
      ),
    );
    return {
      remainder: {
        target,
        label,
        exists: true,
        remainder: unmanagedRemainder(current, managed),
      },
    };
  } catch (error) {
    return {
      remainder: { target, label, exists: true, remainder: {} },
      brokenRow: {
        ref: sanitizeDisplayText(label),
        id: JSON.stringify(["share-broken-output", target]),
        kind: fragmentKindForTarget(target),
        name: label,
        tags: [],
        installed: false,
        disabled: true,
        detail: sanitizeDisplayText(
          `cannot read this output: ${firstErrorLine(error)}`,
        ),
      },
    };
  }
}

function serverContainerKey(target: FragmentTarget): string | null {
  if (target === "claude-settings") return null;
  return mcpServerContainerKey(sourceTargetOf(target));
}

function sourceTargetOf(target: FragmentTarget): FragmentSourceTarget {
  return target === "codex-config" ? "codex" : "claude";
}

/**
 * Labels and details require terminal-control filtering because file content
 * can control the live terminal. Row ids keep raw paths so marks identify the
 * real values.
 */
export interface FragmentShareCatalog {
  rows: PickRow[];
  picks: Map<string, SharePick>;
}

export function shareCatalogRows(
  outputs: ShareOutputRemainder[],
): FragmentShareCatalog {
  const rows: PickRow[] = [];
  const picks = new Map<string, SharePick>();
  const add = (row: PickRow, pick: SharePick): void => {
    rows.push(row);
    picks.set(pickRowId(row), pick);
  };

  for (const output of outputs) {
    if (!output.exists) continue;
    const container = serverContainerKey(output.target);
    const kind = fragmentKindForTarget(output.target);
    const pathKind: FragmentItemKind | null = kind === "mcp" ? null : kind;

    if (pathKind !== null) {
      const walkable = { ...output.remainder };
      if (container !== null) delete walkable[container];
      // `$schema` is capshelf's own synthetic key, not project config; leaving
      // it in would make a schema-only file look shareable.
      if (output.target === "claude-settings") delete walkable.$schema;
      // A top-level key `--pick` cannot name gets a visible, unmarkable row;
      // dropping it would let unmanaged data read as "nothing to share".
      for (const key of Object.keys(walkable)) {
        if (isPickableKey(key)) continue;
        rows.push({
          ref: sanitizeDisplayText(key),
          id: JSON.stringify([
            "share-unpickable",
            pathKind,
            output.target,
            key,
          ]),
          kind: pathKind,
          name: key,
          tags: [],
          installed: false,
          disabled: true,
          detail: "no --pick syntax for this key · share it with --from",
        });
      }
      for (const node of walkConfigPaths(walkable)) {
        const id = shareRowId(pathKind, output.target, node.path);
        add(
          {
            ref: sanitizeDisplayText(node.path),
            id,
            kind: pathKind,
            name: node.path,
            tags: [],
            installed: false,
            detail: node.detail,
          },
          {
            id,
            kind: pathKind,
            sourceTarget: null,
            pick: node.path,
            digest: stableStringifyConfig(node.value),
          },
        );
      }
    }

    if (pathKind === null && container !== null) {
      // A non-server top-level key has no mcp row, so a disabled row names it;
      // silence would let the file read as "nothing to share".
      for (const key of Object.keys(output.remainder)) {
        if (key === container) continue;
        rows.push({
          ref: sanitizeDisplayText(key),
          id: JSON.stringify(["share-unpickable", "mcp", output.target, key]),
          kind: "mcp",
          name: key,
          tags: [],
          installed: false,
          disabled: true,
          detail: `${output.label} · mcp picks address servers only`,
        });
      }
    }

    if (container !== null) {
      const servers = output.remainder[container];
      if (servers === undefined) continue;
      // A scalar server table is unmanaged data, not an empty one; a disabled
      // row avoids it reading as "nothing to share".
      if (!isPlainConfigObject(servers)) {
        rows.push({
          ref: sanitizeDisplayText(container),
          id: JSON.stringify([
            "share-unpickable",
            "mcp",
            output.target,
            container,
          ]),
          kind: "mcp",
          name: container,
          tags: [],
          installed: false,
          disabled: true,
          detail: `${output.label} · not a server table`,
        });
        continue;
      }
      for (const [name, server] of Object.entries(servers)) {
        // Names that cannot round-trip through the item-ref grammar (or are
        // malformed) stay visible but unmarkable; the interactive loop
        // re-checks via `itemNameRefusal` so a forged mark cannot reach
        // `shareFragment`.
        const malformed = !isPlainConfigObject(server);
        // The ref grammar trims the whole ref, so a leading space after the
        // slash survives parsing; such names are shareable only via --from.
        const unshareable =
          malformed ||
          name.includes(".") ||
          name !== name.trim() ||
          !isAddressableItemName("mcp", name) ||
          isSystemItemName(name);
        const id = shareRowId("mcp", output.target, name);
        add(
          {
            ref: sanitizeDisplayText(name),
            id,
            kind: "mcp",
            name,
            tags: [],
            installed: false,
            ...(unshareable && { disabled: true }),
            detail: malformed
              ? `${output.label} · not a server definition (${configDetailLabel(server)})`
              : unshareable
                ? `${output.label} · name cannot become an item name`
                : `${output.label} · ${configDetailLabel(server)}`,
          },
          {
            id,
            kind: "mcp",
            sourceTarget: sourceTargetOf(output.target),
            pick: name,
            digest: stableStringifyConfig(server),
          },
        );
      }
    }
  }
  return { rows, picks };
}

function shareRowId(
  kind: FragmentItemKind,
  target: FragmentTarget,
  pick: string,
): string {
  // JSON, not a joined string: a config key can hold any character, so only an
  // escaping encoding keeps distinct picks from colliding.
  return JSON.stringify(["share", kind, target, pick]);
}

export interface PlannedShare {
  kind: FragmentItemKind;
  name: string | null;
  picks: string[];
  target: FragmentSourceTarget | null;
  /**
   * Includes ancestors and dropped descendants so the post-prompt staleness
   * check covers everything the user saw.
   */
  marks: SharePick[];
}

export function plannedSharesFromMarks(marks: SharePick[]): PlannedShare[] {
  const planned: PlannedShare[] = [];
  for (const kind of ["settings", "codex-config"] as const) {
    const kindMarks = marks.filter((mark) => mark.kind === kind);
    if (kindMarks.length === 0) continue;
    planned.push({
      kind,
      name: null,
      picks: dedupeAncestorPaths(kindMarks.map((mark) => mark.pick)),
      target: null,
      marks: kindMarks,
    });
  }

  const servers = new Map<string, SharePick[]>();
  for (const mark of marks) {
    if (mark.kind !== "mcp" || mark.sourceTarget === null) continue;
    servers.set(mark.pick, [...(servers.get(mark.pick) ?? []), mark]);
  }
  for (const [name, serverMarks] of servers) {
    const targets = new Set(serverMarks.map((mark) => mark.sourceTarget));
    planned.push({
      kind: "mcp",
      name,
      picks: [],
      target: targets.size === 1 ? [...targets][0]! : null,
      marks: serverMarks,
    });
  }
  return planned;
}

/**
 * A vanished row counts as changed: the value was removed or is now managed
 * elsewhere, so it is not what the user marked.
 */
export function changedMarks<M extends { id: string; digest: string }>(
  planned: { marks: M[] },
  fresh: ReadonlyMap<string, { digest: string }>,
): M[] {
  return planned.marks.filter(
    (mark) => fresh.get(mark.id)?.digest !== mark.digest,
  );
}
