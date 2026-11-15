import { isSafeItemRoot } from "./assert";
import type { ClaudePlugin } from "./claude-marketplace";
import { parseClaudeMarketplace } from "./claude-marketplace";
import {
  ConfigValueSchema,
  isConfigObject,
  isConfigString,
} from "./config-values";
import type { ConfigValue } from "./config-values";
import { firstErrorLine } from "./errors";
import { catFileBlobs } from "./git";
import type { GitTreeEntry } from "./git";
import { z } from "zod";

export const CLAUDE_CATALOG_PATH = ".claude-plugin/marketplace.json";
export const CODEX_CATALOG_PATH = ".agents/plugins/marketplace.json";
const CLAUDE_MANIFEST_REL = ".claude-plugin/plugin.json";
const CODEX_MANIFEST_REL = ".codex-plugin/plugin.json";
const MANIFEST_RELATIVE_PATHS = [
  CLAUDE_MANIFEST_REL,
  CODEX_MANIFEST_REL,
] as const;
const SKILL_FILE = "SKILL.md";
const GENERATED_CODEX_PREFIX = "codex/generated";

export type PluginCatalog = "claude" | "codex";

export const PLUGIN_PARTS = [
  "agents",
  "hooks",
  "workflows",
  "commands",
  "scripts",
  "prompts",
  ".mcp.json",
] as const;
export type PluginPart = (typeof PLUGIN_PARTS)[number];

export interface DiscoveredPlugin {
  name: string;
  source: string;
  catalogs: PluginCatalog[];
  ships: PluginPart[];
  skillDirs: string[];
}

export type SkippedReason =
  | "external-source"
  | "unsafe-path"
  | "missing"
  | "not-a-file"
  | "nested-plugin";

export interface SkippedEntry {
  name: string;
  catalog: PluginCatalog;
  reason: SkippedReason;
  source?: string;
  sourceKind?: string;
}

export interface DiscoveryWarning {
  path: string;
  message: string;
}

export interface WholePlugin {
  source: string;
  description: string | null;
  agents: number;
}

export interface PluginInventory {
  plugins: DiscoveredPlugin[];
  wholePlugins: WholePlugin[];
  skipped: SkippedEntry[];
  warnings: DiscoveryWarning[];
  legacySkillDirs: string[];
}

export function normalizeCatalogPath(raw: string): string | null {
  let path = raw.startsWith("./") ? raw.slice(2) : raw;
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") return ".";
  return isSafeItemRoot(path) ? path : null;
}

/** A blob with mode 100644 or 100755. A symlink or gitlink is neither. */
export function isRegularFile(entry: GitTreeEntry): boolean {
  return (
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755")
  );
}

export function hasPluginManifest(
  entries: readonly GitTreeEntry[],
  dir: string,
): boolean {
  return MANIFEST_RELATIVE_PATHS.some((rel) => {
    const entry = entries.find((e) => e.path === pluginPath(dir, rel));
    return entry !== undefined && isRegularFile(entry);
  });
}

export function pluginPath(dir: string, rel: string): string {
  return dir === "." ? rel : `${dir}/${rel}`;
}

export function lastSegment(path: string): string {
  return path.split("/").at(-1) ?? path;
}

const codexEntrySchema = z
  .object({ name: z.string().min(1), source: ConfigValueSchema.optional() })
  .passthrough();
const codexCatalogSchema = z
  .object({ plugins: z.array(codexEntrySchema) })
  .passthrough();
type CodexCatalogEntry = z.infer<typeof codexEntrySchema>;

function parseCodexCatalog(raw: string): z.infer<typeof codexCatalogSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Codex plugin catalog JSON: ${String(error)}`, {
      cause: error,
    });
  }
  const result = codexCatalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `invalid Codex plugin catalog: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

const manifestSchema = z
  .object({
    name: ConfigValueSchema.optional(),
    skills: ConfigValueSchema.optional(),
    description: ConfigValueSchema.optional(),
  })
  .passthrough();
type PluginManifest = z.infer<typeof manifestSchema>;

