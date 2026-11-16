/**
 * The reader is conservative: anything it can't parse or list (unreadable
 * declarations, monitors, LSP, unlisted manifest keys) goes in `unknown` so the
 * consent gate never reports a false "no hooks".
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
 * Keys are allowlisted because they are inert or handled by this reader
 * (`hooks`, `mcpServers`). Other keys are unknown because future keys could
 * start a process.
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
  command: string | null;
  args: string[];
  url: string | null;
  source: string;
}

export interface PluginRuns {
  hooks: PluginRunHook[];
  mcpServers: PluginRunServer[];
  unknown: string[];
}

/** `content` is null for a symlink: reported as present, never read. */
export interface PluginExtraFile {
  path: string;
  content: Buffer | null;
}

export type PluginFileReader = (relPath: string) => Promise<Buffer | null>;

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

/**
 * One entry per source whatever the value holds: Claude Code reads these keys,
 * so even a malformed value can run a command.
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

async function collectDefaultFileUnknowns(
  read: PluginFileReader,
  unknown: string[],
): Promise<void> {
  if ((await read(MONITORS_DEFAULT_REL)) !== null) {
    unknown.push(MONITORS_FILE_UNKNOWN);
  }
  if ((await read(LSP_DEFAULT_REL)) !== null) unknown.push(LSP_FILE_UNKNOWN);
}

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
 * Args stay an array: joined with spaces, `["-c","a","; b"]` and `["-c","a ;
 * b"]` would collide, but only the second runs `b`.
 */
function serverIdentity(server: PluginRunServer): string {
  return JSON.stringify([server.name, server.command, server.args, server.url]);
}

export function serverCommandLine(server: PluginRunServer): string | null {
  if (server.command === null) return null;
  return shellCommand([server.command, ...server.args]);
}

/**
 * Every unknown entry of `next` is kept even if unchanged, since an unreadable
 * declaration can never be shown unchanged.
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
 * A null read can't distinguish an absent file from an unsafe one (symlink,
 * non-regular, symlinked ancestor), so flag unsafe declaration paths as
 * unknown.
 */
async function addUnsafeDeclarationUnknowns(
  runs: PluginRuns,
  declared: readonly string[],
  unsafeAt: (prefix: string, ancestor: boolean) => Promise<string[]>,
): Promise<void> {
  for (const relPath of declared) {
    const segments = relPath.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const unsafe = await unsafeAt(prefix, depth < segments.length);
      for (const path of unsafe) {
        const message = unknownEntry(path);
        if (!runs.unknown.includes(message)) runs.unknown.push(message);
      }
      if (unsafe.length > 0) break;
    }
  }
}

/**
 * Folds case and Unicode because a folding volume resolves `hooks/hooks.json`
 * through a kept `HOOKS` symlink.
 */
function foldedUnsafeEntries(
  unsafePaths: readonly string[],
): (prefix: string) => Promise<string[]> {
  return async (prefix) => {
    const key = foldedPath(prefix);
    return unsafePaths.filter((path) => foldedPath(path) === key);
  };
}

function hasUnsafeAncestorOnDisk(dir: string, relPath: string): boolean {
  const segments = relPath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const info = lstatOrNull(join(dir, ...segments.slice(0, depth)));
    if (info === null || info === undefined) return false;
    if (!info.isDirectory()) return true;
  }
  return false;
}

const FULL_FOLDING = { caseFolding: true, normalizationFolding: true };

function foldedPath(path: string): string {
  return destinationKey(path, FULL_FOLDING);
}

function declarationPaths(manifestBytes: Buffer | null): string[] {
  return [...DEFAULT_CANDIDATE_RELS, ...manifestNamedHookPaths(manifestBytes)];
}

/**
 * On a case- or normalization-insensitive volume Claude Code finds
 * `HOOKS/hooks.json` for `hooks/hooks.json`, so each present path that folds to
 * a declaration path but is not that exact path is one unknown entry.
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
 * Compare names folded so `HOOKS/hooks.json` is found even on a case-sensitive
 * volume, since a teammate's volume may fold it.
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
 * Checks each entry's mode itself rather than trusting that
 * `assertRegularBlobEntries` already refused symlinks and gitlinks, so a caller
 * building `entries` another way cannot make a non-regular blob read as absent.
 */
