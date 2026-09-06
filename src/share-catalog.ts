/**
 * The share picker's catalog: one row per unmanaged value that `--pick`
 * accepts today, built from the three generated outputs.
 *
 * The row set is the legal argument space made visible. A settings or
 * codex-config row is one config path in one output; an mcp row is one server
 * in one output file, so a server present in both outputs gets two rows and
 * `--target` becomes a property of which rows were marked instead of a flag to
 * remember (spec decision 1).
 *
 * `shareCatalogRows` is pure over parsed remainders, like `pick-core.ts`, so
 * the row split and the grouping are unit tests. `loadShareCatalog` is the
 * thin read half; it also folds in the untracked skills, Pi extensions, and
 * subagents that `share-scan.ts` finds on disk (picker spec, phase 3).
 */
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
import { sanitizeDisplayText } from "./pick-core";
import type { PickKind, PickRow } from "./pick-core";
import { scanUntrackedShareItems } from "./share-scan";
import type { ItemSharePick, ShareScanLocation } from "./share-scan";

/**
 * The tab order for the share catalog: the canonical kind order, items before
 * fragments, matching `add` and `status`. `ITEM_KINDS` itself, so a new kind
 * gets its tab without a second list to update.
 */
export const SHARE_KIND_ORDER: readonly PickKind[] = ITEM_KINDS;

/** What one marked row means to `share`. */
export interface SharePick {
  /** The row id, so a mark can be looked up in a freshly rebuilt catalog. */
  id: string;
  kind: FragmentItemKind;
  /**
   * Which runtime output the row came from. Meaningful for mcp, where it is
   * the `--target` value one marked row implies; null for the kinds with one
   * output.
   */
  sourceTarget: FragmentSourceTarget | null;
  /** The `--pick` path (settings, codex-config) or the bare server name (mcp). */
  pick: string;
  /**
   * Fingerprint of the value the row showed when it was offered. The picker
   * holds the terminal for an unbounded time, and the user consented to share
   * what they saw — not whatever a concurrent tool wrote into the output
   * while the frame was open. The interactive loop compares this against a
   * rebuilt catalog after the prompt and fails the row on a mismatch.
   */
  digest: string;
}

export interface ShareOutputState {
  target: FragmentTarget;
  /** Output path relative to the project, for row details and messages. */
  label: string;
  exists: boolean;
}

export interface ShareCatalog {
  rows: PickRow[];
  /** Row id -> what the mark means: a fragment value or an on-disk item. */
  picks: Map<string, SharePick | ItemSharePick>;
  outputs: ShareOutputState[];
  /** The item directories the scanner looked in, for the empty state. */
  scanned: ShareScanLocation[];
}

export interface ShareOutputRemainder extends ShareOutputState {
  /** Current output minus every managed fragment's contribution. */
  remainder: ConfigObject;
}