function parseManifest(raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid plugin manifest JSON: ${String(error)}`, {
      cause: error,
    });
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `invalid plugin manifest: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

function readCatalog<T>(
  path: string,
  entry: GitTreeEntry | undefined,
  blobs: ReadonlyMap<string, Buffer>,
  parse: (raw: string) => T,
  warnings: DiscoveryWarning[],
): T | undefined {
  if (entry === undefined) return undefined;
  if (!isRegularFile(entry)) {
    warnings.push({
      path,
      message: "is a symlink or submodule, not a file; ignored",
    });
    return undefined;
  }
  try {
    const bytes = blobs.get(entry.object) ?? Buffer.alloc(0);
    return parse(bytes.toString("utf8"));
  } catch (error) {
    warnings.push({
      path,
      message: `is present and could not be read: ${firstErrorLine(error)}`,
    });
    return undefined;
  }
}

async function readCatalogs(
  repo: string,
  entries: readonly GitTreeEntry[],
  warnings: DiscoveryWarning[],
): Promise<{
  claudePlugins: ClaudePlugin[];
  claudeMetadata: ConfigValue | undefined;
  codexEntries: CodexCatalogEntry[];
}> {
  const claudeEntry = entries.find((e) => e.path === CLAUDE_CATALOG_PATH);
  const codexEntry = entries.find((e) => e.path === CODEX_CATALOG_PATH);
  const blobIds: string[] = [];
  if (claudeEntry !== undefined && isRegularFile(claudeEntry)) {
    blobIds.push(claudeEntry.object);
  }
  if (codexEntry !== undefined && isRegularFile(codexEntry)) {
    blobIds.push(codexEntry.object);
  }
  const blobs =
    blobIds.length > 0
      ? await catFileBlobs(repo, blobIds)
      : new Map<string, Buffer>();

  const claudeDocument = readCatalog(
    CLAUDE_CATALOG_PATH,
    claudeEntry,
    blobs,
    parseClaudeMarketplace,
    warnings,
  );
  const codexDocument = readCatalog(
    CODEX_CATALOG_PATH,
    codexEntry,
    blobs,
    parseCodexCatalog,
    warnings,
  );

  // SAFETY: `metadata` is outside marketplaceSchema's fields, but the document
  // went through JSON.parse, so passthrough fields are plain JSON values.
  const claudeMetadata = claudeDocument?.metadata as ConfigValue | undefined;

  return {
    claudePlugins: claudeDocument?.plugins ?? [],
    claudeMetadata,
    codexEntries: codexDocument?.plugins ?? [],
  };
}

function isLegacyClaudePlugin(plugin: ClaudePlugin): boolean {
  if (Array.isArray(plugin.skills)) return true;
  return (
    isConfigString(plugin.source) && normalizeCatalogPath(plugin.source) === "."
  );
}

/**
 * Must keep the legacy rules: a skill must start with `./` and only a literal
 * trailing `/SKILL.md` is stripped, so don't reuse `normalizeCatalogPath`.
 */
function addLegacySkillDirs(plugin: ClaudePlugin, out: string[]): void {
  if (!Array.isArray(plugin.skills)) return;
  for (const skill of plugin.skills) {
    if (!isConfigString(skill) || !skill.startsWith("./")) continue;
    const ref = skill.slice(2);
    const dir = ref.endsWith(`/${SKILL_FILE}`)
      ? ref.slice(0, -(SKILL_FILE.length + 1))
      : ref;
    if (isSafeItemRoot(dir)) out.push(dir);
  }
}

/**
 * An entry listing skill folders for a directory with a regular Claude manifest
 * counts as a plugin, since Claude Code loads that directory as a plugin; the
 * repo root never does.
 */
function listsSkillsOfAClaudePlugin(
  plugin: ClaudePlugin,
  documentMetadata: ConfigValue | undefined,
  entries: readonly GitTreeEntry[],
): boolean {
  if (!Array.isArray(plugin.skills)) return false;
  const resolution = resolveClaudeSource(plugin, documentMetadata);
  return (
    resolution.kind === "resolved" &&
    resolution.path !== "." &&
    hasRegularEntryAt(entries, pluginPath(resolution.path, CLAUDE_MANIFEST_REL))
  );
}

type SourceResolution =
  | { kind: "resolved"; path: string; raw: string }
  | {
      kind: "skip";
      reason: SkippedReason;
      source?: string;
      sourceKind?: string;
    };

type CodexSourceResolution = SourceResolution | { kind: "dropped" };

function rawSourceText(value: ConfigValue): string {
  return isConfigString(value) ? value : JSON.stringify(value);
}

/**
 * `metadata.pluginRoot` is read once per marketplace document, as Claude Code
 * does, not per plugin entry.
 */
function resolveClaudeSource(
  plugin: ClaudePlugin,
  documentMetadata: ConfigValue | undefined,
): SourceResolution {
  const source = plugin.source;
  if (isConfigObject(source)) {
    const kind = source.source;
    return {
      kind: "skip",
      reason: "external-source",
      sourceKind: isConfigString(kind) ? kind : "object",
    };
  }
  if (!isConfigString(source)) {
    return {
      kind: "skip",
      reason: "unsafe-path",
      ...(source !== undefined && { source: rawSourceText(source) }),
    };
  }
  if (source.startsWith("./")) {
    const normalized = normalizeCatalogPath(source);
    if (normalized === null)
      return { kind: "skip", reason: "unsafe-path", source };
    return { kind: "resolved", path: normalized, raw: source };
  }
  if (source.startsWith("/")) {
    return { kind: "skip", reason: "unsafe-path", source };
  }
  // A bare name with no usable document-level metadata.pluginRoot is skipped
  // rather than falling back to the repo root, matching Claude Code.
  const pluginRootRaw = isConfigObject(documentMetadata)
    ? documentMetadata.pluginRoot
    : undefined;
  if (!isConfigString(pluginRootRaw)) {
    return { kind: "skip", reason: "unsafe-path", source };
  }
  const root = normalizeCatalogPath(pluginRootRaw);
  if (root === null) {
    return { kind: "skip", reason: "unsafe-path", source };
  }
  const joined = root === "." ? source : `${root}/${source}`;
  if (!isSafeItemRoot(joined))
    return { kind: "skip", reason: "unsafe-path", source };
  return { kind: "resolved", path: joined, raw: source };
}

function resolveCodexSource(entry: CodexCatalogEntry): CodexSourceResolution {
  const source = entry.source;
  if (isConfigObject(source)) {
    const sourceKind = source.source;
    if (sourceKind === "local") {
      const path = source.path;
      // A `local` source with a missing or non-string path is unsafe-path, not
      // external-source: `local` is a Codex catalog's own source shape,
      // malformed.
      if (!isConfigString(path)) {
        return {
          kind: "skip",
          reason: "unsafe-path",
          ...(path !== undefined && { source: rawSourceText(path) }),
        };
      }
      const normalized = normalizeCatalogPath(path);
      if (normalized === null) {
        return { kind: "skip", reason: "unsafe-path", source: path };
      }
      // A path normalizing to the repo root is legacy, like a Claude source of
      // ".": no plugin and not reported as skipped.
      if (normalized === ".") return { kind: "dropped" };
      if (
        normalized === GENERATED_CODEX_PREFIX ||
        normalized.startsWith(`${GENERATED_CODEX_PREFIX}/`)
      ) {
        return { kind: "dropped" };
      }
      return { kind: "resolved", path: normalized, raw: path };
    }
    return {
      kind: "skip",
      reason: "external-source",
      sourceKind: isConfigString(sourceKind) ? sourceKind : "object",
    };
  }
  if (source === undefined) return { kind: "skip", reason: "unsafe-path" };
  return { kind: "skip", reason: "unsafe-path", source: rawSourceText(source) };
}

function directoryStatus(
  entries: readonly GitTreeEntry[],
  dir: string,
): "exists" | "missing" | "not-a-file" {
  const hasEntryBelow =
    dir === "."
      ? entries.length > 0
      : entries.some((e) => e.path.startsWith(`${dir}/`));
  if (hasEntryBelow) return "exists";
  const atDir = entries.find((e) => e.path === dir);
  if (
    atDir !== undefined &&
    (atDir.mode === "120000" || atDir.mode === "160000")
  ) {
    return "not-a-file";
  }
  return "missing";
}

function pushSkip(
  skipped: SkippedEntry[],
  name: string,
  catalog: PluginCatalog,
  resolution: Extract<SourceResolution, { kind: "skip" }>,
): void {
  const entry: SkippedEntry = { name, catalog, reason: resolution.reason };
  if (resolution.source !== undefined) entry.source = resolution.source;
  if (resolution.sourceKind !== undefined)
    entry.sourceKind = resolution.sourceKind;
  skipped.push(entry);
}

interface Candidate {
  dir: string;
  claudeName?: string;
  codexName?: string;
  catalogs: PluginCatalog[];
  catalogSkills?: ConfigValue[];
}

function filterNestedPlugins(
  candidates: readonly Candidate[],
  skipped: SkippedEntry[],
): Candidate[] {
  const byLength = [...candidates].sort((a, b) => a.dir.length - b.dir.length);
  const nested = new Set<Candidate>();
  const kept: string[] = [];
  for (const candidate of byLength) {
    const isNested = kept.some((outer) =>
      candidate.dir.startsWith(`${outer}/`),
    );
    if (isNested) {
      nested.add(candidate);
      skipped.push({
        name:
          candidate.claudeName ??
          candidate.codexName ??
          lastSegment(candidate.dir),
        catalog: candidate.catalogs[0]!,
        reason: "nested-plugin",
        source: candidate.dir,
      });
    } else {
      kept.push(candidate.dir);
    }
  }
  return candidates.filter((candidate) => !nested.has(candidate));
}

function hasRegularEntryAt(
  entries: readonly GitTreeEntry[],
  path: string,
): boolean {
  const entry = entries.find((e) => e.path === path);
  return entry !== undefined && isRegularFile(entry);
}

function directSkillChildren(
  entries: readonly GitTreeEntry[],
  parent: string,
): string[] {
  const prefix = parent === "." ? "" : `${parent}/`;
  const found = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1 || rest.slice(slash + 1) !== SKILL_FILE) continue;
    if (!isRegularFile(entry)) continue;
    const child = rest.slice(0, slash);
    found.add(parent === "." ? child : `${parent}/${child}`);
  }
  return [...found];
}

