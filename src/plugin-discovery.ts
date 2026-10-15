/**
 * What a repository publishes as Claude/Codex plugins, read at one commit.
 *
 * This reads the two plugin catalogs (`.claude-plugin/marketplace.json` and
 * `.agents/plugins/marketplace.json`) and the manifests each plugin directory
 * may carry (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), and
 * returns one inventory: the plugin directories, the entries that could not
 * be read, and the directories a capshelf-written catalog already manages
 * under today's rule (D2).
 *
 * Rule numbers in comments below refer to the task brief; `D<n>` refers to
 * the design's numbered decisions.
 */
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

/** Exported so `add --list`'s `found` line can name the catalog(s) that
 * named a plugin (`src/commands/add-remote.ts`). */
export const CLAUDE_CATALOG_PATH = ".claude-plugin/marketplace.json";
export const CODEX_CATALOG_PATH = ".agents/plugins/marketplace.json";
const CLAUDE_MANIFEST_REL = ".claude-plugin/plugin.json";
const CODEX_MANIFEST_REL = ".codex-plugin/plugin.json";
/** D15's manifest-name order: the Claude manifest, then the Codex one. */
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
  /** D15: manifest name, then Claude entry, then Codex entry, then directory. */
  name: string;
  /** Repository-relative plugin directory. Always passes isSafeItemRoot. */
  source: string;
  /** The catalogs that name this directory, "claude" first. Empty for a manifest-only plugin. */
  catalogs: PluginCatalog[];
  /** Top-level parts present, in PLUGIN_PARTS order. */
  ships: PluginPart[];
  /** Skill directories, repository-relative, sorted A to Z. */
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
  /** The source as written, for unsafe-path, missing, not-a-file, nested-plugin. */
  source?: string;
  /** For external-source: github, url, git-subdir, npm, or the object's `source` value. */
  sourceKind?: string;
}

export interface DiscoveryWarning {
  path: string;
  message: string;
}

export interface PluginInventory {
  /** Catalog order: Claude entries first, then entries only the Codex catalog names. */
  plugins: DiscoveredPlugin[];
  skipped: SkippedEntry[];
  warnings: DiscoveryWarning[];
  /** D2: skill directories from Claude entries with a `skills` array or source "./". */
  legacySkillDirs: string[];
}

/**
 * D12. Strip one leading `./` and one trailing `/`, then require
 * `isSafeItemRoot`. An empty result is the repository root, `.`. Shared by a
 * catalog `source`, `metadata.pluginRoot`, a Codex `local` path, and a
 * manifest `skills` path.
 */
export function normalizeCatalogPath(raw: string): string | null {
  let path = raw.startsWith("./") ? raw.slice(2) : raw;
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") return ".";
  return isSafeItemRoot(path) ? path : null;
}

/** D14: a blob with mode 100644 or 100755. A symlink or gitlink is neither. */
export function isRegularFile(entry: GitTreeEntry): boolean {
  return (
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755")
  );
}

/** A directory holding a regular `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`. */
export function hasPluginManifest(
  entries: readonly GitTreeEntry[],
  dir: string,
): boolean {
  return MANIFEST_RELATIVE_PATHS.some((rel) => {
    const entry = entries.find((e) => e.path === pluginPath(dir, rel));
    return entry !== undefined && isRegularFile(entry);
  });
}

/** `dir/rel`, or `rel` alone when `dir` is the repository root. */
export function pluginPath(dir: string, rel: string): string {
  return dir === "." ? rel : `${dir}/${rel}`;
}

export function lastSegment(path: string): string {
  return path.split("/").at(-1) ?? path;
}

// --------------------------------------------------------------- rule 3: codex

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

// ------------------------------------------------------------- rules 7 and 8

