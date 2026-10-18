/**
 * What a plugin runs without the agent asking: its hooks and its MCP
 * servers (spec D6, D7 point 2).
 *
 * The reader is conservative (D6): a declaration that does not parse, or a
 * manifest path that leaves the plugin root, is reported in `unknown`. It
 * never reports "no hooks" for something it could not read — a reader that
 * silently dropped an unreadable file would be a false negative at the one
 * gate the design has.
 *
 * Hooks and MCP servers are not the complete set. Claude Code also arms
 * background monitors and starts LSP servers from a plugin, and its manifest
 * schema grows. The reader does not list those. It reports each one in
 * `unknown`, and so does every manifest key that is not on the inert
 * allowlist, so a consent point asks whenever capshelf cannot list what the
 * plugin runs.
 *
 * Two callers read the same logic through one `PluginFileReader` seam:
 * `pluginRunsAtCommit` reads blobs from a pinned Git tree, `pluginRunsOnDisk`
 * reads files from an installed directory.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ConfigObjectSchema,
  isConfigObject,
  isConfigString,
} from "./config-values";
import type { ConfigObject } from "./config-values";
import { lstatOrNull } from "./fs-utils";
import { catFileBlobs } from "./git";
import type { GitTreeSource } from "./item-source";
import { PLUGIN_MANIFEST_REL } from "./master";
import type { ItemKind } from "./master";
import { destinationKey, itemTreeEntriesAtCommit } from "./pin";
import type { PinTreeEntry } from "./pin";
import { normalizeCatalogPath } from "./plugin-discovery";
import { shellCommand } from "./shell-quote";

const HOOKS_DEFAULT_REL = "hooks/hooks.json";
const MCP_DEFAULT_REL = ".mcp.json";
const MONITORS_DEFAULT_REL = "monitors/monitors.json";
const LSP_DEFAULT_REL = ".lsp.json";

/**
 * Manifest keys that run nothing, or that this reader models itself (`hooks`,
 * `mcpServers`). Any other key is unknown: a key that Claude Code added after
 * this list was written can start a process.
 */
const INERT_MANIFEST_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "agents",
  "commands",
  "outputStyles",
  "themes",
  "workflows",
  "evals",
  "hooks",
  "mcpServers",
]);

const MONITORS_FILE_UNKNOWN = `${MONITORS_DEFAULT_REL} declares background monitors; capshelf does not list them`;
const LSP_FILE_UNKNOWN = `${LSP_DEFAULT_REL} declares LSP servers; capshelf does not list them`;

export interface PluginRunHook {
  event: string;
  matcher: string | null;
  type: string;
  command: string | null;
  source: string;
}

export interface PluginRunServer {
  name: string;
  /** The executable, or null for a server with no `command`. */
  command: string | null;
  /** The arguments, one element each, so their boundaries stay exact. */
  args: string[];
  url: string | null;
  source: string;
}

export interface PluginRuns {
  hooks: PluginRunHook[];
  mcpServers: PluginRunServer[];
  unknown: string[];
}

/** Returns the file's bytes, or null when the path is absent or unusable. */
export type PluginFileReader = (relPath: string) => Promise<Buffer | null>;

// --------------------------------------------------------------- schemas

const hookEntrySchema = z
  .object({ type: z.string(), command: z.string().optional() })
  .passthrough();
const hookGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookEntrySchema) })
  .passthrough();
const hooksDocumentSchema = z
  .object({ hooks: z.record(z.string(), z.array(hookGroupSchema)) })
  .passthrough();
type HooksDocument = z.infer<typeof hooksDocumentSchema>;

const mcpServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
  })
  .passthrough();
const mcpServersMapSchema = z.record(z.string(), mcpServerConfigSchema);
type McpServersMap = z.infer<typeof mcpServersMapSchema>;

type PluginManifest = ConfigObject;

function unknownEntry(source: string): string {
  return `${source} could not be read`;
}

function manifestDeclares(what: string): string {
  return `${PLUGIN_MANIFEST_REL} declares ${what}; capshelf does not list them`;
}