export async function pluginRunsAtCommit(
  repo: string,
  entries: readonly PinTreeEntry[],
  extras: readonly PluginExtraFile[] = [],
): Promise<PluginRuns> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  const extraByPath = new Map(
    extras.map((extra) => [extra.path, extra.content] as const),
  );
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
      ? (extraByPath.get(PLUGIN_MANIFEST_REL) ?? null)
      : (blobs.get(manifestEntry.blobId) ?? null);
  const declared = declarationPaths(manifestBytes);
  await fetchBlobsFor(declared);

  const reader: PluginFileReader = async (relPath) => {
    const entry = regularEntryAt(relPath);
    if (entry === undefined) return extraByPath.get(relPath) ?? null;
    if (!blobs.has(entry.blobId)) await fetchBlobsFor([relPath]);
    return blobs.get(entry.blobId) ?? null;
  };
  const runs = await readPluginRuns(reader);

  await addUnsafeDeclarationUnknowns(
    runs,
    declared,
    foldedUnsafeEntries([
      ...entries
        .filter((entry) => !isRegularBlobMode(entry.mode))
        .map((entry) => entry.path),
      ...extras
        .filter((extra) => extra.content === null)
        .map((extra) => extra.path),
    ]),
  );
  addCaseVariantUnknowns(runs, declared, [
    ...entries.map((entry) => entry.path),
    ...extras.map((extra) => extra.path),
  ]);
  return runs;
}

/**
 * The declaration reader refuses symlinks and non-regular files. Present unsafe
 * declaration paths still produce unknown entries to prevent false "no hooks"
 * results.
 */
