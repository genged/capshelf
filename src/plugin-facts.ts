/**
 * What a plugin skill uses outside its own directory, read at one commit.
 *
 * Four text checks run over the skill's own files: a plugin-root variable, a
 * namespaced agent or workflow reference, and a Markdown link that escapes
 * the skill directory. The checks are pure (`scanSkillFiles`); everything
 * else here is the read plan that decides which blobs are safe to read and
 * assembles one `SkillPluginFacts` per skill directory.
 *
 * Rule numbers in comments refer to the task brief; `D<n>` refers to the
 * design's numbered decisions. Ruling D (controller): every `unread` path is
 * `posix.relative(skillDir, blobPath)`, not the literal `../../workflows/<f>`
 * the brief first wrote — that literal is only correct for a skill at
 * `<plugin>/skills/<x>`, and a manifest `skills` path can put a skill
 * anywhere inside its plugin (`src/plugin-discovery.ts` rule 7).
 */
import { posix } from "node:path";
import { catFileBlobs, catFileSizes } from "./git";
import type { GitTreeEntry } from "./git";
import { isRegularFile, lastSegment, pluginPath } from "./plugin-discovery";
import type {
  DiscoveredPlugin,
  PluginCatalog,
  PluginPart,
} from "./plugin-discovery";

export const MAX_FACT_BLOB_BYTES = 1_000_000;
export const FACT_READ_BUDGET_BYTES = 32_000_000;

export type PluginFactReason =
  | "plugin-root"
  | "plugin-agents"
  | "plugin-workflows"
  | "outside-links";

export interface PluginPartUse {
  reason: PluginFactReason;
  /** Sorted A to Z, unique. */
  refs: string[];
}

export interface UnreadFile {
  /** Path relative to the skill directory. */
  path: string;
  why: "over-1mb" | "budget";
}

/** One type for every plugin fact of one skill, by the spec's "keep them in one type". */
export interface SkillPluginFacts {
  plugin: {
    name: string;
    source: string;
    catalogs: PluginCatalog[];
    ships: PluginPart[];
  };
  /** In PluginFactReason order above. Empty when nothing matched. */
  usesPluginParts: PluginPartUse[];
  factsComplete: boolean;
  unread: UnreadFile[];
  /** Blob count under the plugin directory and outside the skill directory. */
  filesOutsideSkill: number;
}

function stripSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Ordinal path order, not locale-aware: `localeCompare` sorts "extra.txt"
 * before "SKILL.md", which would read the wrong blob first against the
 * budget. */
function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ------------------------------------------------------------ scanSkillFiles

const PLUGIN_ROOT_RE = /CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT/;
/** A Markdown inline (or image) link's target: whatever sits between `](` and `)`. */
const INLINE_LINK_RE = /\]\(([^)]*)\)/g;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Trim, and drop a trailing `"title"` (or `'title'`). The fragment stays —
 * it is part of the target as written, the ref this check reports. */
function withoutTitle(raw: string): string {
  const target = raw.trim();
  return target.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
}

/** Drop a trailing `#fragment`, for the containment check only — a fragment
 * never changes which directory a link points at. */
function withoutFragment(target: string): string {
  const hashIndex = target.indexOf("#");
  return hashIndex === -1 ? target : target.slice(0, hashIndex);
}

function outsideLinksIn(filePath: string, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(INLINE_LINK_RE)) {
    const raw = match[1] ?? "";
    const ref = withoutTitle(raw);
    const containment = withoutFragment(ref);
    if (containment === "" || !containment.includes("../")) continue;
    if (URL_SCHEME_RE.test(containment)) continue;
    const joined = posix.normalize(
      posix.join(posix.dirname(filePath), containment),
    );
    if (joined === ".." || joined.startsWith("../")) found.push(ref);
  }
  return found;
}

/** Pure. The four checks over text already read. */
export function scanSkillFiles(input: {
  skillDir: string;
  pluginName: string;
  agentNames: readonly string[];
  workflowNames: readonly string[];
  files: ReadonlyArray<{ path: string; text: string }>;
}): PluginPartUse[] {
  const selfName = lastSegment(input.skillDir);
  const pluginRootRefs = new Set<string>();
  const outsideLinkRefs = new Set<string>();
  for (const file of input.files) {
    if (PLUGIN_ROOT_RE.test(file.text)) pluginRootRefs.add(file.path);
    for (const link of outsideLinksIn(file.path, file.text)) {
      outsideLinkRefs.add(link);
    }
  }

  const agentRefs = new Set<string>();
  for (const agent of input.agentNames) {
    if (agent === selfName) continue;
    const marker = `${input.pluginName}:${agent}`;
    const backticked = `\`${agent}\``;
    if (
      input.files.some(
        (file) => file.text.includes(marker) || file.text.includes(backticked),
      )
    ) {
      agentRefs.add(agent);
    }
  }

  const workflowRefs = new Set<string>();
  for (const workflow of input.workflowNames) {
    if (workflow === selfName) continue;
    const marker = `${input.pluginName}:${workflow}`;
    if (input.files.some((file) => file.text.includes(marker))) {
      workflowRefs.add(workflow);
    }
  }

  const uses: PluginPartUse[] = [];
  if (pluginRootRefs.size > 0) {
    uses.push({ reason: "plugin-root", refs: sortedUnique(pluginRootRefs) });
  }
  if (agentRefs.size > 0) {
    uses.push({ reason: "plugin-agents", refs: sortedUnique(agentRefs) });
  }
  if (workflowRefs.size > 0) {
    uses.push({
      reason: "plugin-workflows",
      refs: sortedUnique(workflowRefs),
    });
  }
  if (outsideLinkRefs.size > 0) {
    uses.push({
      reason: "outside-links",
      refs: sortedUnique(outsideLinkRefs),
    });
  }
  return uses;
}

