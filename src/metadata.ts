/**
 * Item metadata: the optional `.capshelf.yml` sidecar (all kinds) and SKILL.md
 * YAML frontmatter (skills only). Metadata is catalog data for *choosers* —
 * the sidecar is never hashed or materialized (see master.ts
 * `isMetadataSidecarPath`), while frontmatter stays item content because it is
 * delivered to Claude.
 *
 * Parsing is warn-and-degrade: a malformed sidecar or frontmatter block never
 * fails `ls`/`show`/`search`/`add` — fields are salvaged per-field and
 * per-entry, warnings collect on the returned metadata, and commands print
 * them to stderr via `printMetadataWarnings`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./fs-utils";
import { join } from "node:path";
import { YAMLParseError, parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SystemItem } from "./bundled";
import { isItemKind } from "./master";
import type { MasterItem } from "./master";

// Defined in identity.ts (a leaf) to break the master.ts <-> metadata.ts
// cycle; re-exported here so existing `from "./metadata"` importers still work.
import { METADATA_SIDECAR } from "./identity";
export { METADATA_SIDECAR };

const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_FRONTMATTER_BYTES = 16 * 1024;

export interface ItemMetadata {
  description?: string;
  tags: string[];
  requires: string[];
  conflictsWith: string[];
  /** Parse/salvage warnings, already labeled with the item ref. */
  warnings: string[];
}

export function emptyMetadata(warnings: string[] = []): ItemMetadata {
  return { tags: [], requires: [], conflictsWith: [], warnings };
}

const stringField = z.string();
const listField = z.array(z.unknown());

/**
 * Parse a `.capshelf.yml` sidecar. Unknown fields are ignored for forward
 * compatibility; invalid fields and invalid list entries are dropped with a
 * warning while the rest of the document is kept.
 */
export function parseSidecar(
  text: string,
  itemLabel: string,
  expectedName?: string,
): ItemMetadata {
  if (Buffer.byteLength(text, "utf-8") > MAX_SIDECAR_BYTES) {
    return emptyMetadata([
      `${itemLabel}: ${METADATA_SIDECAR} is larger than 64 KiB — metadata ignored`,
    ]);
  }
  const doc = parseYamlDocument(text, itemLabel, METADATA_SIDECAR);
  if (!doc.ok) return emptyMetadata(doc.warnings);
  if (doc.value === null || doc.value === undefined) return emptyMetadata();
  if (typeof doc.value !== "object" || Array.isArray(doc.value)) {
    return emptyMetadata([
      `${itemLabel}: invalid ${METADATA_SIDECAR} (expected a mapping) — metadata ignored`,
    ]);
  }

  const raw = doc.value as Record<string, unknown>;
  const meta = emptyMetadata();
  readDescription(raw, meta, itemLabel, METADATA_SIDECAR);
  checkNameField(raw, meta, itemLabel, METADATA_SIDECAR, expectedName);
  readTags(raw, meta, itemLabel);
  meta.requires = readRefList(raw, "requires", meta, itemLabel);
  meta.conflictsWith = readRefList(raw, "conflicts-with", meta, itemLabel);
  return meta;
}

export interface FrontmatterBlock {
  /** Frontmatter YAML text, or null when the file has none. */
  text: string | null;
  /** True when an opening `---` exists but no closing `---` was found. */
  malformed: boolean;
}

/** Extract the leading `---` YAML frontmatter block from SKILL.md text. */
export function extractFrontmatter(skillMd: string): FrontmatterBlock {
  // A UTF-8 BOM before the opening "---" must not hide the frontmatter, and
  // CRLF line endings must not leak a trailing \r into parsed values.
  const source = skillMd.charCodeAt(0) === 0xfeff ? skillMd.slice(1) : skillMd;
  const lines = source
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if ((lines[0] ?? "").trimEnd() !== "---") {
    return { text: null, malformed: false };
  }
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd() === "---") {
      return { text: lines.slice(1, i).join("\n"), malformed: false };
    }
  }
  return { text: null, malformed: true };
}

/**
 * Parse SKILL.md frontmatter for the catalog. Only `description` (and a
 * `name` sanity check) are read — tags/requires/conflicts-with live in the
 * sidecar only.
 */