const manifestSchema = z
  .object({
    name: ConfigValueSchema.optional(),
    skills: ConfigValueSchema.optional(),
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

// ------------------------------------------------------------------- rule 1

/**
 * One catalog document: absent is quiet, present-but-not-a-file warns (rule
 * 1), and a parse failure warns and yields nothing. Shared by the Claude and
 * the Codex catalog, which otherwise differ only in their path and parser.
 */
async function readCatalog<T>(
  path: string,
  entry: GitTreeEntry | undefined,
  blobs: ReadonlyMap<string, Buffer>,
  parse: (raw: string) => T,
  warnings: DiscoveryWarning[],
): Promise<T | undefined> {
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

/** Rule 1: read both catalogs in one `cat-file` batch. */
async function readCatalogs(
  repo: string,
  entries: readonly GitTreeEntry[],
  warnings: DiscoveryWarning[],
): Promise<{
  claudePlugins: ClaudePlugin[];
  /** I1: `metadata` lives on the marketplace document, not on each entry. */
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

  const claudeDocument = await readCatalog(
    CLAUDE_CATALOG_PATH,
    claudeEntry,
    blobs,
    parseClaudeMarketplace,
    warnings,
  );
  const codexDocument = await readCatalog(
    CODEX_CATALOG_PATH,
    codexEntry,
    blobs,
    parseCodexCatalog,
    warnings,
  );

  // SAFETY: `metadata` is outside marketplaceSchema's declared fields
  // (src/claude-marketplace.ts:30-38); `parseClaudeMarketplace` parses the
  // whole document through JSON.parse first, so every passthrough field is
  // still a plain JSON value and narrows safely as ConfigValue.
  const claudeMetadata = claudeDocument?.metadata as ConfigValue | undefined;

  return {
    claudePlugins: claudeDocument?.plugins ?? [],
    claudeMetadata,
    codexEntries: codexDocument?.plugins ?? [],
  };
}

// ------------------------------------------------------------------- rule 2

/** D2: an entry with a `skills` array, or whose source is the repo root. */
function isLegacyClaudePlugin(plugin: ClaudePlugin): boolean {
  if (Array.isArray(plugin.skills)) return true;
  return (
    isConfigString(plugin.source) && normalizeCatalogPath(plugin.source) === "."
  );
}

/**
 * D2: "exactly as today" — the rules the deleted `marketplaceDirectories`
 * used (`src/remote-discovery.ts` at `d8b8168`, lines 321-333), not D12's
 * unified path rule. A `skills` entry must start with `./` (a bare name is
 * dropped, not resolved against anything); only a literal trailing
 * `/SKILL.md` is stripped, and no trailing `/` is. `normalizeCatalogPath`
 * does both of those differently and must not be reused here.
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
 * Rule 2: resolve one non-legacy Claude catalog entry's `source`.
 *
 * `documentMetadata` is the marketplace document's own top-level `metadata`
 * (I1): Claude Code reads `metadata.pluginRoot` once per marketplace, not
 * once per plugin entry.
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
  // A bare name: must join to a document-level metadata.pluginRoot. No
  // pluginRoot, a non-string one, or one that fails to normalize all skip
  // unsafe-path (I3, M3) — there is no silent fallback to the repository
  // root, matching Claude Code's own refusal of a bare name with no
  // metadata.pluginRoot.
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

// ------------------------------------------------------------------- rule 3

/** Rule 3: resolve one Codex catalog entry's `source`. */
function resolveCodexSource(entry: CodexCatalogEntry): CodexSourceResolution {
  const source = entry.source;
  if (isConfigObject(source)) {
    const sourceKind = source.source;
    if (sourceKind === "local") {
      const path = source.path;
      // M5: a `local` source with a missing or non-string path is
      // unsafe-path, not external-source — "local" is not another runtime's
      // source kind, it is this one's own shape, malformed.
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
      // I2: a path that normalizes to the repository root is legacy, the
      // same as a Claude source that normalizes to ".": no plugin, and not
      // reported as skipped.
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

// ------------------------------------------------------------------- rule 4

/** Rule 4 bullet 2: whether a resolved directory exists at the commit. */
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
}

// ------------------------------------------------------------------- rule 6

/**
 * D16: sort by path length, shortest (outermost) first, and drop a directory
 * that sits inside an already-kept one.
 */
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

// ------------------------------------------------------------------- rule 7

function isWithinPluginDir(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

function hasRegularEntryAt(
  entries: readonly GitTreeEntry[],
  path: string,
): boolean {
  const entry = entries.find((e) => e.path === path);
  return entry !== undefined && isRegularFile(entry);
}

/** Direct children of `parent` that hold a regular `SKILL.md`. */
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

/** Rule 7: the plugin's own `skills/*` dirs, plus each manifest's `skills` field. */
function computeSkillDirs(
  entries: readonly GitTreeEntry[],
  dir: string,
  manifests: ReadonlyMap<string, PluginManifest>,
  warnings: DiscoveryWarning[],
): string[] {
  const skillDirs = new Set<string>();
  for (const child of directSkillChildren(entries, pluginPath(dir, "skills"))) {
    skillDirs.add(child);
  }
  for (const rel of MANIFEST_RELATIVE_PATHS) {
    const manifestPath = pluginPath(dir, rel);
    const manifest = manifests.get(manifestPath);
    if (manifest === undefined || manifest.skills === undefined) continue;
    const rawList = Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills];
    for (const rawSkill of rawList) {
      if (!isConfigString(rawSkill)) continue;
      const normalized = normalizeCatalogPath(rawSkill);
      const joined =
        normalized === null
          ? null
          : normalized === "."
            ? dir
            : pluginPath(dir, normalized);
      if (joined === null || !isWithinPluginDir(joined, dir)) {
        warnings.push({
          path: manifestPath,
          message: `skills path ${rawSkill} leaves the plugin; skipped`,
        });
        continue;
      }
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

// ------------------------------------------------------------------- rule 8

/**
 * Rule 8 (D15): the plugin's name, and a warning when the sources disagree.
 *
 * I4: the directory's last segment is the final fallback for `chosen`, but
 * it never counts as a name a catalog or manifest "gave" — only the manifest
 * name and the two catalog entry names are compared for disagreement.
 */
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

// ------------------------------------------------------------------- rule 9

/** Rule 9: the top-level plugin parts present under `dir`. */
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
 * Read the manifests of one plugin directory, parsing each once. A manifest
 * that is absent is quiet. One that is present but a symlink or gitlink
 * warns, the same text as rule 1's catalog check (M2), and contributes
 * nothing. One that is present, a regular file, and fails to parse warns
 * with its own text and contributes nothing (rule 8).
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
 * Rules 7, 8, and 9 for one plugin directory: its skill dirs, its name, and
 * the parts it ships. `discoverPlugins` calls this once per kept directory,
 * after rule 6's nesting filter. Also called directly for a manifest-only
 * directory that no catalog names, with `catalogs: []`.
 *
 * `manifestBlobs` lets a caller that already batched every manifest's bytes
 * (as `discoverPlugins` does, to keep one `cat-file` process for all of
 * them) pass them down; absent, this reads the two manifest blobs itself.
 */
export async function describePluginDirectory(
  repo: string,
  entries: readonly GitTreeEntry[],
  dir: string,
  names: { claude?: string; codex?: string },
  catalogs: PluginCatalog[],
  manifestBlobs?: ReadonlyMap<string, Buffer>,
): Promise<{ plugin: DiscoveredPlugin; warnings: DiscoveryWarning[] }> {
  const warnings: DiscoveryWarning[] = [];
  const manifests = await readManifests(
    repo,
    entries,
    dir,
    manifestBlobs,
    warnings,
  );
  const skillDirs = computeSkillDirs(entries, dir, manifests, warnings);
  const name = resolveName(dir, names, manifests, warnings);
  const plugin: DiscoveredPlugin = {
    name,
    source: dir,
    catalogs: [...catalogs],
    ships: shipsOf(entries, dir),
    skillDirs,
  };
  return { plugin, warnings };
}

/**
 * Every plugin directory named by either catalog at `commit`, plus what was
 * skipped and what could not be read. `entries` is the full `ls-tree -r -z`
 * output at `commit` (`src/remote-discovery.ts:86-88`).
 *
 * Reads a fixed number of Git processes: one `cat-file --batch` for both
 * catalogs, and one more for every plugin's manifests.
 */
export async function discoverPlugins(
  repo: string,
  commit: string,
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
    if (isLegacyClaudePlugin(plugin)) {
      addLegacySkillDirs(plugin, legacySkillDirs);
      continue;
    }
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
    } else {
      const candidate: Candidate = {
        dir: resolution.path,
        claudeName: plugin.name,
        catalogs: ["claude"],
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
  for (const candidate of kept) {
    const described = await describePluginDirectory(
      repo,
      entries,
      candidate.dir,
      { claude: candidate.claudeName, codex: candidate.codexName },
      candidate.catalogs,
      manifestBlobs,
    );
    plugins.push(described.plugin);
    warnings.push(...described.warnings);
  }

  return { plugins, skipped, warnings, legacySkillDirs };
}
