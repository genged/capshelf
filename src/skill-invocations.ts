/**
 * Counts skill invocations from the Claude Code transcripts already on disk.
 * Claude Code writes them; capshelf only reads them and keeps a small cache of
 * what it found, so a second read parses only the bytes appended since.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";

export interface SkillInvocations {
  count: number;
  byAgent: number;
  byUser: number;
  /** Time of the newest invocation, or null when there is none. */
  last: string | null;
  /** Time of the oldest transcript record for the project. */
  since: string;
}

export interface ProjectSkillInvocations {
  since: string;
  bySkill: Map<string, Omit<SkillInvocations, "since">>;
}

export interface SkillInvocationReader {
  read(project: string): Promise<ProjectSkillInvocations | null>;
}

export function invocationsForSkill(
  facts: ProjectSkillInvocations,
  name: string,
): SkillInvocations {
  const found = facts.bySkill.get(name);
  return {
    count: found?.count ?? 0,
    byAgent: found?.byAgent ?? 0,
    byUser: found?.byUser ?? 0,
    last: found?.last ?? null,
    since: facts.since,
  };
}

/** Claude Code keeps transcripts under `$CLAUDE_CONFIG_DIR/projects`. */
export function claudeProjectsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  const base =
    configured && configured.trim().length > 0
      ? configured
      : join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Claude Code names a project folder after the session's working folder: each
 * character outside `[a-zA-Z0-9]` becomes `-`. A name over 200 characters is
 * cut to 200 and gets a hash suffix, which `transcriptDirs` matches by prefix.
 */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

const CLAUDE_DIR_NAME_LIMIT = 200;

export function skillInvocationCacheDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.XDG_CACHE_HOME;
  const base =
    configured && configured.trim().length > 0
      ? configured
      : join(homedir(), ".cache");
  return join(base, PRODUCT_NAME, "skill-invocations");
}

const InvocationEventSchema = z.object({
  t: z.string(),
  s: z.string(),
  b: z.enum(["agent", "user"]),
  c: z.string(),
  i: z.string().optional(),
});
type InvocationEvent = z.infer<typeof InvocationEventSchema>;

const FileEntrySchema = z.object({
  ino: z.number(),
  size: z.number(),
  mtimeMs: z.number(),
  offset: z.number(),
  since: z.string().nullable(),
  cwd: z.string().nullable(),
  events: z.array(InvocationEventSchema),
});
type FileEntry = z.infer<typeof FileEntrySchema>;

const CACHE_VERSION = 1;
const CacheSchema = z.object({
  v: z.literal(CACHE_VERSION),
  files: z.record(z.string(), FileEntrySchema),
});
type DirCache = z.infer<typeof CacheSchema>;

const ToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.literal("Skill"),
  input: z.object({ skill: z.string().min(1) }),
});