/**
 * Claude Code reads a catalog entry's skill paths relative to the plugin
 * directory, same as a manifest's.
 */
function computeSkillDirs(
  entries: readonly GitTreeEntry[],
  dir: string,
  manifests: ReadonlyMap<string, PluginManifest>,
  catalogSkills: readonly ConfigValue[],
  warnings: DiscoveryWarning[],
): string[] {
  const skillDirs = new Set<string>();
  for (const child of directSkillChildren(entries, pluginPath(dir, "skills"))) {
    skillDirs.add(child);
  }
  const lists: Array<{ path: string; raw: readonly ConfigValue[] }> = [];
  for (const rel of MANIFEST_RELATIVE_PATHS) {
    const manifestPath = pluginPath(dir, rel);
    const manifest = manifests.get(manifestPath);
    if (manifest === undefined || manifest.skills === undefined) continue;
    lists.push({
      path: manifestPath,
      raw: Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills],
    });
  }
  lists.push({ path: CLAUDE_CATALOG_PATH, raw: catalogSkills });
  for (const list of lists) {
    for (const rawSkill of list.raw) {
      if (!isConfigString(rawSkill)) continue;
      // normalizeCatalogPath refuses `..` and absolute paths, so an accepted
      // path joined to `dir` stays inside the plugin; one refusal covers both
      // reasons, hence the combined warning.
      const normalized = normalizeCatalogPath(rawSkill);
      if (normalized === null) {
        warnings.push({
          path: list.path,
          message: `skills path ${rawSkill} is unsafe or leaves the plugin; skipped`,
        });
        continue;
      }
      const joined = normalized === "." ? dir : pluginPath(dir, normalized);
      if (hasRegularEntryAt(entries, pluginPath(joined, SKILL_FILE))) {
        skillDirs.add(joined);
      } else {
        for (const child of directSkillChildren(entries, joined))
          skillDirs.add(child);
      }
    }
  }
  return [...skillDirs].sort();
}

