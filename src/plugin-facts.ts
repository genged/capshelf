/**
 * Every `unread` path is relative to the skill dir, not a fixed
 * `../../workflows/<f>`, because a manifest `skills` path can put a skill
 * anywhere in its plugin.
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
  refs: string[];
}

export interface UnreadFile {
  path: string;
  why: "over-1mb" | "budget";
}

export interface SkillPluginFacts {
  plugin: {
    name: string;
    source: string;
    catalogs: PluginCatalog[];
    ships: PluginPart[];
  };
  usesPluginParts: PluginPartUse[];
  factsComplete: boolean;
  unread: UnreadFile[];
  filesOutsideSkill: number;
}

function stripSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Ordinal order, not `localeCompare`, which sorts "extra.txt" before "SKILL.md"
 * and would read the wrong blob first against the budget.
 */
function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

const PLUGIN_ROOT_RE = /CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT/;
const INLINE_LINK_RE = /\]\(([^)]*)\)/g;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The fragment stays because it is part of the target as written, which is the
 * ref reported.
 */
function withoutTitle(raw: string): string {
  const target = raw.trim();
  return target.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
}

/**
 * Containment check only: a fragment never changes which directory a link
 * points at.
 */
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

const META =
  /export\s+const\s+meta\s*=\s*\{[\s\S]{0,2000}?\bname\s*:\s*(['"])([A-Za-z0-9_.:-]{1,100})\1/;

export function workflowMetaName(source: string): string | null {
  return META.exec(source)?.[2] ?? null;
}

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
  skillDirs: string[];
}

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

  const skillFilesByDir = new Map<string, GitTreeEntry[]>();
  const workflowFilesByPlugin = new Map<string, GitTreeEntry[]>();
  const candidates: CandidateBlob[] = [];
  // A skill dir can equal its plugin dir (manifest `skills: "./"`), so dedupe
  // by path to size and read each blob once against the budget.
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

  // Size every candidate in one `cat-file --batch-check` before reading,
  // because `catFileBlobs` buffers its whole output and skipping afterward
  // limits nothing.
  const sizes = await catFileSizes(
    repo,
    candidates.map((c) => c.object),
  );

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
      // Skip workflow paths under the skill's own dir: already counted above,
      // and they overlap when a skill dir equals its plugin dir.
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

      // Use an empty prefix for a root-sourced plugin so repository-root files
      // are counted rather than excluded.
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