function manifestKeyUnknown(key: string): string {
  return `${PLUGIN_MANIFEST_REL} declares ${JSON.stringify(key)}; capshelf does not know what it runs`;
}

function parseJsonDocument<T>(bytes: Buffer, schema: z.ZodType<T>): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ----------------------------------------------------------------- manifest

async function readManifest(
  read: PluginFileReader,
  unknown: string[],
): Promise<PluginManifest | null> {
  const bytes = await read(PLUGIN_MANIFEST_REL);
  if (bytes === null) {
    unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
    return null;
  }
  const manifest = parseJsonDocument(bytes, ConfigObjectSchema);
  if (manifest === null) {
    unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
    return null;
  }
  return manifest;
}

// -------------------------------------------------------------------- hooks

function pushHooksFromDocument(
  doc: HooksDocument,
  source: string,
  hooks: PluginRunHook[],
): void {
  for (const [event, groups] of Object.entries(doc.hooks)) {
    for (const group of groups) {
      const matcher = group.matcher ?? null;
      for (const hook of group.hooks) {
        hooks.push({
          event,
          matcher,
          type: hook.type,
          command: hook.command ?? null,
          source,
        });
      }
    }
  }
}

async function readHooksFromPath(
  read: PluginFileReader,
  rawPath: string,
  hooks: PluginRunHook[],
  unknown: string[],
): Promise<void> {
  const normalized = normalizeCatalogPath(rawPath);
  if (normalized === null || normalized === ".") {
    unknown.push(unknownEntry(rawPath));
    return;
  }
  const bytes = await read(normalized);
  if (bytes === null) {
    unknown.push(unknownEntry(normalized));
    return;
  }
  const doc = parseJsonDocument(bytes, hooksDocumentSchema);
  if (doc === null) {
    unknown.push(unknownEntry(normalized));
    return;
  }
  pushHooksFromDocument(doc, normalized, hooks);
}

/** The manifest `hooks` field, in the order R10 names: string, array, object. */
async function readManifestHooks(
  read: PluginFileReader,
  manifest: PluginManifest,
  hooks: PluginRunHook[],
  unknown: string[],
): Promise<void> {
  const raw = manifest.hooks;
  if (raw === undefined) return;
  if (isConfigString(raw)) {
    await readHooksFromPath(read, raw, hooks, unknown);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isConfigString(item)) {
        await readHooksFromPath(read, item, hooks, unknown);
      } else {
        unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
      }
    }
    return;
  }
  if (isConfigObject(raw)) {
    const result = hooksDocumentSchema.safeParse(raw);
    if (!result.success) {
      unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
      return;
    }
    pushHooksFromDocument(result.data, PLUGIN_MANIFEST_REL, hooks);
    return;
  }
  // Any other type (number, boolean, null): unknown.
  unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
}

async function collectHooks(
  read: PluginFileReader,
  manifest: PluginManifest | null,
  hooks: PluginRunHook[],
  unknown: string[],
): Promise<void> {
  const defaultBytes = await read(HOOKS_DEFAULT_REL);
  if (defaultBytes !== null) {
    const doc = parseJsonDocument(defaultBytes, hooksDocumentSchema);
    if (doc === null) unknown.push(unknownEntry(HOOKS_DEFAULT_REL));
    else pushHooksFromDocument(doc, HOOKS_DEFAULT_REL, hooks);
  }
  if (manifest === null) return;
  await readManifestHooks(read, manifest, hooks, unknown);
}

// ------------------------------------------- monitors, LSP, unknown keys

/**
 * The manifest keys this reader cannot list (D6): `monitors` (also under
 * `experimental`), `lspServers`, and every key off the inert allowlist. One
 * entry per source, whatever the value holds: Claude Code reads these keys,
 * so even a value capshelf would call malformed can run a command.
 */