export async function loadShareCatalog(opts: {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  localLock: Lock;
}): Promise<ShareCatalog> {
  // The scan and the three outputs are independent reads; only the row order
  // below is fixed.
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
 * One output's unmanaged remainder. Per output, not all-or-nothing: an
 * unparseable `.codex/config.toml` or an unreachable source commit for one
 * target must not hide the other outputs' shareable values — a named share of
 * those values only reads its own target and would succeed. The broken output
 * gets a disabled diagnostic row instead.
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

/** The output key that holds the server table, per output target. */
function serverContainerKey(target: FragmentTarget): string | null {
  if (target === "claude-settings") return null;
  return mcpServerContainerKey(sourceTargetOf(target));
}

function sourceTargetOf(target: FragmentTarget): FragmentSourceTarget {
  return target === "codex-config" ? "codex" : "claude";
}

/**
 * Rows and their meanings from the three outputs' unmanaged remainders.
 *
 * `.claude/settings.json` walks into settings rows and `.codex/config.toml`
 * into codex-config rows, one per config path, parents included — the label is
 * the exact string `--pick` takes. The server tables walk into mcp rows
 * instead, one per server per output file, and the codex-config walk skips the
 * `mcp_servers` subtree so a server is never offered under two kinds.
 *
 * Labels and details pass through `sanitizeDisplayText`: these strings come
 * from files the user's tools wrote, and the frame is live. The row id keeps
 * the unsanitized path, so the mark still names the real value.
 */
export function shareCatalogRows(outputs: ShareOutputRemainder[]): {
  rows: PickRow[];
  picks: Map<string, SharePick>;
} {
  const rows: PickRow[] = [];
  const picks = new Map<string, SharePick>();
  const add = (row: PickRow, pick: SharePick): void => {
    rows.push(row);
    picks.set(row.id as string, pick);
  };

  for (const output of outputs) {
    if (!output.exists) continue;
    const container = serverContainerKey(output.target);
    // mcp rows are servers, not config paths, so the path walk skips them.
    const kind = fragmentKindForTarget(output.target);
    const pathKind: FragmentItemKind | null = kind === "mcp" ? null : kind;

    if (pathKind !== null) {
      const walkable = { ...output.remainder };
      if (container !== null) delete walkable[container];
      // `$schema` in `.claude/settings.json` is capshelf's own synthetic key
      // (`normalizeClaudeSettingsOutput` writes it), not project config. A
      // schema-only file must report "nothing to share", and a fragment
      // holding only the schema would contribute nothing.
      if (output.target === "claude-settings") delete walkable.$schema;
      // A top-level key `--pick` cannot name has no ancestor row to cover it.
      // Dropping it silently would let an output that still holds unmanaged
      // data read as "nothing to share", so it gets a visible, unmarkable
      // row instead. (`--from` can still share such a value.)
      for (const key of Object.keys(walkable)) {
        if (isPickableKey(key)) continue;
        rows.push({
          ref: sanitizeDisplayText(key),
          // A distinct id namespace: this row is never a pick, so its id
          // must not collide with any real pick path's.
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
      // `.mcp.json` rows are servers, so a non-server top-level key has no
      // representation at all. Silence would let a file holding one read as
      // "nothing to share"; a disabled row names it instead.
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
      // A scalar server table is unmanaged data the fragment validators would
      // reject, not an empty one. Silence here would let the output read as
      // "nothing to share"; a disabled row names the problem instead.
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
        // A server name with a dot has no `--pick` sugar (pick paths split on
        // dots), and one the item-ref grammar cannot round-trip — a slash, a
        // reserved system name, surrounding whitespace, an unsafe name —
        // cannot become the item `share` would create. The row stays visible
        // so the server does not look invisible to the tool; it just cannot
        // be marked. The interactive loop re-checks through the same boundary
        // a typed ref passes (`itemNameRefusal`), so a forged mark cannot
        // reach `shareFragment` either.
        // The share validators require a server definition to be an object;
        // a scalar entry would fail every time after selection.
        const malformed = !isPlainConfigObject(server);
        // The trim check is not part of the round-trip: the ref grammar trims
        // the whole ref, so a leading space after the slash survives parsing.
        // A name needing that quirk stays offerable only through --from.
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

/** One `capshelf share` invocation the marks add up to. */
export interface PlannedShare {
  kind: FragmentItemKind;
  /** Known for mcp (the server name); null means the picker must ask for one. */
  name: string | null;
  /** Explicit `--pick` arguments; empty for a default mcp share. */
  picks: string[];
  /** The `--target` flag; null means no flag (every marked output). */
  target: FragmentSourceTarget | null;
  /**
   * Every mark that formed this item, ancestors and dropped descendants both,
   * so the post-prompt staleness check covers everything the user saw.
   */
  marks: SharePick[];
}

/**
 * Group marked rows into the share invocations they mean (spec decision 2).
 *
 * mcp rows group by server name, and the marked outputs decide the `--target`
 * flag: both rows drop it, one row adds it. Settings rows group into one item,
 * codex-config rows into another; their names do not exist yet, so `name` is
 * null and the caller asks once per item, after the frame closes. Marked
 * ancestors silently drop their marked descendants — both marks name the same
 * fragment.
 */
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
 * The marks of one planned item whose values no longer match what the picker
 * showed, judged against a freshly rebuilt catalog. Covers fragment and
 * on-disk item marks alike: both carry an id and a content digest.
 *
 * A vanished row counts as changed: the value was removed, or another process
 * now manages it, and either way it is not what the user marked.
 */
export function changedMarks<M extends { id: string; digest: string }>(
  planned: { marks: M[] },
  fresh: ReadonlyMap<string, { digest: string }>,
): M[] {
  return planned.marks.filter(
    (mark) => fresh.get(mark.id)?.digest !== mark.digest,
  );
}