export function parseFrontmatter(
  text: string,
  itemLabel: string,
  expectedName?: string,
): ItemMetadata {
  if (Buffer.byteLength(text, "utf-8") > MAX_FRONTMATTER_BYTES) {
    return emptyMetadata([
      `${itemLabel}: SKILL.md frontmatter is larger than 16 KiB — metadata ignored`,
    ]);
  }
  const doc = parseYamlDocument(text, itemLabel, "SKILL.md frontmatter");
  if (!doc.ok) return emptyMetadata(doc.warnings);
  if (
    doc.value === null ||
    doc.value === undefined ||
    typeof doc.value !== "object" ||
    Array.isArray(doc.value)
  ) {
    return emptyMetadata();
  }
  const raw = doc.value as Record<string, unknown>;
  const meta = emptyMetadata();
  readDescription(raw, meta, itemLabel, "SKILL.md frontmatter");
  checkNameField(raw, meta, itemLabel, "SKILL.md frontmatter", expectedName);
  return meta;
}

/** Per-field merge: sidecar wins; description falls back to frontmatter. */
export function mergeItemMetadata(
  sidecar: ItemMetadata,
  frontmatter: ItemMetadata,
): ItemMetadata {
  return {
    ...(sidecar.description !== undefined ||
    frontmatter.description !== undefined
      ? { description: sidecar.description ?? frontmatter.description }
      : {}),
    tags: sidecar.tags,
    requires: sidecar.requires,
    conflictsWith: sidecar.conflictsWith,
    warnings: [...sidecar.warnings, ...frontmatter.warnings],
  };
}

/**
 * Load catalog metadata for a data item from the data repo working tree:
 * the item's root `.capshelf.yml` plus, for skills, SKILL.md frontmatter.
 */
export async function loadDataItemMetadata(
  item: Pick<MasterItem, "kind" | "name" | "path">,
): Promise<ItemMetadata> {
  const label = `${item.kind}/${item.name}`;
  let sidecar = emptyMetadata();
  const sidecarPath = join(item.path, METADATA_SIDECAR);
  if (existsSync(sidecarPath)) {
    sidecar = parseSidecar(
      await readFile(sidecarPath, "utf-8"),
      label,
      item.name,
    );
  }
  if (item.kind !== "skills") return sidecar;
  return mergeItemMetadata(
    sidecar,
    await skillFrontmatterMetadata(
      join(item.path, "SKILL.md"),
      label,
      item.name,
    ),
  );
}

/** Load catalog metadata for a bundled system item (SKILL.md frontmatter). */
export function loadSystemItemMetadata(item: SystemItem): ItemMetadata {
  const label = `${item.kind}/${item.name}`;
  const skillMd = item.files.find((f) => f.relPath === "SKILL.md");
  if (!skillMd) return emptyMetadata();
  return frontmatterMetadataFromText(skillMd.content, label, item.name);
}

/** Print metadata warnings to stderr, deduplicated. */
export function printMetadataWarnings(meta: ItemMetadata): void {
  for (const warning of new Set(meta.warnings)) {
    console.error(`⚠ ${warning}`);
  }
}

/** Collapse a description to one line and truncate it for listings. */
export function truncatedDescription(description: string, max = 60): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  // Truncate by code points, not UTF-16 code units — a code-unit slice can
  // split a surrogate pair (e.g. an emoji) and emit broken UTF-8 in listings.
  const points = [...collapsed];
  if (points.length <= max) return collapsed;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}

/**
 * Listing-line suffix: `  <truncated description>  #tag1 #tag2`. Empty when
 * the item has no metadata so metadata-less rows stay byte-identical.
 */
