/**
 * Read paths warn and degrade so a broken bundle stays visible; install refuses
 * ambiguity because silently installing a different set than curated is worse
 * than an error.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isSafeItemName } from "./assert";
import { NotFoundError, PreconditionError } from "./errors";
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { ITEM_KINDS, isItemKind } from "./master";
import type { ItemKind } from "./master";
import { yamlParseDetail } from "./yaml-document";

export const BUNDLES_DIR = "bundles";

const MAX_BUNDLE_BYTES = 64 * 1024;

export interface BundleMember {
  kind: ItemKind;
  name: string;
}

export interface Bundle {
  name: string;
  path: string;
  description?: string;
  tags: string[];
  members: BundleMember[];
  warnings: string[];
  unknownKinds: string[];
  invalidIncludes: string[];
  malformed?: string;
}

export function memberRef(member: BundleMember): string {
  return `${member.kind}/${member.name}`;
}

/** Test this before `parseItemRef`, which rejects `bundles` as an item kind. */
export function isBundleRef(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith(`${BUNDLES_DIR}/`)) return null;
  const name = raw.slice(BUNDLES_DIR.length + 1);
  return isValidBundleName(name) ? name : null;
}

/**
 * Bundle names follow item-name rules (non-empty, no `/`, not `.`/`..`). `:` is
 * also rejected so bundle names stay addressable under a future shelf-qualified
 * ref grammar.
 */
export function isValidBundleName(name: string): boolean {
  if (!isSafeItemName(name)) return false;
  if (name.includes("/")) return false;
  if (name.includes(":")) return false;
  return true;
}

export function memberCountSummary(bundle: Bundle): string {
  const parts: string[] = [];
  for (const kind of ITEM_KINDS) {
    const count = bundle.members.filter((m) => m.kind === kind).length;
    if (count > 0) parts.push(`${count} ${kind}`);
  }
  return parts.join(" · ");
}

export function parseBundleText(
  text: string,
  name: string,
  path: string,
): Bundle {
  const bundle = emptyBundle(name, path);
  const label = `${BUNDLES_DIR}/${name}`;
  if (Buffer.byteLength(text, "utf-8") > MAX_BUNDLE_BYTES) {
    return markMalformed(bundle, `${label}: bundle file is larger than 64 KiB`);
  }

  let value: ConfigValue | undefined;
  try {
    value = parseYaml(text);
  } catch (cause) {
    return markMalformed(
      bundle,
      `${label}: invalid YAML (${yamlParseDetail(cause)})`,
    );
  }
  if (value === null || value === undefined) return bundle;
  if (!isConfigObject(value)) {
    return markMalformed(
      bundle,
      `${label}: invalid bundle file (expected a mapping)`,
    );
  }

  const raw = value;
  readBundleDescription(raw, bundle, label);
  readBundleTags(raw, bundle, label);
  readIncludes(raw, bundle, label);
  return bundle;
}

export async function listBundles(
  dataRepo: string,
): Promise<{ bundles: Bundle[]; warnings: string[] }> {
  const dir = join(dataRepo, BUNDLES_DIR);
  const bundles: Bundle[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { bundles, warnings };

  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".yaml")) {
      const stem = entry.name.slice(0, -".yaml".length);
      warnings.push(
        `${BUNDLES_DIR}/${entry.name} ignored — rename to ${stem}.yml`,
      );
      continue;
    }
    if (!entry.name.endsWith(".yml")) continue;
    const name = entry.name.slice(0, -".yml".length);
    if (!isValidBundleName(name)) {
      warnings.push(
        `${BUNDLES_DIR}/${entry.name} ignored — invalid bundle name "${name}"`,
      );
      continue;
    }
    bundles.push(await readBundleFile(join(dir, entry.name), name));
  }
  return { bundles, warnings };
}

export async function loadBundle(
  dataRepo: string,
  name: string,
): Promise<Bundle | null> {
  const path = join(dataRepo, BUNDLES_DIR, `${name}.yml`);
  if (!existsSync(path)) return null;
  return await readBundleFile(path, name);
}

export async function loadBundleStrict(
  dataRepo: string,
  name: string,
): Promise<Bundle> {
  const bundle = await loadBundle(dataRepo, name);
  if (!bundle) {
    const yamlPath = join(dataRepo, BUNDLES_DIR, `${name}.yaml`);
    const hint = existsSync(yamlPath)
      ? ` (found ${BUNDLES_DIR}/${name}.yaml — rename it to ${name}.yml)`
      : "";
    throw new NotFoundError(
      `bundle not found in data repo (${dataRepo}): ${BUNDLES_DIR}/${name}${hint}`,
    );
  }
  assertBundleInstallable(bundle);
  return bundle;
}