/**
 * A manifest that fails to parse still counts as a plugin, because the
 * whole-plugin install re-reads it and refuses with the reason.
 */
function wholePluginOf(
  entries: readonly GitTreeEntry[],
  dir: string,
  manifests: ReadonlyMap<string, PluginManifest>,
): WholePlugin | null {
  const manifestPath = pluginPath(dir, CLAUDE_MANIFEST_REL);
  if (!hasRegularEntryAt(entries, manifestPath)) return null;
  const description = manifests.get(manifestPath)?.description;
  const agentsPrefix = pluginPath(dir, "agents/");
  const agents = entries.filter((entry) => {
    if (!isRegularFile(entry) || !entry.path.startsWith(agentsPrefix)) {
      return false;
    }
    const rest = entry.path.slice(agentsPrefix.length);
    return !rest.includes("/") && rest.endsWith(".md");
  }).length;
  return {
    source: dir,
    description: isConfigString(description) ? description : null,
    agents,
  };
}

function resolveName(
  dir: string,
  names: { claude?: string; codex?: string },
  manifests: ReadonlyMap<string, PluginManifest>,
  warnings: DiscoveryWarning[],
): string {
  let manifestName: string | undefined;
  for (const rel of MANIFEST_RELATIVE_PATHS) {
    const manifest = manifests.get(pluginPath(dir, rel));
    if (manifest === undefined) continue;
    manifestName = isConfigString(manifest.name) ? manifest.name : undefined;
    break;
  }
  const chosen =
    manifestName ?? names.claude ?? names.codex ?? lastSegment(dir);
  const given = [manifestName, names.claude, names.codex].filter(
    (value): value is string => value !== undefined,
  );
  const others = [...new Set(given)].filter((value) => value !== chosen);
  if (others.length > 0) {
    warnings.push({
      path: dir,
      message: `catalogs and manifests name it ${others.join(", ")}; shown as ${chosen}`,
    });
  }
  return chosen;
}