export function metadataLineSuffix(meta: ItemMetadata): string {
  const parts: string[] = [];
  if (meta.description) parts.push(truncatedDescription(meta.description));
  if (meta.tags.length > 0) {
    parts.push(meta.tags.map((tag) => `#${tag}`).join(" "));
  }
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

/**
 * `--tag` filtering: every requested tag must be present (AND, narrowing),
 * compared case-insensitively. Items without metadata never match a filter.
 */
export function matchesTagFilter(
  meta: ItemMetadata | null,
  tags: string[],
): boolean {
  if (tags.length === 0) return true;
  if (!meta) return false;
  const have = new Set(meta.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => have.has(tag.toLowerCase()));
}

/**
 * Read an item directory's root sidecar bytes, or null when absent. Used by
 * promote/share to cache the data-repo sidecar before a directory replace
 * removes it (projects never receive the sidecar, so a naive replace would
 * silently delete upstream metadata).
 */
export async function readSidecarBytes(
  itemDir: string,
): Promise<Buffer | null> {
  const path = join(itemDir, METADATA_SIDECAR);
  if (!existsSync(path)) return null;
  return await readFile(path);
}

/**
 * Restore a cached sidecar after a directory replace, unless the replaced
 * content supplied its own (the project copy's sidecar wins). Returns true
 * when the cached bytes were written back.
 */
export async function restoreSidecarBytes(
  itemDir: string,
  cached: Buffer | null,
): Promise<boolean> {
  if (cached === null) return false;
  const path = join(itemDir, METADATA_SIDECAR);
  if (existsSync(path)) return false;
  await atomicWriteFile(path, cached);
  return true;
}

async function skillFrontmatterMetadata(
  skillMdPath: string,
  itemLabel: string,
  expectedName: string,
): Promise<ItemMetadata> {
  if (!existsSync(skillMdPath)) return emptyMetadata();
  return frontmatterMetadataFromText(
    await readFile(skillMdPath, "utf-8"),
    itemLabel,
    expectedName,
  );
}

function frontmatterMetadataFromText(
  skillMd: string,
  itemLabel: string,
  expectedName: string,
): ItemMetadata {
  const block = extractFrontmatter(skillMd);
  if (block.malformed) {
    return emptyMetadata([
      `${itemLabel}: SKILL.md frontmatter has no closing "---" — metadata ignored`,
    ]);
  }
  if (block.text === null) return emptyMetadata();
  return parseFrontmatter(block.text, itemLabel, expectedName);
}

type ParsedYaml =
  | { ok: true; value: unknown }
  | { ok: false; warnings: string[] };

function parseYamlDocument(
  text: string,
  itemLabel: string,
  sourceLabel: string,
): ParsedYaml {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch (err) {
    const detail =
      err instanceof YAMLParseError && err.linePos?.[0]
        ? `line ${err.linePos[0].line}: ${firstLine(err.message)}`
        : firstLine(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      warnings: [
        `${itemLabel}: invalid ${sourceLabel} (${detail}) — metadata ignored`,
      ],
    };
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function readDescription(
  raw: Record<string, unknown>,
  meta: ItemMetadata,
  itemLabel: string,
  sourceLabel: string,
): void {
  if (!("description" in raw)) return;
  const parsed = stringField.safeParse(raw.description);
  if (parsed.success) {
    meta.description = parsed.data;
    return;
  }
  meta.warnings.push(
    `${itemLabel}: ${sourceLabel} "description" must be a string — field ignored`,
  );
}

function checkNameField(
  raw: Record<string, unknown>,
  meta: ItemMetadata,
  itemLabel: string,
  sourceLabel: string,
  expectedName?: string,
): void {
  if (expectedName === undefined || !("name" in raw)) return;
  const parsed = stringField.safeParse(raw.name);
  if (parsed.success && parsed.data !== expectedName) {
    meta.warnings.push(
      `${itemLabel}: ${sourceLabel} "name" is "${parsed.data}" but the directory name "${expectedName}" is canonical — name ignored`,
    );
  }
}

function readTags(
  raw: Record<string, unknown>,
  meta: ItemMetadata,
  itemLabel: string,
): void {
  if (!("tags" in raw)) return;
  const list = listField.safeParse(raw.tags);
  if (!list.success) {
    meta.warnings.push(
      `${itemLabel}: ${METADATA_SIDECAR} "tags" must be a list of strings — field ignored`,
    );
    return;
  }
  for (const entry of list.data) {
    const tag = stringField.safeParse(entry);
    if (tag.success && tag.data.trim().length > 0) {
      meta.tags.push(tag.data.trim());
    } else {
      meta.warnings.push(
        `${itemLabel}: ${METADATA_SIDECAR} tag ${JSON.stringify(entry)} is not a non-empty string — entry ignored`,
      );
    }
  }
}

function readRefList(
  raw: Record<string, unknown>,
  field: "requires" | "conflicts-with",
  meta: ItemMetadata,
  itemLabel: string,
): string[] {
  if (!(field in raw)) return [];
  const list = listField.safeParse(raw[field]);
  if (!list.success) {
    meta.warnings.push(
      `${itemLabel}: ${METADATA_SIDECAR} "${field}" must be a list of <kind>/<name> refs — field ignored`,
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of list.data) {
    const ref = stringField.safeParse(entry);
    const parsed = ref.success ? parseQualifiedRef(ref.data) : null;
    if (parsed) {
      out.push(parsed);
    } else {
      meta.warnings.push(
        `${itemLabel}: ${METADATA_SIDECAR} "${field}" entry ${JSON.stringify(entry)} is not a kind-qualified <kind>/<name> ref — entry ignored`,
      );
    }
  }
  return out;
}

function parseQualifiedRef(ref: string): string | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const kind = ref.slice(0, slash);
  const name = ref.slice(slash + 1);
  if (!isItemKind(kind) || name.length === 0) return null;
  return ref;
}