function collectManifestUnknowns(
  manifest: PluginManifest,
  unknown: string[],
): void {
  let monitors = manifest.monitors !== undefined;
  const keys: string[] = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (INERT_MANIFEST_KEYS.has(key) || key === "monitors") continue;
    if (key === "lspServers") {
      unknown.push(manifestDeclares("lspServers"));
    } else if (key === "experimental" && isConfigObject(value)) {
      for (const subKey of Object.keys(value)) {
        if (subKey === "monitors") monitors = true;
        else if (!INERT_MANIFEST_KEYS.has(subKey)) {
          keys.push(`experimental.${subKey}`);
        }
      }
    } else {
      keys.push(key);
    }
  }
  if (monitors) unknown.push(manifestDeclares("monitors"));
  for (const key of keys) unknown.push(manifestKeyUnknown(key));
}

/**
 * The default monitor and LSP files Claude Code loads when present. Their
 * contents are not parsed: presence alone is reported.
 */
async function collectDefaultFileUnknowns(
  read: PluginFileReader,
  unknown: string[],
): Promise<void> {
  if ((await read(MONITORS_DEFAULT_REL)) !== null) {
    unknown.push(MONITORS_FILE_UNKNOWN);
  }
  if ((await read(LSP_DEFAULT_REL)) !== null) unknown.push(LSP_FILE_UNKNOWN);
}

// --------------------------------------------------------------- MCP servers

function pushServersFromMap(
  map: McpServersMap,
  source: string,
  servers: PluginRunServer[],
): void {
  for (const [name, config] of Object.entries(map)) {
    servers.push({
      name,
      command: config.command ?? null,
      args: config.args ?? [],
      url: config.url ?? null,
      source,
    });
  }
}

/**
 * `.mcp.json`'s two shapes: the `mcpServers` wrapper when that key holds an
 * object, else the top-level object itself.
 */
function parseMcpDocument(bytes: Buffer): McpServersMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const topLevel = ConfigObjectSchema.safeParse(parsed);
  if (!topLevel.success) return null;
  const candidate = isConfigObject(topLevel.data.mcpServers)
    ? topLevel.data.mcpServers
    : topLevel.data;
  const result = mcpServersMapSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

async function collectServers(
  read: PluginFileReader,
  manifest: PluginManifest | null,
  servers: PluginRunServer[],
  unknown: string[],
): Promise<void> {
  const defaultBytes = await read(MCP_DEFAULT_REL);
  if (defaultBytes !== null) {
    const map = parseMcpDocument(defaultBytes);
    if (map === null) unknown.push(unknownEntry(MCP_DEFAULT_REL));
    else pushServersFromMap(map, MCP_DEFAULT_REL, servers);
  }
  if (manifest === null) return;
  const raw = manifest.mcpServers;
  if (raw === undefined) return;
  if (!isConfigObject(raw)) {
    unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
    return;
  }
  const result = mcpServersMapSchema.safeParse(raw);
  if (!result.success) {
    unknown.push(unknownEntry(PLUGIN_MANIFEST_REL));
    return;
  }
  pushServersFromMap(result.data, PLUGIN_MANIFEST_REL, servers);
}

// ----------------------------------------------------------------- top level

export async function readPluginRuns(
  read: PluginFileReader,
): Promise<PluginRuns> {
  const hooks: PluginRunHook[] = [];
  const mcpServers: PluginRunServer[] = [];
  const unknown: string[] = [];
  const manifest = await readManifest(read, unknown);
  await collectHooks(read, manifest, hooks, unknown);
  await collectServers(read, manifest, mcpServers, unknown);
  await collectDefaultFileUnknowns(read, unknown);
  if (manifest !== null) collectManifestUnknowns(manifest, unknown);
  return { hooks, mcpServers, unknown };
}

export function runsHaveEntries(runs: PluginRuns): boolean {
  return (
    runs.hooks.length > 0 ||
    runs.mcpServers.length > 0 ||
    runs.unknown.length > 0
  );
}

function hookIdentity(hook: PluginRunHook): string {
  return JSON.stringify([hook.event, hook.matcher, hook.command]);
}

/**
 * The arguments stay an array: joined with spaces, `["-c", "a", "; b"]` and
 * `["-c", "a ; b"]` would be one identity, but only the second runs `b`.
 */
function serverIdentity(server: PluginRunServer): string {
  return JSON.stringify([server.name, server.command, server.args, server.url]);
}

