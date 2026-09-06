/**
 * The share picker's scanner: one row per untracked skill, Pi extension, or
 * subagent output found on disk (picker spec, phase 3).
 *
 * `src/installed.ts` maps a tracked item to its paths; this module walks the
 * install locations the other way and reports what no lock entry claims. Each
 * row points at exactly the source a named `capshelf share <kind>/<name>`
 * would adopt (`findAdoptionSource`), so the printed equivalent command holds
 * by construction.
 *
 * A subagent row is one runtime output file, like an mcp share row is one
 * server in one output (spec decision 1): mark both files and the share needs
 * no `--target`, mark one and the command carries it. An item the named
 * command would refuse stays visible and disabled with the refusal as its
 * detail — silence would let real content read as "nothing to share".
 *
 * `untrackedItemRows` and `plannedItemSharesFromMarks` are pure, like
 * `share-catalog.ts`; `scanUntrackedShareItems` is the filesystem half.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isSystemItemName } from "./bundled";
import { hashNamedContents } from "./content-hash";
import { findAdoptionSource } from "./data-repo-adopt";
import { firstErrorLine } from "./errors";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import { lstatOrNull } from "./fs-utils";
import { isAddressableItemName } from "./item-ref";
import { dataKey, systemKey } from "./lock";
import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import {
  isMetadataSidecarPath,
  itemRepoRelPath,
  shaOfItemFiles,
  walkItemFiles,
} from "./master";
import type { CopyDirectoryItemKind } from "./master";
import { claudeDir, codexDir, codexProjectConfigDir, piDir } from "./paths";
import { sanitizeDisplayText } from "./pick-core";
import type { PickRow } from "./pick-core";
import { subagentCandidates, validateSubagentSource } from "./subagents";
import type { SubagentTarget } from "./subagents";

/** The kinds the scanner can offer: copy items and subagents. */
export type ShareableItemKind = CopyDirectoryItemKind | "subagents";

/** One on-disk candidate, before it becomes a row. */
export interface UntrackedItemCandidate {
  kind: ShareableItemKind;
  name: string;
  /** The runtime output this row is; null for copy-directory items. */
  target: SubagentTarget | null;
  /** The source path, project-relative, for the detail column. */
  label: string;
  /** Right-hand shape summary for a shareable candidate, e.g. `3 files`. */
  summary: string | null;
  /** Why the named share would refuse this candidate; null means shareable. */
  refusal: string | null;
  /** Content fingerprint for the post-prompt staleness check; null when refused. */
  digest: string | null;
}

/** What one marked item row means to `share`. */
export interface ItemSharePick {
  id: string;
  kind: ShareableItemKind;
  name: string;
  /** The output this row covers; null for copy-directory items. */
  target: SubagentTarget | null;
  /**
   * Every shareable output this subagent has, so the mark grouping can tell
   * "all of them" (no `--target`) from "one of them" (`--target <t>`).
   */
  presentTargets: SubagentTarget[];
  /** See `SharePick.digest`: the value the frame showed, not a later one. */
  digest: string;
}

/** One `capshelf share <kind>/<name>` invocation the item marks add up to. */
export interface PlannedItemShare {
  kind: ShareableItemKind;
  name: string;
  /** The `--target` flag; null means no flag. */
  target: SubagentTarget | null;
  marks: ItemSharePick[];
}

/** A directory the scanner looked in, for the empty-state report. */
export interface ShareScanLocation {
  label: string;
  exists: boolean;
}

/** The item rows of the share catalog and what each mark means. */
export interface UntrackedItemCatalog {
  rows: PickRow[];
  picks: Map<string, ItemSharePick>;
}

export interface UntrackedItemScan extends UntrackedItemCatalog {
  scanned: ShareScanLocation[];
}

/**
 * Rows and their meanings from scanned candidates.
 *
 * Labels and details pass through `sanitizeDisplayText`: the names come from
 * the user's filesystem, not from a validated lock, and the frame is live. A
 * refused candidate keeps its row, disabled, with the refusal as the detail.
 */