// ----------------------------------------------------------- workflowMetaName

const META =
  /export\s+const\s+meta\s*=\s*\{[\s\S]{0,2000}?\bname\s*:\s*(['"])([A-Za-z0-9_.:-]{1,100})\1/;

/** Pure. The first `name:` inside `export const meta = {`, or null. */
export function workflowMetaName(source: string): string | null {
  return META.exec(source)?.[2] ?? null;
}

// --------------------------------------------------------- collectPluginFacts

function regularFilesUnder(
  entries: readonly GitTreeEntry[],
  dir: string,
): GitTreeEntry[] {
  const prefix = `${dir}/`;
  return entries.filter((e) => isRegularFile(e) && e.path.startsWith(prefix));
}

function directRegularChildren(
  entries: readonly GitTreeEntry[],
  dir: string,
): GitTreeEntry[] {
  const prefix = `${dir}/`;
  return entries.filter((e) => {
    if (!isRegularFile(e) || !e.path.startsWith(prefix)) return false;
    return !e.path.slice(prefix.length).includes("/");
  });
}

interface CandidateBlob {
  path: string;
  object: string;
}

interface PluginWork {
  plugin: DiscoveredPlugin;
  /** This plugin's skill directories that facts were asked for. */
  skillDirs: string[];
}

/**
 * Facts for each skill directory of each plugin, keyed by skill directory.
 *
 * Calls `collectPluginFactsWithLimits` with the module's own budget
 * constants; a test reaches the same read plan with smaller limits.
 */
export async function collectPluginFacts(
  repo: string,
  entries: readonly GitTreeEntry[],
  plugins: readonly DiscoveredPlugin[],
  onlySkillDirs?: ReadonlySet<string>,
): Promise<Map<string, SkillPluginFacts>> {
  return await collectPluginFactsWithLimits(
    repo,
    entries,
    plugins,
    onlySkillDirs,
    {
      maxBlob: MAX_FACT_BLOB_BYTES,
      budget: FACT_READ_BUDGET_BYTES,
    },
  );
}

export async function collectPluginFactsWithLimits(
  repo: string,
  entries: readonly GitTreeEntry[],
  plugins: readonly DiscoveredPlugin[],
  onlySkillDirs: ReadonlySet<string> | undefined,
  limits: { maxBlob: number; budget: number },
): Promise<Map<string, SkillPluginFacts>> {
  const work: PluginWork[] = [];
  for (const plugin of plugins) {
    const skillDirs =
      onlySkillDirs === undefined
        ? plugin.skillDirs
        : plugin.skillDirs.filter((dir) => onlySkillDirs.has(dir));
    if (skillDirs.length > 0) work.push({ plugin, skillDirs });
  }
  if (work.length === 0) return new Map();

  // Read budget, rule 1: every regular blob under a wanted skill directory,
  // plus each plugin's workflow scripts (read once, to resolve a meta name).
  const skillFilesByDir = new Map<string, GitTreeEntry[]>();
  const workflowFilesByPlugin = new Map<string, GitTreeEntry[]>();
  const candidates: CandidateBlob[] = [];
  // A skill directory can equal its plugin directory (manifest `skills:
  // "./"`), which puts a workflow blob under both a wanted skill directory
  // and the plugin's `workflows/` — one path, two pushes below. Dedupe by
  // path so it is sized and read once, not twice against the budget.
  const candidatePaths = new Set<string>();
  function pushCandidate(entry: GitTreeEntry): void {
    if (candidatePaths.has(entry.path)) return;
    candidatePaths.add(entry.path);
    candidates.push({ path: entry.path, object: entry.object });
  }
  for (const { plugin, skillDirs } of work) {
    for (const dir of skillDirs) {
      const files = regularFilesUnder(entries, dir);
      skillFilesByDir.set(dir, files);
      for (const file of files) pushCandidate(file);
    }
    if (!workflowFilesByPlugin.has(plugin.source)) {
      const workflowFiles = directRegularChildren(
        entries,
        pluginPath(plugin.source, "workflows"),
      ).filter((e) => e.path.endsWith(".js"));
      workflowFilesByPlugin.set(plugin.source, workflowFiles);
      for (const file of workflowFiles) pushCandidate(file);
    }
  }

  // Rule 2: one `cat-file --batch-check` call for every candidate.
  const sizes = await catFileSizes(
    repo,
    candidates.map((c) => c.object),
  );

  // Rule 3: sorted by path, skip over-size, then stop at the read budget.
  const sorted = [...candidates].sort(byPath);
  const unreadByPath = new Map<string, "over-1mb" | "budget">();
  const keptIds: string[] = [];
  let total = 0;
  let overBudget = false;
  for (const candidate of sorted) {
    const size = sizes.get(candidate.object) ?? 0;
    if (overBudget) {
      unreadByPath.set(candidate.path, "budget");
      continue;
    }
    if (size > limits.maxBlob) {
      unreadByPath.set(candidate.path, "over-1mb");
      continue;
    }
    if (total + size > limits.budget) {
      unreadByPath.set(candidate.path, "budget");
      overBudget = true;
      continue;
    }
    total += size;
    keptIds.push(candidate.object);
  }

  // Rule 4: one `cat-file --batch` call for the kept blobs. A NUL blob is
  // skipped silently — it does not make the facts incomplete.
  const blobs = await catFileBlobs(repo, keptIds);
  const textByPath = new Map<string, string>();
  for (const candidate of candidates) {
    const bytes = blobs.get(candidate.object);
    if (bytes === undefined) continue;
    if (bytes.includes(0)) continue;
    textByPath.set(candidate.path, bytes.toString("utf8"));
  }

  const result = new Map<string, SkillPluginFacts>();
  for (const { plugin, skillDirs } of work) {
    const agentNames = sortedUnique(
      directRegularChildren(entries, pluginPath(plugin.source, "agents"))
        .filter((e) => e.path.endsWith(".md"))
        .map((e) => stripSuffix(posix.basename(e.path), ".md")),
    );

    const workflowFiles = workflowFilesByPlugin.get(plugin.source) ?? [];
    const workflowNames = new Set<string>();
    const unreadWorkflowPaths: string[] = [];
    for (const file of workflowFiles) {
      const stem = stripSuffix(posix.basename(file.path), ".js");
      workflowNames.add(stem);
      const text = textByPath.get(file.path);
      if (text !== undefined) {
        const metaName = workflowMetaName(text);
        if (metaName !== null && metaName !== stem) workflowNames.add(metaName);
        continue;
      }
      if (unreadByPath.has(file.path)) unreadWorkflowPaths.push(file.path);
    }

    const pluginSummary = {
      name: plugin.name,
      source: plugin.source,
      catalogs: [...plugin.catalogs],
      ships: [...plugin.ships],
    };

    for (const skillDir of skillDirs) {
      const skillFiles = skillFilesByDir.get(skillDir) ?? [];
      const files: Array<{ path: string; text: string }> = [];
      const unread: UnreadFile[] = [];
      for (const entry of skillFiles) {
        const relPath = posix.relative(skillDir, entry.path);
        const text = textByPath.get(entry.path);
        if (text !== undefined) {
          files.push({ path: relPath, text });
          continue;
        }
        const why = unreadByPath.get(entry.path);
        if (why !== undefined) unread.push({ path: relPath, why });
      }
      // Rule 5: an unread workflow file makes every skill of this plugin
      // incomplete too (Ruling D for the path). Skip one already under this
      // skill's own directory — the loop above already counted it, and a
      // skill directory can equal its plugin directory (manifest `skills:
      // "./"`), which puts a workflow blob under both.
      const skillPrefix = `${skillDir}/`;
      for (const workflowPath of unreadWorkflowPaths) {
        if (workflowPath.startsWith(skillPrefix)) continue;
        const why = unreadByPath.get(workflowPath);
        if (why === undefined) continue;
        unread.push({ path: posix.relative(skillDir, workflowPath), why });
      }
      unread.sort(byPath);

      const usesPluginParts = scanSkillFiles({
        skillDir,
        pluginName: plugin.name,
        agentNames,
        workflowNames: [...workflowNames],
        files,
      });

      // Rule 6: every blob under the plugin directory that is not under this
      // skill's own directory, read or not. `pluginPath(plugin.source, "")`
      // is the plugin's own prefix form: "" for the repository root, so a
      // root-sourced plugin (source ".") would still count every entry as
      // "under" it instead of none.
      const pluginPrefix = pluginPath(plugin.source, "");
      const filesOutsideSkill = entries.filter(
        (e) =>
          isRegularFile(e) &&
          e.path.startsWith(pluginPrefix) &&
          !e.path.startsWith(skillPrefix),
      ).length;

      result.set(skillDir, {
        plugin: pluginSummary,
        usesPluginParts,
        factsComplete: unread.length === 0,
        unread,
        filesOutsideSkill,
      });
    }
  }
  return result;
}