/**
 * The command line a person reads: the executable and each argument, quoted
 * for a POSIX shell so the argument boundaries show. Null for a server with
 * no `command`.
 */
export function serverCommandLine(server: PluginRunServer): string | null {
  if (server.command === null) return null;
  return shellCommand([server.command, ...server.args]);
}

/**
 * The entries in `next` that `previous` did not have (D7 point 2). A hook is
 * new when no previous hook shares its event, matcher, and command; a server
 * is new when no previous server shares its name, command, arguments, and
 * url. A script changing while its hook line stays the same is therefore not
 * a new entry.
 *
 * Every unknown entry of `next` is kept, also one the previous tree had. An
 * unreadable declaration can never be shown to be unchanged, and D7 says a
 * non-empty unknown list always asks.
 */
export function newRunsEntries(
  previous: PluginRuns,
  next: PluginRuns,
): PluginRuns {
  const previousHooks = new Set(previous.hooks.map(hookIdentity));
  const previousServers = new Set(previous.mcpServers.map(serverIdentity));
  return {
    hooks: next.hooks.filter((hook) => !previousHooks.has(hookIdentity(hook))),
    mcpServers: next.mcpServers.filter(
      (server) => !previousServers.has(serverIdentity(server)),
    ),
    unknown: [...next.unknown],
  };
}

/**
 * Every entry of either set, once: a hook or a server both sets hold by
 * identity appears once, and every unknown entry appears once. A consent
 * point that covers two trees asks with this.
 */
export function unionRuns(left: PluginRuns, right: PluginRuns): PluginRuns {
  const hooks = new Set(left.hooks.map(hookIdentity));
  const servers = new Set(left.mcpServers.map(serverIdentity));
  return {
    hooks: [
      ...left.hooks,
      ...right.hooks.filter((hook) => !hooks.has(hookIdentity(hook))),
    ],
    mcpServers: [
      ...left.mcpServers,
      ...right.mcpServers.filter(
        (server) => !servers.has(serverIdentity(server)),
      ),
    ],
    unknown: [...new Set([...left.unknown, ...right.unknown])],
  };
}

// ------------------------------------------------------------------ readers

const DEFAULT_CANDIDATE_RELS = [
  PLUGIN_MANIFEST_REL,
  HOOKS_DEFAULT_REL,
  MCP_DEFAULT_REL,
  MONITORS_DEFAULT_REL,
  LSP_DEFAULT_REL,
] as const;

function isRegularBlobMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

/**
 * D6's conservative-reader rule extended to the three default candidate
 * paths themselves. `collectHooks`/`collectServers`/`readManifest` treat a
 * `null` read of one of these as "genuinely absent" and stay quiet — correct
 * for a truly missing file, wrong for one that exists but is unsafe to read
 * (a symlink on disk, a non-regular blob at a commit). `readPluginRuns` has
 * no way to tell those two "null" cases apart through `PluginFileReader`
 * alone, so each caller checks presence its own way and this adds the one
 * unknown entry that quiet absence would otherwise swallow.
 *
 * Runs after `readPluginRuns`, so a source already flagged unknown for
 * another reason (the manifest's own parse failure, say) is never
 * duplicated — `isUnsafePresent` only asks "does this exist and refuse to be
 * read", not "does it already appear in `unknown`".
 */
function addUnsafeDefaultUnknowns(
  runs: PluginRuns,
  isUnsafePresent: (relPath: string) => boolean,
): void {
  for (const relPath of DEFAULT_CANDIDATE_RELS) {
    if (!isUnsafePresent(relPath)) continue;
    const message = unknownEntry(relPath);
    if (!runs.unknown.includes(message)) runs.unknown.push(message);
  }
}

/** The widest folding a destination filesystem applies: NFC, then case. */
const FULL_FOLDING = { caseFolding: true, normalizationFolding: true };

function foldedPath(path: string): string {
  return destinationKey(path, FULL_FOLDING);
}

/**
 * The paths Claude Code reads a declaration from: the default candidates and
 * each path the manifest `hooks` field names.
 */
