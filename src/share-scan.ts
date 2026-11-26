/**
 * A row the named command would refuse stays visible and disabled with the
 * refusal as detail, because silence would let real content read as "nothing to
 * share".
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
import { holdsOnlyMountPoints } from "./mount-points";

export type ShareableItemKind = CopyDirectoryItemKind | "subagents";

export interface UntrackedItemCandidate {
  kind: ShareableItemKind;
  name: string;
  target: SubagentTarget | null;
  label: string;
  summary: string | null;
  refusal: string | null;
  digest: string | null;
}

export interface ItemSharePick {
  id: string;
  kind: ShareableItemKind;
  name: string;
  target: SubagentTarget | null;
  presentTargets: SubagentTarget[];
  digest: string;
}

export interface PlannedItemShare {
  kind: ShareableItemKind;
  name: string;
  target: SubagentTarget | null;
  marks: ItemSharePick[];
}

export interface ShareScanLocation {
  label: string;
  exists: boolean;
}

export interface UntrackedItemCatalog {
  rows: PickRow[];
  picks: Map<string, ItemSharePick>;
}

export interface UntrackedItemScan extends UntrackedItemCatalog {
  scanned: ShareScanLocation[];
}

/**
 * Labels and details go through `sanitizeDisplayText` because names come from
 * the user's filesystem, not a validated lock, and the frame is live.
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
 * Marking every shareable output drops `--target`, since the named command
 * shares every present output by default; a subset adds one flag per marked
 * output.
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
  const pending: Array<Promise<UntrackedItemCandidate>> = [];
  const scanned: ShareScanLocation[] = [];
  const tracked = (kind: ShareableItemKind, name: string): boolean =>
    [dataKey(kind, name), systemKey(kind, name)].some(
      (key) =>
        opts.projectLock.items[key] !== undefined ||
        opts.localLock.items[key] !== undefined,
    );
  // A plugin installs at the same folder as a skill, so a folder tracked as
  // `plugins/<n>` is the plugin's install, not an untracked skill.
  const trackedAtSkillTarget = (name: string): boolean =>
    (["skills", "plugins"] as const).some((kind) => tracked(kind, name));

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
        if (entry.isFile()) continue;
        // What `rm` leaves for an item with a mounted volume is not an item.
        if (
          entry.isDirectory() &&
          (await holdsOnlyMountPoints(join(dir, entry.name)))
        ) {
          continue;
        }
        names.add(entry.name);
      }
    }
    for (const name of [...names].sort()) {
      if (
        kind === "skills" ? trackedAtSkillTarget(name) : tracked(kind, name)
      ) {
        continue;
      }
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
    // Refuse per candidate, not all-or-nothing: one refused directory must not
    // hide the other untracked items.
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
    // Refuse an invalid source here, since an enabled row would fail every time
    // after selection; warnings wait until act time, where the named command
    // prints them.
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

function itemNameRefusal(kind: ShareableItemKind, name: string): string | null {
  if (!isAddressableItemName(kind, name)) {
    return "name cannot become an item name";
  }
  if (isSystemItemName(name)) return "reserved system item name";
  return null;
}