function shipsOf(entries: readonly GitTreeEntry[], dir: string): PluginPart[] {
  const ships: PluginPart[] = [];
  for (const part of PLUGIN_PARTS) {
    if (part === ".mcp.json") {
      if (hasRegularEntryAt(entries, pluginPath(dir, part))) ships.push(part);
    } else if (
      entries.some((e) => e.path.startsWith(`${pluginPath(dir, part)}/`))
    ) {
      ships.push(part);
    }
  }
  return ships;
}

/**
 * A manifest that is a symlink or gitlink warns like a non-regular catalog and
 * contributes nothing.
 */
async function readManifests(
  repo: string,
  entries: readonly GitTreeEntry[],
  dir: string,
  manifestBlobs: ReadonlyMap<string, Buffer> | undefined,
  warnings: DiscoveryWarning[],
): Promise<Map<string, PluginManifest>> {
  const manifests = new Map<string, PluginManifest>();
  for (const rel of MANIFEST_RELATIVE_PATHS) {
    const manifestPath = pluginPath(dir, rel);
    const entry = entries.find((e) => e.path === manifestPath);
    if (entry === undefined) continue;
    if (!isRegularFile(entry)) {
      warnings.push({
        path: manifestPath,
        message: "is a symlink or submodule, not a file; ignored",
      });
      continue;
    }
    let bytes = manifestBlobs?.get(entry.object);
    if (bytes === undefined) {
      bytes =
        (await catFileBlobs(repo, [entry.object])).get(entry.object) ??
        Buffer.alloc(0);
    }
    try {
      manifests.set(manifestPath, parseManifest(bytes.toString("utf8")));
    } catch (error) {
      warnings.push({
        path: manifestPath,
        message: `is present and could not be read: ${firstErrorLine(error)}`,
      });
    }
  }
  return manifests;
}

/**
 * `manifestBlobs` lets a caller that already batched all manifests share one
 * `cat-file` process; absent, this reads them itself.
 */
export async function describePluginDirectory(
  repo: string,
  entries: readonly GitTreeEntry[],
  dir: string,
  names: { claude?: string; codex?: string },
  catalogs: PluginCatalog[],
  manifestBlobs?: ReadonlyMap<string, Buffer>,
  catalogSkills: readonly ConfigValue[] = [],
): Promise<{
  plugin: DiscoveredPlugin;
  warnings: DiscoveryWarning[];
  whole: WholePlugin | null;
}> {
  const warnings: DiscoveryWarning[] = [];
  const manifests = await readManifests(
    repo,
    entries,
    dir,
    manifestBlobs,
    warnings,
  );
  const skillDirs = computeSkillDirs(
    entries,
    dir,
    manifests,
    catalogSkills,
    warnings,
  );
  const name = resolveName(dir, names, manifests, warnings);
  const plugin: DiscoveredPlugin = {
    name,
    source: dir,
    catalogs: [...catalogs],
    ships: shipsOf(entries, dir),
    skillDirs,
  };
  return { plugin, warnings, whole: wholePluginOf(entries, dir, manifests) };
}