function declarationPaths(manifestBytes: Buffer | null): string[] {
  return [...DEFAULT_CANDIDATE_RELS, ...manifestNamedHookPaths(manifestBytes)];
}

/**
 * D6's conservative-reader rule for a destination that folds names. On a
 * case-insensitive or normalization-insensitive volume, Claude Code finds
 * `HOOKS/hooks.json` when it asks for `hooks/hooks.json`. The reader asks for
 * the exact bytes, so each present path that folds to a declaration path,
 * but is not that path, is one unknown entry. Both readers call this with
 * the paths they found, so the two cannot disagree.
 */
function addCaseVariantUnknowns(
  runs: PluginRuns,
  declared: readonly string[],
  present: readonly string[],
): void {
  const exact = new Set(declared);
  for (const expected of declared) {
    const key = foldedPath(expected);
    for (const actual of present) {
      if (exact.has(actual) || foldedPath(actual) !== key) continue;
      const message = `${actual} differs only in case from ${expected}; capshelf does not read it`;
      if (!runs.unknown.includes(message)) runs.unknown.push(message);
    }
  }
}

/**
 * The paths under `dir` that fold to `relPath`, found one segment at a time.
 * Each name in a directory is compared folded, so this finds `HOOKS/hooks.json`
 * on a case-sensitive volume too, where a teammate's volume may fold it.
 */
async function foldedMatchesOnDisk(
  dir: string,
  relPath: string,
): Promise<string[]> {
  let matches = [""];
  for (const segment of relPath.split("/")) {
    const key = foldedPath(segment);
    const next: string[] = [];
    for (const parent of matches) {
      let names: string[];
      try {
        names = await readdir(join(dir, ...parent.split("/")));
      } catch {
        continue;
      }
      for (const name of names) {
        if (foldedPath(name) === key) {
          next.push(parent === "" ? name : `${parent}/${name}`);
        }
      }
    }
    matches = next;
  }
  return matches;
}

/**
 * The manifest `hooks` field's string path(s), normalized and resolved. Two
 * uses: prefetching in `pluginRunsAtCommit`, where a missed path is still
 * read one blob at a time, and the case-variant check, which reads the field
 * the same way `readManifestHooks` does.
 */
function manifestNamedHookPaths(manifestBytes: Buffer | null): string[] {
  if (manifestBytes === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return [];
  }
  const result = ConfigObjectSchema.safeParse(parsed);
  if (!result.success) return [];
  const raw = result.data.hooks;
  const rawPaths = isConfigString(raw)
    ? [raw]
    : Array.isArray(raw)
      ? raw.filter(isConfigString)
      : [];
  const normalized: string[] = [];
  for (const rawPath of rawPaths) {
    const path = normalizeCatalogPath(rawPath);
    if (path !== null && path !== ".") normalized.push(path);
  }
  return normalized;
}

/**
 * Read a plugin's runs from a pinned Git tree. Reads a fixed number of
 * `cat-file --batch` processes in the common case: one for the default
 * candidate files (the manifest, `hooks/hooks.json`, `.mcp.json`), one more
 * for the paths the manifest's `hooks` field names. A path missed by that
 * second batch — an edge case this reader's own logic does not anticipate —
 * still reads correctly through one extra per-path fetch, never as a false
 * "could not be read".
 *
 * `assertRegularBlobEntries` (`src/git.ts:697-712`) already refuses a
 * symlink or gitlink before `pin.ts` ever builds a `PinTreeEntry`, so in
 * practice every entry here already has a regular-file mode. This reader
 * checks the mode itself anyway rather than trusting that invariant: a
 * caller that builds `entries` by some other path must not be able to make
 * this reader silently treat a non-regular blob as absent.
 */