export function assertBundleInstallable(bundle: Bundle): void {
  if (bundle.malformed) {
    throw new PreconditionError(
      `not installing bundle ${bundle.name} — ${bundle.malformed}`,
      { hint: `fix ${bundle.path} and re-run` },
    );
  }
  if (bundle.unknownKinds.length > 0) {
    throw new PreconditionError(
      `not installing bundle ${bundle.name} — bundle declares kind${
        bundle.unknownKinds.length > 1 ? "s" : ""
      } ${bundle.unknownKinds.map((k) => `"${k}"`).join(", ")} this capshelf version does not support — upgrade capshelf or edit the bundle`,
      { hint: `declared in ${bundle.path}` },
    );
  }
  if (bundle.invalidIncludes.length > 0) {
    throw new PreconditionError(
      `not installing bundle ${bundle.name} — the member set is ambiguous: ${bundle.invalidIncludes
        .map((k) => `"includes.${k}"`)
        .join(", ")} must be a list of item names`,
      { hint: `fix ${bundle.path} and re-run` },
    );
  }
}

async function readBundleFile(path: string, name: string): Promise<Bundle> {
  const info = await stat(path);
  if (info.size > MAX_BUNDLE_BYTES) {
    return markMalformed(
      emptyBundle(name, path),
      `${BUNDLES_DIR}/${name}: bundle file is larger than 64 KiB`,
    );
  }
  return parseBundleText(await readFile(path, "utf-8"), name, path);
}

function emptyBundle(name: string, path: string): Bundle {
  return {
    name,
    path,
    tags: [],
    members: [],
    warnings: [],
    unknownKinds: [],
    invalidIncludes: [],
  };
}

function markMalformed(bundle: Bundle, message: string): Bundle {
  bundle.malformed = message;
  bundle.warnings.push(`${message} — bundle ignored`);
  return bundle;
}

function readBundleDescription(
  raw: ConfigObject,
  bundle: Bundle,
  label: string,
): void {
  if (!("description" in raw)) return;
  const description = raw.description;
  if (isConfigString(description)) {
    bundle.description = description;
    return;
  }
  bundle.warnings.push(
    `${label}: "description" must be a string — field ignored`,
  );
}

function readBundleTags(
  raw: ConfigObject,
  bundle: Bundle,
  label: string,
): void {
  if (!("tags" in raw)) return;
  const tags = raw.tags;
  if (!Array.isArray(tags)) {
    bundle.warnings.push(
      `${label}: "tags" must be a list of strings — field ignored`,
    );
    return;
  }
  for (const entry of tags) {
    if (isConfigString(entry) && entry.trim().length > 0) {
      bundle.tags.push(entry.trim());
    } else {
      bundle.warnings.push(
        `${label}: tag ${JSON.stringify(entry)} is not a non-empty string — entry ignored`,
      );
    }
  }
}

function readIncludes(raw: ConfigObject, bundle: Bundle, label: string): void {
  if (!("includes" in raw) || raw.includes === null) return;
  const includes = raw.includes;
  if (!isConfigObject(includes)) {
    bundle.invalidIncludes.push("includes");
    bundle.warnings.push(
      `${label}: "includes" must be a mapping of item kinds to member lists — members ignored`,
    );
    return;
  }

  const seen = new Set<string>();
  for (const kind of ITEM_KINDS) {
    readMemberList(includes[kind], kind, bundle, seen, label);
  }
  // Unknown kinds warn on read but refuse on install so an old binary never
  // silently installs a subset of a bundle authored for a newer one.
  for (const key of Object.keys(includes)) {
    if (isItemKind(key)) continue;
    bundle.unknownKinds.push(key);
    bundle.warnings.push(
      `${label}: includes kind "${key}" is not supported by this capshelf version — ignored`,
    );
  }
}

function readMemberList(
  value: ConfigValue | undefined,
  kind: ItemKind,
  bundle: Bundle,
  seen: Set<string>,
  label: string,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    bundle.invalidIncludes.push(kind);
    bundle.warnings.push(
      `${label}: "includes.${kind}" must be a list of item names — ignored`,
    );
    return;
  }
  for (const entry of value) {
    if (!isConfigString(entry) || !isValidBundleName(entry)) {
      if (!bundle.invalidIncludes.includes(kind)) {
        bundle.invalidIncludes.push(kind);
      }
      bundle.warnings.push(
        `${label}: includes.${kind} entry ${JSON.stringify(entry)} is not a valid item name — entry ignored`,
      );
      continue;
    }
    const ref = `${kind}/${entry}`;
    if (seen.has(ref)) {
      bundle.warnings.push(`${label}: duplicate member ${ref} — deduped`);
      continue;
    }
    seen.add(ref);
    bundle.members.push({ kind, name: entry });
  }
}