export async function discoverPlugins(
  repo: string,
  entries: readonly GitTreeEntry[],
): Promise<PluginInventory> {
  const warnings: DiscoveryWarning[] = [];
  const skipped: SkippedEntry[] = [];
  const legacySkillDirs: string[] = [];

  const { claudePlugins, claudeMetadata, codexEntries } = await readCatalogs(
    repo,
    entries,
    warnings,
  );

  const order: Candidate[] = [];
  const byDir = new Map<string, Candidate>();

  for (const plugin of claudePlugins) {
    const keptAsPlugin = listsSkillsOfAClaudePlugin(
      plugin,
      claudeMetadata,
      entries,
    );
    if (isLegacyClaudePlugin(plugin) && !keptAsPlugin) {
      addLegacySkillDirs(plugin, legacySkillDirs);
      continue;
    }
    const catalogSkills =
      keptAsPlugin && Array.isArray(plugin.skills) ? plugin.skills : undefined;
    const resolution = resolveClaudeSource(plugin, claudeMetadata);
    if (resolution.kind === "skip") {
      pushSkip(skipped, plugin.name, "claude", resolution);
      continue;
    }
    const status = directoryStatus(entries, resolution.path);
    if (status !== "exists") {
      skipped.push({
        name: plugin.name,
        catalog: "claude",
        reason: status,
        source: resolution.raw,
      });
      continue;
    }
    const existing = byDir.get(resolution.path);
    if (existing !== undefined) {
      if (!existing.catalogs.includes("claude"))
        existing.catalogs.push("claude");
      if (existing.claudeName === undefined) existing.claudeName = plugin.name;
      if (existing.catalogSkills === undefined && catalogSkills !== undefined) {
        existing.catalogSkills = catalogSkills;
      }
    } else {
      const candidate: Candidate = {
        dir: resolution.path,
        claudeName: plugin.name,
        catalogs: ["claude"],
        ...(catalogSkills !== undefined && { catalogSkills }),
      };
      byDir.set(resolution.path, candidate);
      order.push(candidate);
    }
  }

  for (const entry of codexEntries) {
    const resolution = resolveCodexSource(entry);
    if (resolution.kind === "dropped") continue;
    if (resolution.kind === "skip") {
      pushSkip(skipped, entry.name, "codex", resolution);
      continue;
    }
    const status = directoryStatus(entries, resolution.path);
    if (status !== "exists") {
      skipped.push({
        name: entry.name,
        catalog: "codex",
        reason: status,
        source: resolution.raw,
      });
      continue;
    }
    const existing = byDir.get(resolution.path);
    if (existing !== undefined) {
      if (!existing.catalogs.includes("codex")) existing.catalogs.push("codex");
      if (existing.codexName === undefined) existing.codexName = entry.name;
    } else {
      const candidate: Candidate = {
        dir: resolution.path,
        codexName: entry.name,
        catalogs: ["codex"],
      };
      byDir.set(resolution.path, candidate);
      order.push(candidate);
    }
  }

  const kept = filterNestedPlugins(order, skipped);

  const manifestBlobIds: string[] = [];
  for (const candidate of kept) {
    for (const rel of MANIFEST_RELATIVE_PATHS) {
      const entry = entries.find(
        (e) => e.path === pluginPath(candidate.dir, rel),
      );
      if (entry !== undefined && isRegularFile(entry))
        manifestBlobIds.push(entry.object);
    }
  }
  const manifestBlobs =
    manifestBlobIds.length > 0
      ? await catFileBlobs(repo, manifestBlobIds)
      : new Map<string, Buffer>();

  const plugins: DiscoveredPlugin[] = [];
  const wholePlugins: WholePlugin[] = [];
  for (const candidate of kept) {
    const described = await describePluginDirectory(
      repo,
      entries,
      candidate.dir,
      { claude: candidate.claudeName, codex: candidate.codexName },
      candidate.catalogs,
      manifestBlobs,
      candidate.catalogSkills,
    );
    plugins.push(described.plugin);
    warnings.push(...described.warnings);
    if (described.whole !== null) wholePlugins.push(described.whole);
  }

  return { plugins, wholePlugins, skipped, warnings, legacySkillDirs };
}