export async function pluginRunsAtCommit(
  repo: string,
  entries: readonly PinTreeEntry[],
): Promise<PluginRuns> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  const blobs = new Map<string, Buffer>();

  function regularEntryAt(relPath: string): PinTreeEntry | undefined {
    const entry = byPath.get(relPath);
    return entry !== undefined && isRegularBlobMode(entry.mode)
      ? entry
      : undefined;
  }

  async function fetchBlobsFor(relPaths: readonly string[]): Promise<void> {
    const ids: string[] = [];
    for (const relPath of relPaths) {
      const entry = regularEntryAt(relPath);
      if (entry !== undefined && !blobs.has(entry.blobId))
        ids.push(entry.blobId);
    }
    if (ids.length === 0) return;
    const fetched = await catFileBlobs(repo, ids);
    for (const [id, bytes] of fetched) blobs.set(id, bytes);
  }

  await fetchBlobsFor(DEFAULT_CANDIDATE_RELS);
  const manifestEntry = regularEntryAt(PLUGIN_MANIFEST_REL);
  const manifestBytes =
    manifestEntry === undefined
      ? null
      : (blobs.get(manifestEntry.blobId) ?? null);
  const declared = declarationPaths(manifestBytes);
  await fetchBlobsFor(declared);

  const reader: PluginFileReader = async (relPath) => {
    const entry = regularEntryAt(relPath);
    if (entry === undefined) return null;
    if (!blobs.has(entry.blobId)) await fetchBlobsFor([relPath]);
    return blobs.get(entry.blobId) ?? null;
  };
  const runs = await readPluginRuns(reader);

  addUnsafeDefaultUnknowns(runs, (relPath) => {
    const entry = byPath.get(relPath);
    return entry !== undefined && !isRegularBlobMode(entry.mode);
  });
  addCaseVariantUnknowns(
    runs,
    declared,
    entries.map((entry) => entry.path),
  );
  return runs;
}

/**
 * Read a plugin's runs from an installed directory. A symlink or a
 * non-regular file is treated the same as absent by the reader itself — it
 * is never followed or opened — but a present, unsafe default candidate
 * still produces one unknown entry (D6), rather than being silently read as
 * "no hooks".
 */
export async function pluginRunsOnDisk(dir: string): Promise<PluginRuns> {
  const reader: PluginFileReader = async (relPath) => {
    const fullPath = join(dir, ...relPath.split("/"));
    const info = lstatOrNull(fullPath);
    if (!info?.isFile()) return null;
    try {
      return await readFile(fullPath);
    } catch {
      return null;
    }
  };
  const runs = await readPluginRuns(reader);

  addUnsafeDefaultUnknowns(runs, (relPath) => {
    const info = lstatOrNull(join(dir, ...relPath.split("/")));
    return info !== null && info !== undefined && !info.isFile();
  });
  const declared = declarationPaths(await reader(PLUGIN_MANIFEST_REL));
  const present: string[] = [];
  for (const relPath of declared) {
    present.push(...(await foldedMatchesOnDisk(dir, relPath)));
  }
  addCaseVariantUnknowns(runs, declared, present);
  return runs;
}

/** One file of an in-memory tree, plugin-relative and POSIX-separated. */
export interface PluginTreeFile {
  path: string;
  content: Buffer;
}

/**
 * Read a plugin's runs from files held in memory, such as an `update
 * --merge` result before it is written. Every file here is a regular file,
 * so the unsafe-default rule has nothing to add.
 */
export async function pluginRunsFromFiles(
  files: readonly PluginTreeFile[],
): Promise<PluginRuns> {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const reader: PluginFileReader = async (relPath) =>
    byPath.get(relPath) ?? null;
  const runs = await readPluginRuns(reader);
  addCaseVariantUnknowns(
    runs,
    declarationPaths(byPath.get(PLUGIN_MANIFEST_REL) ?? null),
    files.map((file) => file.path),
  );
  return runs;
}

/**
 * Whether an item is a plugin to Claude Code, and so needs plugin consent
 * (D7). A `plugins` item always is. A `skills` item is one when its tree
 * holds `.claude-plugin/plugin.json`: Claude Code loads the skill folder as
 * `<name>@skills-dir` and runs its hooks (spec R1). Any entry at that path
 * counts, also a non-regular one, so an unsafe manifest gets the reader's
 * unknown entry instead of no question. So does an entry that differs only
 * in case or normalization, because a folding volume loads it.
 */