const AssistantRecordSchema = z.object({
  type: z.literal("assistant"),
  timestamp: z.string(),
  cwd: z.string(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const UserRecordSchema = z.object({
  type: z.literal("user"),
  timestamp: z.string(),
  cwd: z.string(),
  isMeta: z.boolean().optional(),
  message: z.object({ content: z.string() }),
});

const HeaderRecordSchema = z.object({
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
});

/** A typed slash command is recorded as a user message in this form. */
const COMMAND_MESSAGE_PREFIX = "<command-message>";
const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/;
const MARKERS = ['"name":"Skill"', "<command-name>"];
const HEADER_LINE_LIMIT = 50;

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function eventsFromRecord(value: unknown): InvocationEvent[] {
  const assistant = AssistantRecordSchema.safeParse(value);
  if (assistant.success) {
    const out: InvocationEvent[] = [];
    for (const item of assistant.data.message.content) {
      const use = ToolUseSchema.safeParse(item);
      if (!use.success) continue;
      out.push({
        t: assistant.data.timestamp,
        s: use.data.input.skill,
        b: "agent",
        c: assistant.data.cwd,
        i: use.data.id,
      });
    }
    return out;
  }
  const user = UserRecordSchema.safeParse(value);
  if (
    !user.success ||
    user.data.isMeta === true ||
    !user.data.message.content.startsWith(COMMAND_MESSAGE_PREFIX)
  ) {
    return [];
  }
  const name = COMMAND_NAME.exec(user.data.message.content)?.[1];
  return name === undefined
    ? []
    : [{ t: user.data.timestamp, s: name, b: "user", c: user.data.cwd }];
}

/**
 * Only lines that hold a marker are parsed, so a large transcript costs one
 * substring scan, not one JSON parse per line.
 */
function markerLines(text: string): string[] {
  const starts = new Set<number>();
  for (const marker of MARKERS) {
    for (
      let at = text.indexOf(marker);
      at !== -1;
      at = text.indexOf(marker, at + marker.length)
    ) {
      starts.add(text.lastIndexOf("\n", at) + 1);
    }
  }
  return [...starts]
    .sort((a, b) => a - b)
    .map((start) => {
      const end = text.indexOf("\n", start);
      return text.slice(start, end === -1 ? undefined : end);
    });
}

function readHeader(text: string, entry: FileEntry): void {
  let start = 0;
  for (
    let line = 0;
    line < HEADER_LINE_LIMIT &&
    start < text.length &&
    (entry.since === null || entry.cwd === null);
    line++
  ) {
    const end = text.indexOf("\n", start);
    const header = HeaderRecordSchema.safeParse(
      parseJsonLine(text.slice(start, end === -1 ? undefined : end)),
    );
    if (header.success) {
      entry.since ??= header.data.timestamp ?? null;
      entry.cwd ??= header.data.cwd ?? null;
    }
    if (end === -1) break;
    start = end + 1;
  }
}

async function readRange(
  path: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function scanFile(
  path: string,
  previous: FileEntry | undefined,
): Promise<FileEntry> {
  const info = await stat(path);
  if (
    previous !== undefined &&
    previous.ino === info.ino &&
    previous.size === info.size &&
    previous.mtimeMs === info.mtimeMs
  ) {
    return previous;
  }
  // A replaced or shortened file is parsed again from the start.
  const resume =
    previous !== undefined &&
    previous.ino === info.ino &&
    info.size >= previous.offset;
  const entry: FileEntry = resume
    ? { ...previous, events: [...previous.events] }
    : {
        ino: info.ino,
        size: 0,
        mtimeMs: 0,
        offset: 0,
        since: null,
        cwd: null,
        events: [],
      };
  entry.size = info.size;
  entry.mtimeMs = info.mtimeMs;
  const bytes = await readRange(path, entry.offset, info.size);
  // A line that Claude Code is still writing waits for the next read.
  const complete = bytes.lastIndexOf(0x0a) + 1;
  if (complete === 0) return entry;
  const text = bytes.subarray(0, complete).toString("utf8");
  entry.offset += complete;
  if (entry.since === null || entry.cwd === null) readHeader(text, entry);
  const seen = new Set(entry.events.flatMap((event) => event.i ?? []));
  for (const line of markerLines(text)) {
    for (const event of eventsFromRecord(parseJsonLine(line))) {
      if (event.i !== undefined) {
        if (seen.has(event.i)) continue;
        seen.add(event.i);
      }
      entry.events.push(event);
    }
  }
  return entry;
}

/** Session transcripts and their subagent transcripts. */
async function transcriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(entry.name);
    } else if (entry.isDirectory()) {
      const subagents = join(dir, entry.name, "subagents");
      if (!existsSync(subagents)) continue;
      for (const sub of await readdir(subagents, { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith(".jsonl")) {
          out.push(`${entry.name}/subagents/${sub.name}`);
        }
      }
    }
  }
  return out.sort();
}

function projectRoots(project: string): string[] {
  const roots = new Set([project]);
  try {
    roots.add(realpathSync(project));
  } catch {
    // An unreadable root still matches by its given path.
  }
  return [...roots];
}

function dirMatchesRoot(name: string, root: string): boolean {
  const encoded = claudeProjectDirName(root);
  if (encoded.length > CLAUDE_DIR_NAME_LIMIT) {
    return name.startsWith(encoded.slice(0, CLAUDE_DIR_NAME_LIMIT));
  }
  // A session in a subfolder or a worktree of the project has a longer name.
  return name === encoded || name.startsWith(`${encoded}-`);
}

function cwdInRoots(cwd: string, roots: string[]): boolean {
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

async function transcriptDirs(
  projectsDir: string,
  roots: string[],
): Promise<string[]> {
  if (!existsSync(projectsDir)) return [];
  const entries = await readdir(projectsDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        roots.some((root) => dirMatchesRoot(entry.name, root)),
    )
    .map((entry) => entry.name)
    .sort();
}

function emptyCache(): DirCache {
  return { v: CACHE_VERSION, files: {} };
}

function cacheFileName(dirName: string): string {
  return `${createHash("sha256").update(dirName).digest("hex").slice(0, 16)}.json`;
}

async function loadDiskCache(path: string): Promise<DirCache> {
  try {
    const parsed = CacheSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return parsed.success ? parsed.data : emptyCache();
  } catch {
    return emptyCache();
  }
}

async function refreshDir(
  dir: string,
  previous: DirCache,
): Promise<{ cache: DirCache; changed: boolean }> {
  const next = emptyCache();
  let changed = false;
  const files = await transcriptFiles(dir);
  for (const rel of files) {
    const before = previous.files[rel];
    try {
      const after = await scanFile(join(dir, rel), before);
      next.files[rel] = after;
      if (after !== before) changed = true;
    } catch {
      // A transcript that vanished between the listing and the read is gone.
      changed = true;
    }
  }
  // Drop the facts of a transcript that Claude Code deleted, so the cache never
  // keeps more history than the transcripts do.
  if (Object.keys(previous.files).some((rel) => !(rel in next.files))) {
    changed = true;
  }
  return { cache: next, changed };
}

function summarize(
  caches: DirCache[],
  roots: string[],
): ProjectSkillInvocations | null {
  let since: string | null = null;
  const bySkill = new Map<string, Omit<SkillInvocations, "since">>();
  for (const cache of caches) {
    for (const entry of Object.values(cache.files)) {
      if (
        entry.since !== null &&
        entry.cwd !== null &&
        cwdInRoots(entry.cwd, roots) &&
        (since === null || entry.since < since)
      ) {
        since = entry.since;
      }
      for (const event of entry.events) {
        if (!cwdInRoots(event.c, roots)) continue;
        const current = bySkill.get(event.s) ?? {
          count: 0,
          byAgent: 0,
          byUser: 0,
          last: null,
        };
        current.count += 1;
        if (event.b === "agent") current.byAgent += 1;
        else current.byUser += 1;
        if (current.last === null || event.t > current.last) {
          current.last = event.t;
        }
        bySkill.set(event.s, current);
      }
    }
  }
  return since === null ? null : { since, bySkill };
}

export interface SkillInvocationReaderOptions {
  env?: Record<string, string | undefined>;
  /**
   * "disk" saves the cache under `$XDG_CACHE_HOME/capshelf`. "memory" reads
   * that cache but writes nothing, which the web UI needs.
   */
  persist: "disk" | "memory";
}

export function createSkillInvocationReader(
  options: SkillInvocationReaderOptions,
): SkillInvocationReader {
  const env = options.env ?? process.env;
  const memory = new Map<string, DirCache>();
  return {
    async read(project) {
      try {
        const projectsDir = claudeProjectsDir(env);
        const roots = projectRoots(project);
        const dirs = await transcriptDirs(projectsDir, roots);
        if (dirs.length === 0) return null;
        const cacheDir = skillInvocationCacheDir(env);
        const caches: DirCache[] = [];
        for (const name of dirs) {
          const cachePath = join(cacheDir, cacheFileName(name));
          const previous = memory.get(name) ?? (await loadDiskCache(cachePath));
          const { cache, changed } = await refreshDir(
            join(projectsDir, name),
            previous,
          );
          memory.set(name, cache);
          caches.push(cache);
          if (changed && options.persist === "disk") {
            await saveDiskCache(cachePath, cache);
          }
        }
        return summarize(caches, roots);
      } catch {
        // Usage facts are optional, so an unreadable transcript folder never
        // fails status.
        return null;
      }
    },
  };
}

async function saveDiskCache(path: string, cache: DirCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWriteFile(path, JSON.stringify(cache), {
      exempt: "the skill invocation cache lives in the user cache folder",
    });
  } catch {
    // The cache only saves time. A failed write must not affect status.
  }
}