export function untrackedItemRows(
  candidates: UntrackedItemCandidate[],
): UntrackedItemCatalog {
  const rows: PickRow[] = [];
  const picks = new Map<string, ItemSharePick>();
  for (const candidate of candidates) {
    const id = JSON.stringify([
      "share-item",
      candidate.kind,
      candidate.target,
      candidate.name,
    ]);
    const detail =
      candidate.refusal !== null
        ? `${candidate.label} · ${candidate.refusal}`
        : candidate.summary !== null
          ? `${candidate.label} · ${candidate.summary}`
          : candidate.label;
    rows.push({
      ref: sanitizeDisplayText(candidate.name),
      id,
      kind: candidate.kind,
      name: candidate.name,
      tags: [],
      installed: false,
      ...(candidate.refusal !== null && { disabled: true }),
      detail: sanitizeDisplayText(detail),
    });
    if (candidate.refusal !== null || candidate.digest === null) continue;
    picks.set(id, {
      id,
      kind: candidate.kind,
      name: candidate.name,
      target: candidate.target,
      presentTargets: candidates.flatMap((sibling) =>
        sibling.kind === candidate.kind &&
        sibling.name === candidate.name &&
        sibling.refusal === null &&
        sibling.target !== null
          ? [sibling.target]
          : [],
      ),
      digest: candidate.digest,
    });
  }
  return { rows, picks };
}

/**
 * Group marked item rows into the share invocations they mean.
 *
 * A copy-directory mark is one item already. Subagent marks group by name,
 * and the marked outputs decide the `--target` flag exactly like mcp rows:
 * every shareable output marked drops it, a subset adds one flag per marked
 * output, because the named command shares every present output by default.
 */
export function plannedItemSharesFromMarks(
  marks: ItemSharePick[],
): PlannedItemShare[] {
  const planned: PlannedItemShare[] = [];
  for (const mark of marks) {
    if (mark.target !== null) continue;
    planned.push({
      kind: mark.kind,
      name: mark.name,
      target: null,
      marks: [mark],
    });
  }
  const subagents = new Map<string, ItemSharePick[]>();
  for (const mark of marks) {
    if (mark.target === null) continue;
    subagents.set(mark.name, [...(subagents.get(mark.name) ?? []), mark]);
  }
  for (const [name, nameMarks] of subagents) {
    const marked = new Set(nameMarks.map((mark) => mark.target));
    const present = nameMarks[0]?.presentTargets ?? [];
    if (present.every((target) => marked.has(target))) {
      planned.push({ kind: "subagents", name, target: null, marks: nameMarks });
      continue;
    }
    for (const mark of nameMarks) {
      planned.push({
        kind: "subagents",
        name,
        target: mark.target,
        marks: [mark],
      });
    }
  }
  return planned;
}

export async function scanUntrackedShareItems(opts: {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
}): Promise<UntrackedItemScan> {
  // Candidates are independent reads (a directory walk and hash each), so
  // they build concurrently; the pending order is the row order.
  const pending: Array<Promise<UntrackedItemCandidate>> = [];
  const scanned: ShareScanLocation[] = [];
  const tracked = (kind: ShareableItemKind, name: string): boolean =>
    [dataKey(kind, name), systemKey(kind, name)].some(
      (key) =>
        opts.projectLock.items[key] !== undefined ||
        opts.localLock.items[key] !== undefined,
    );

  const skillDirs =
    opts.manifest.installMode === "claude-only"
      ? [join(claudeDir(opts.project), "skills")]
      : [
          join(codexDir(opts.project), "skills"),
          join(claudeDir(opts.project), "skills"),
        ];
  for (const [kind, dirs] of [
    ["skills", skillDirs],
    ["pi-extensions", [join(piDir(opts.project), "extensions")]],
  ] as const) {
    const names = new Set<string>();
    for (const dir of dirs) {
      scanned.push({
        label: relative(opts.project, dir),
        exists: existsSync(dir),
      });
      if (!existsSync(dir)) continue;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        // A plain file here is not item material; a directory or a symlink
        // is, and the named command's own checks decide what to say about it.
        if (entry.isFile()) continue;
        names.add(entry.name);
      }
    }
    for (const name of [...names].sort()) {
      if (tracked(kind, name)) continue;
      pending.push(copyItemCandidate(opts, kind, name));
    }
  }

  const agentDirs: Array<{
    target: SubagentTarget;
    dir: string;
    suffix: string;
  }> = [
    {
      target: "claude",
      dir: join(claudeDir(opts.project), "agents"),
      suffix: ".md",
    },
    {
      target: "codex",
      dir: join(codexProjectConfigDir(opts.project), "agents"),
      suffix: ".toml",
    },
  ];
  for (const { target, dir, suffix } of agentDirs) {
    scanned.push({
      label: relative(opts.project, dir),
      exists: existsSync(dir),
    });
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(suffix)) continue;
      const name = entry.name.slice(0, -suffix.length);
      if (name === "" || tracked("subagents", name)) continue;
      pending.push(
        subagentCandidate(opts, name, target, join(dir, entry.name)),
      );
    }
  }

  return { ...untrackedItemRows(await Promise.all(pending)), scanned };
}