async function carriesPluginManifest(
  kind: ItemKind,
  hasManifestEntry: () => Promise<boolean>,
): Promise<boolean> {
  if (kind === "plugins") return true;
  return kind === "skills" && (await hasManifestEntry());
}

/**
 * What a pinned item tree runs as a plugin, or null when the item is not a
 * plugin to Claude Code (see `carriesPluginManifest`). Every consent site
 * asks this instead of checking for the `plugins` kind.
 */
export async function itemPluginRunsAtCommit(
  repo: string,
  kind: ItemKind,
  entries: readonly PinTreeEntry[],
): Promise<PluginRuns | null> {
  const manifestKey = foldedPath(PLUGIN_MANIFEST_REL);
  const isPlugin = await carriesPluginManifest(kind, async () =>
    entries.some((entry) => foldedPath(entry.path) === manifestKey),
  );
  return isPlugin ? await pluginRunsAtCommit(repo, entries) : null;
}

/** `itemPluginRunsAtCommit` for an item directory on disk. */
export async function itemPluginRunsOnDisk(
  kind: ItemKind,
  dir: string,
): Promise<PluginRuns | null> {
  const isPlugin = await carriesPluginManifest(
    kind,
    async () =>
      (await foldedMatchesOnDisk(dir, PLUGIN_MANIFEST_REL)).length > 0,
  );
  return isPlugin ? await pluginRunsOnDisk(dir) : null;
}

/** `itemPluginRunsAtCommit` for files held in memory. */
export async function itemPluginRunsFromFiles(
  kind: ItemKind,
  files: readonly PluginTreeFile[],
): Promise<PluginRuns | null> {
  const manifestKey = foldedPath(PLUGIN_MANIFEST_REL);
  const isPlugin = await carriesPluginManifest(kind, async () =>
    files.some((file) => foldedPath(file.path) === manifestKey),
  );
  return isPlugin ? await pluginRunsFromFiles(files) : null;
}

/**
 * The runs entries a pin move adds (D7 point 2) for an item that is a plugin
 * to Claude Code at the new tree, or null when it is not one there. A tree
 * that was not a plugin before (a skill that gains a manifest) counts as
 * running nothing, so each of its entries is new.
 */
export async function itemPluginNewRuns(
  repo: string,
  kind: ItemKind,
  before: readonly PinTreeEntry[],
  after: readonly PinTreeEntry[],
): Promise<PluginRuns | null> {
  const next = await itemPluginRunsAtCommit(repo, kind, after);
  if (next === null) return null;
  const previous = (await itemPluginRunsAtCommit(repo, kind, before)) ?? {
    hooks: [],
    mcpServers: [],
    unknown: [],
  };
  return newRunsEntries(previous, next);
}

/** What a plugin status row reports: counts, and each unread source (D11). */
export interface PluginRunCounts {
  hooks: number;
  mcpServers: number;
  unknown: string[];
}

/**
 * The counts D11 reports for a plugin row, shelf or remote. The installed
 * tree when the folder exists: for a clean row it equals the pinned tree,
 * and for a drifted row it is what Claude Code loads. The pinned tree when
 * the folder is missing. With neither readable, the manifest is reported as
 * unread rather than as a plugin that runs nothing (D6).
 */
export async function pluginRunCounts(
  installedDir: string,
  pinned: GitTreeSource | null,
): Promise<PluginRunCounts> {
  const runs = existsSync(installedDir)
    ? await pluginRunsOnDisk(installedDir)
    : await pinnedPluginRuns(pinned);
  return {
    hooks: runs.hooks.length,
    mcpServers: runs.mcpServers.length,
    unknown: runs.unknown,
  };
}

async function pinnedPluginRuns(
  pinned: GitTreeSource | null,
): Promise<PluginRuns> {
  const entries =
    pinned === null
      ? null
      : await itemTreeEntriesAtCommit(pinned, "plugins").catch(() => null);
  if (pinned === null || entries === null) {
    return {
      hooks: [],
      mcpServers: [],
      unknown: [unknownEntry(PLUGIN_MANIFEST_REL)],
    };
  }
  return await pluginRunsAtCommit(pinned.repo, entries);
}