export async function pluginRunsOnDisk(dir: string): Promise<PluginRuns> {
  const reader: PluginFileReader = async (relPath) => {
    if (hasUnsafeAncestorOnDisk(dir, relPath)) return null;
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

  const declared = declarationPaths(await reader(PLUGIN_MANIFEST_REL));
  // Every spelling that folds to the prefix, so a `HOOKS` symlink counts
  // for `hooks/hooks.json` on a case-sensitive volume too.
  await addUnsafeDeclarationUnknowns(runs, declared, async (prefix, ancestor) =>
    (await foldedMatchesOnDisk(dir, prefix)).filter((match) => {
      const info = lstatOrNull(join(dir, ...match.split("/")));
      if (info === null || info === undefined) return false;
      return ancestor ? !info.isDirectory() && !info.isFile() : !info.isFile();
    }),
  );
  const present: string[] = [];
  for (const relPath of declared) {
    present.push(...(await foldedMatchesOnDisk(dir, relPath)));
  }
  addCaseVariantUnknowns(runs, declared, present);
  return runs;
}

export interface PluginTreeFile {
  path: string;
  content: Buffer;
}

export async function pluginRunsFromFiles(
  files: readonly PluginTreeFile[],
  extras: readonly PluginExtraFile[] = [],
): Promise<PluginRuns> {
  const byPath = new Map<string, Buffer | null>([
    ...extras.map((extra) => [extra.path, extra.content] as const),
    ...files.map((file) => [file.path, file.content] as const),
  ]);
  const reader: PluginFileReader = async (relPath) =>
    byPath.get(relPath) ?? null;
  const runs = await readPluginRuns(reader);
  const declared = declarationPaths(byPath.get(PLUGIN_MANIFEST_REL) ?? null);
  await addUnsafeDeclarationUnknowns(
    runs,
    declared,
    foldedUnsafeEntries(
      [...byPath].filter(([, content]) => content === null).map(([p]) => p),
    ),
  );
  addCaseVariantUnknowns(runs, declared, [...byPath.keys()]);
  return runs;
}

const MANIFEST_KEY = foldedPath(PLUGIN_MANIFEST_REL);
const MANIFEST_ANCESTOR_KEYS = PLUGIN_MANIFEST_REL.split("/")
  .slice(0, -1)
  .map((_, index, segments) =>
    foldedPath(segments.slice(0, index + 1).join("/")),
  );

/**
 * Any entry at the manifest path, compared folded, makes the tree a plugin. So
 * does a non-regular entry at one of its ancestors, such as a `.claude-plugin`
 * symlink that Claude Code would follow.
 */
export function marksPluginManifest(path: string, regular: boolean): boolean {
  const key = foldedPath(path);
  return (
    key === MANIFEST_KEY || (!regular && MANIFEST_ANCESTOR_KEYS.includes(key))
  );
}

/**
 * A `plugins` item always needs plugin consent. A `skills` item needs it when
 * its tree holds `.claude-plugin/plugin.json`, because Claude Code loads that
 * folder as a plugin and runs its hooks. Any entry at that path counts,
 * including a non-regular one or a case or normalization variant that a folding
 * volume loads. An unsafe manifest therefore gets an unknown entry instead of
 * no question.
 */
async function carriesPluginManifest(
  kind: ItemKind,
  hasManifestEntry: () => Promise<boolean>,
): Promise<boolean> {
  if (kind === "plugins") return true;
  return kind === "skills" && (await hasManifestEntry());
}

/**
 * Consent sites ask this instead of checking for the `plugins` kind, because a
 * skill whose tree carries a plugin manifest is also a plugin to Claude Code.
 */
export async function itemPluginRunsAtCommit(
  repo: string,
  kind: ItemKind,
  entries: readonly PinTreeEntry[],
  extras: readonly PluginExtraFile[] = [],
): Promise<PluginRuns | null> {
  const isPlugin = await carriesPluginManifest(
    kind,
    async () =>
      entries.some((entry) =>
        marksPluginManifest(entry.path, isRegularBlobMode(entry.mode)),
      ) ||
      extras.some((extra) =>
        marksPluginManifest(extra.path, extra.content !== null),
      ),
  );
  return isPlugin ? await pluginRunsAtCommit(repo, entries, extras) : null;
}

export async function itemPluginRunsOnDisk(
  kind: ItemKind,
  dir: string,
): Promise<PluginRuns | null> {
  const isPlugin = await carriesPluginManifest(kind, async () => {
    if ((await foldedMatchesOnDisk(dir, PLUGIN_MANIFEST_REL)).length > 0) {
      return true;
    }
    // A `.claude-plugin` symlink, which `readdir` may not open, still marks a
    // plugin.
    const [ancestor = ""] = PLUGIN_MANIFEST_REL.split("/");
    return (await foldedMatchesOnDisk(dir, ancestor)).some((match) => {
      const info = lstatOrNull(join(dir, ...match.split("/")));
      return info !== null && info !== undefined && !info.isDirectory();
    });
  });
  return isPlugin ? await pluginRunsOnDisk(dir) : null;
}

export async function itemPluginRunsFromFiles(
  kind: ItemKind,
  files: readonly PluginTreeFile[],
  extras: readonly PluginExtraFile[] = [],
): Promise<PluginRuns | null> {
  const isPlugin = await carriesPluginManifest(
    kind,
    async () =>
      files.some((file) => marksPluginManifest(file.path, true)) ||
      extras.some((extra) =>
        marksPluginManifest(extra.path, extra.content !== null),
      ),
  );
  return isPlugin ? await pluginRunsFromFiles(files, extras) : null;
}

export function pluginExtraFile(entry: {
  path: string;
  kind: "file" | "symlink";
  content?: Buffer;
}): PluginExtraFile {
  return {
    path: entry.path,
    content: entry.kind === "file" ? (entry.content ?? null) : null,
  };
}

/**
 * A tree that was not a plugin before counts as running nothing, so all its
 * entries are new. Kept local files are read on both sides, so an unchanged one
 * adds no hook or server. A hook that a kept local manifest newly arms is new.
 */
export async function itemPluginNewRuns(
  repo: string,
  kind: ItemKind,
  before: readonly PinTreeEntry[],
  after: readonly PinTreeEntry[],
  extras: readonly PluginExtraFile[] = [],
): Promise<PluginRuns | null> {
  const next = await itemPluginRunsAtCommit(repo, kind, after, extras);
  if (next === null) return null;
  const previous = (await itemPluginRunsAtCommit(
    repo,
    kind,
    before,
    extras,
  )) ?? {
    hooks: [],
    mcpServers: [],
    unknown: [],
  };
  return newRunsEntries(previous, next);
}

export interface PluginRunCounts {
  hooks: number;
  mcpServers: number;
  unknown: string[];
}

/**
 * Use the installed tree because it is what Claude Code loads after drift.
 * Read the pinned tree only when the installed directory is absent. If that
 * tree cannot be read, report an unknown manifest rather than no runs.
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