async function copyItemCandidate(
  opts: { project: string; dataRepo: string; manifest: Manifest },
  kind: CopyDirectoryItemKind,
  name: string,
): Promise<UntrackedItemCandidate> {
  let label = name;
  const refused = (refusal: string): UntrackedItemCandidate => ({
    kind,
    name,
    target: null,
    label,
    summary: null,
    refusal,
    digest: null,
  });
  const nameRefusal = itemNameRefusal(kind, name);
  if (nameRefusal !== null) return refused(nameRefusal);
  const repoRelPath = itemRepoRelPath(kind, name);
  if (existsSync(join(opts.dataRepo, ...repoRelPath.split("/")))) {
    return refused(`already on the shelf as ${repoRelPath}`);
  }
  try {
    if (kind === "skills") {
      const external = await findSkillsShSkill(opts.project, name);
      if (external) return refused(skillsShConflictMessage(external));
    }
    const source = findAdoptionSource(
      opts.project,
      kind,
      name,
      opts.manifest.installMode,
    );
    if (source === null) {
      // A dangling compatibility alias: nothing a share could read.
      return refused("no local copy to adopt");
    }
    label = relative(opts.project, source.path);
    const files = (await walkItemFiles(source.path)).filter(
      (rel) => !isMetadataSidecarPath(rel),
    );
    return {
      kind,
      name,
      target: null,
      label,
      summary: `${files.length} file${files.length === 1 ? "" : "s"}`,
      refusal: null,
      digest: await shaOfItemFiles(source.path, files),
    };
  } catch (error) {
    // Per candidate, not all-or-nothing: one refused directory must not hide
    // the other untracked items (share-catalog.ts follows the same rule).
    return refused(firstErrorLine(error));
  }
}

async function subagentCandidate(
  opts: { project: string; dataRepo: string },
  name: string,
  target: SubagentTarget,
  outputPath: string,
): Promise<UntrackedItemCandidate> {
  const label = relative(opts.project, outputPath);
  const base: Omit<UntrackedItemCandidate, "refusal" | "digest"> = {
    kind: "subagents",
    name,
    target,
    label,
    summary: null,
  };
  const refused = (refusal: string): UntrackedItemCandidate => ({
    ...base,
    refusal,
    digest: null,
  });
  const nameRefusal = itemNameRefusal("subagents", name);
  if (nameRefusal !== null) return refused(nameRefusal);
  for (const candidate of subagentCandidates(name)) {
    if (existsSync(join(opts.dataRepo, ...candidate.relPath.split("/")))) {
      return refused(`already on the shelf as ${candidate.relPath}`);
    }
  }
  const stat = lstatOrNull(outputPath);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    return refused("not a regular file");
  }
  try {
    const raw = await readFile(outputPath, "utf-8");
    // The named share would refuse an invalid source outright; an enabled row
    // for one would fail every time after selection. Warnings stay for act
    // time, where the named command prints them too.
    validateSubagentSource(target, name, raw);
    return {
      ...base,
      refusal: null,
      digest: hashNamedContents([{ name: label, content: raw }]),
    };
  } catch (error) {
    return refused(firstErrorLine(error));
  }
}

/** Why this on-disk name cannot become an item name, or null. */
function itemNameRefusal(kind: ShareableItemKind, name: string): string | null {
  if (!isAddressableItemName(kind, name)) {
    return "name cannot become an item name";
  }
  if (isSystemItemName(name)) return "reserved system item name";
  return null;
}
