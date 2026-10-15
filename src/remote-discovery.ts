/**
 * What a repository outside the shelf offers, read at one commit.
 *
 * Everything here reads through `ls-tree` and `cat-file` at a resolved commit.
 * The cache clone has a working tree because `git clone` makes one; nothing may
 * depend on it, because its checkout is an artifact of the clone rather than a
 * fact about the commit a pin names.
 *
 * Ambiguity is never resolved by guessing, by D17. A repository holding a root
 * `SKILL.md` **and** subdirectory skills offers both, and the caller lists or
 * picks.
 */
import { basename, posix } from "node:path";
import { isSafeItemName, isSafeItemRoot } from "./assert";
import { PreconditionError } from "./errors";
import {
  catFileBlobs,
  literalPathspec,
  lsTreeEntriesForPathspecs,
} from "./git";
import type { GitTreeEntry } from "./git";
import type { GitTreeSource } from "./item-source";
import { extractFrontmatter, parseFrontmatter } from "./metadata";
import { itemTreeEntriesAtCommit } from "./pin";
import { collectPluginFacts } from "./plugin-facts";
import type { SkillPluginFacts } from "./plugin-facts";
import {
  describePluginDirectory,
  discoverPlugins,
  hasPluginManifest,
  isRegularFile,
} from "./plugin-discovery";
import type {
  DiscoveredPlugin,
  DiscoveryWarning,
  SkippedEntry,
} from "./plugin-discovery";

const SKILL_FILE = "SKILL.md";

/** Where a candidate came from, and the precedence when two rules agree. */
export type RemoteCandidateOrigin =
  | "root"
  | "skills"
  | "claude"
  | "agents"
  | "marketplace";

const ORIGIN_PRECEDENCE: RemoteCandidateOrigin[] = [
  "root",
  "skills",
  "claude",
  "agents",
  "marketplace",
];

/** The three directories a repository publishes skills under. */
const SKILL_PARENTS: ReadonlyArray<{
  prefix: string;
  origin: RemoteCandidateOrigin;
}> = [
  { prefix: "skills", origin: "skills" },
  { prefix: ".claude/skills", origin: "claude" },
  { prefix: ".agents/skills", origin: "agents" },
];

export interface RemoteSkillCandidate {
  /** Repository-relative item root. `"."` means the repository root. */
  subpath: string;
  /** The default item name: the directory name, or the repo name at the root. */
  defaultName: string;
  /** The SKILL.md `description` frontmatter value, when it parses. */
  description: string | null;
  /** Where the candidate came from, for the `--list` heading. */
  origin: RemoteCandidateOrigin;
  /** Set when this candidate is a skill directory of a plugin. */
  plugin?: SkillPluginFacts;
}

export interface RemoteDiscovery {
  candidates: RemoteSkillCandidate[];
  plugins: DiscoveredPlugin[];
  skipped: SkippedEntry[];
  /** A10: a catalog or manifest document that is present and does not parse. */
  warnings: DiscoveryWarning[];
}

/** Every candidate at `commit`, sorted by subpath. Reads only through ls-tree. */
export async function discoverRemoteSkills(
  repo: string,
  commit: string,
  repoName?: string,
): Promise<RemoteDiscovery> {
  // One `ls-tree -r` over the whole tree, then everything in memory. An empty
  // pathspec list would return before running Git at all, so discovery would
  // find nothing and report no error.
  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec("."),
  ]);
  const skillDirs = skillDirectories(entries);
  const found = new Map<string, RemoteCandidateOrigin>();
  for (const dir of skillDirs) {
    const origin = layoutOriginOf(dir);
    if (origin !== null) found.set(dir, origin);
  }

  const inventory = await discoverPlugins(repo, commit, entries);

  // D2: today's rule for an entry with a `skills` array, or `source: "./"`.
  for (const dir of inventory.legacySkillDirs) {
    if (!skillDirs.has(dir)) continue;
    if (!found.has(dir)) found.set(dir, "marketplace");
  }

  // Discovery rule 7: a directory a layout rule already found keeps that
  // origin and still gets plugin facts below.
  const pluginSkillDirs = new Set<string>();
  for (const plugin of inventory.plugins) {
    for (const dir of plugin.skillDirs) {
      pluginSkillDirs.add(dir);
      if (!found.has(dir)) found.set(dir, "marketplace");
    }
  }

  const candidates = await describeCandidates(
    repo,
    commit,
    [...found.entries()]
      .map(([subpath, origin]) => ({
        subpath,
        origin,
        defaultName: defaultNameFor(subpath, repo, repoName),
      }))
      .filter((candidate) => isSafeItemName(candidate.defaultName)),
  );

  if (pluginSkillDirs.size > 0) {
    const facts = await collectPluginFacts(
      repo,
      entries,
      inventory.plugins,
      pluginSkillDirs,
    );
    for (const candidate of candidates) {
      const fact = facts.get(candidate.subpath);
      if (fact !== undefined) candidate.plugin = fact;
    }
  }

  return {
    candidates,
    plugins: inventory.plugins,
    skipped: inventory.skipped,
    warnings: inventory.warnings,
  };
}

/** One candidate at an explicit subpath, or a refusal naming the path read. */
export async function candidateAtSubpath(
  repo: string,
  commit: string,
  subpath: string,
  repoName?: string,
): Promise<RemoteSkillCandidate> {
  if (!isSafeItemRoot(subpath)) {
    throw new PreconditionError(
      `the subpath leaves the repository: ${subpath}`,
      { hint: "name a directory inside the repository, without `..`" },
    );
  }
  const skillPath = itemFilePath(subpath, SKILL_FILE);
  const skillEntries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec(skillPath),
  ]);
  // D14: a symlinked or gitlinked SKILL.md is "no SKILL.md".
  const skillEntry = skillEntries.find((entry) => entry.path === skillPath);
  if (skillEntry === undefined || !isRegularFile(skillEntry)) {
    throw new PreconditionError(
      `no ${SKILL_FILE} at ${skillPath} in that repository at ${commit}`,
      {
        hint: "list what the repository offers: capshelf add <url> --list",
      },
    );
  }
  const defaultName = defaultNameFor(subpath, repo, repoName);
  if (!isSafeItemName(defaultName)) {
    throw new PreconditionError(
      `${subpath} would install under an unusable item name: ${defaultName}`,
      { hint: "choose one with --as <name>" },
    );
  }
  const described = await describeCandidates(repo, commit, [
    { subpath, defaultName, origin: layoutOriginOf(subpath) ?? "marketplace" },
  ]);
  const candidate = described[0];
  if (candidate === undefined) {
    throw new PreconditionError(`no ${SKILL_FILE} at ${skillPath}`);
  }

  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec("."),
  ]);
  const plugin = await pluginOwningSkillDir(repo, commit, entries, subpath);
  if (plugin !== null) {
    const facts = await collectPluginFacts(
      repo,
      entries,
      [plugin],
      new Set([subpath]),
    );
    const fact = facts.get(subpath);
    if (fact !== undefined) candidate.plugin = fact;
  }
  return candidate;
}

/**
 * D10 and D5: the plugin whose source equals `subpath`, with candidates for
 * its skills and their facts. Null when `subpath` names no plugin at all,
 * cataloged or manifest-only.
 */
export async function pluginAtSubpath(
  repo: string,
  commit: string,
  subpath: string,
  repoName?: string,
): Promise<{
  plugin: DiscoveredPlugin;
  candidates: RemoteSkillCandidate[];
} | null> {
  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec("."),
  ]);
  const inventory = await discoverPlugins(repo, commit, entries);
  let plugin = inventory.plugins.find((p) => p.source === subpath);
  if (plugin === undefined) {
    if (!hasPluginManifest(entries, subpath)) return null;
    plugin = (await describePluginDirectory(repo, entries, subpath, {}, []))
      .plugin;
  }

  const facts = await collectPluginFacts(repo, entries, [plugin]);
  const seeds = plugin.skillDirs
    .map((dir) => ({
      subpath: dir,
      defaultName: defaultNameFor(dir, repo, repoName),
      origin: layoutOriginOf(dir) ?? "marketplace",
    }))
    .filter((seed) => isSafeItemName(seed.defaultName));
  const candidates = await describeCandidates(repo, commit, seeds);
  for (const candidate of candidates) {
    const fact = facts.get(candidate.subpath);
    if (fact !== undefined) candidate.plugin = fact;
  }
  return { plugin, candidates };
}

/**
 * The plugin that owns `subpath` as a skill directory, or null.
 *
 * Checked first against every catalog-named plugin's own `skillDirs` (any
 * manifest-declared shape). When none claims it, falls back to the
 * conventional `<plugin>/skills/<skill>` shape for a plugin no catalog names
 * at all, built the same way `describePluginDirectory` builds any other
 * manifest-only plugin (rules 7 to 9).
 */
async function pluginOwningSkillDir(
  repo: string,
  commit: string,
  entries: readonly GitTreeEntry[],
  subpath: string,
): Promise<DiscoveredPlugin | null> {
  const inventory = await discoverPlugins(repo, commit, entries);
  const cataloged = inventory.plugins.find((plugin) =>
    plugin.skillDirs.includes(subpath),
  );
  if (cataloged !== undefined) return cataloged;

  const pluginDir = pluginDirFromSkillPath(subpath);
  if (pluginDir === null || !hasPluginManifest(entries, pluginDir)) {
    return null;
  }
  const { plugin } = await describePluginDirectory(
    repo,
    entries,
    pluginDir,
    {},
    [],
  );
  return plugin.skillDirs.includes(subpath) ? plugin : null;
}

/**
 * The plugin directory `subpath` would sit under if it has the conventional
 * `<plugin>/skills/<skill>` shape, or null when it does not have that shape
 * at all.
 */
function pluginDirFromSkillPath(subpath: string): string | null {
  const parent = posix.dirname(subpath);
  if (posix.basename(parent) !== "skills") return null;
  return posix.dirname(parent);
}

export interface LicenseFinding {
  /** The path that was found, or null. */
  path: string | null;
  /** True when the file sits inside the item and therefore travels with it. */
  insideItem: boolean;
  /** A short label such as `MIT`, or null when none was recognized. */
  label: string | null;
}

const LICENSE_NAMES = new Set([
  "license",
  "license.md",
  "license.txt",
  "licence",
  "licence.md",
  "licence.txt",
  "copying",
]);

const LICENSE_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/\bMIT\b/, "MIT"],
  [/\bApache\b/i, "Apache"],
  [/\bBSD\b/, "BSD"],
  [/\bGNU (GENERAL|LESSER)|\bGPL\b/i, "GPL"],
  [/\bMozilla Public License\b|\bMPL\b/i, "MPL"],
  [/\bISC\b/, "ISC"],
  [/\bUnlicense\b/i, "Unlicense"],
];

/**
 * Name-match heuristic over LICENSE, LICENSE.md, LICENCE, and COPYING.
 *
 * It is a heuristic and the specification says so. It misses a license stated
 * only in a README, and it never blocks a command.
 */
export async function findLicense(
  repo: string,
  commit: string,
  subpath: string,
): Promise<LicenseFinding> {
  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec("."),
  ]);
  const inside = licenseIn(entries, subpath);
  const atRoot = subpath === "." ? null : licenseIn(entries, ".");
  const found = inside ?? atRoot;
  if (found === undefined || found === null) {
    return { path: null, insideItem: false, label: null };
  }
  return {
    path: found.path,
    insideItem: inside !== null && inside !== undefined,
    label: await licenseLabel(repo, found.object),
  };
}

export interface RemoteFileSummary {
  path: string;
  bytes: number;
}

export interface RemoteCandidateSummary {
  files: RemoteFileSummary[];
  totalBytes: number;
}

/** The file list and sizes the consent prompt prints. */
export async function summarizeCandidate(
  repo: string,
  commit: string,
  subpath: string,
): Promise<RemoteCandidateSummary> {
  const entries = await itemTreeEntriesAtCommit(
    remoteTreeSource(repo, commit, subpath),
    "skills",
  );
  const blobs = await catFileBlobs(
    repo,
    entries.map((entry) => entry.blobId),
  );
  const files = entries.map((entry) => ({
    path: entry.path,
    bytes: blobs.get(entry.blobId)?.byteLength ?? 0,
  }));
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** The content source a remote item root selects, with no item name involved. */
export function remoteTreeSource(
  repo: string,
  commit: string,
  itemRoot: string,
): GitTreeSource {
  return { kind: "git-tree", repo, commit, itemRoot };
}

/** Every directory that holds a regular-file `SKILL.md` at the commit (D14). */
function skillDirectories(entries: readonly GitTreeEntry[]): Set<string> {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (entry.path === SKILL_FILE) {
      dirs.add(".");
      continue;
    }
    if (entry.path.endsWith(`/${SKILL_FILE}`)) {
      dirs.add(entry.path.slice(0, -(SKILL_FILE.length + 1)));
    }
  }
  return dirs;
}

/**
 * The origin a directory's own position implies, or null when its position
 * implies nothing.
 *
 * A directory under `skills/` counts only as a direct child: `skills/a/b` is
 * content of `skills/a`, not a second skill.
 */
function layoutOriginOf(subpath: string): RemoteCandidateOrigin | null {
  if (subpath === ".") return "root";
  for (const { prefix, origin } of SKILL_PARENTS) {
    const depth = prefix.split("/").length;
    const segments = subpath.split("/");
    if (segments.length === depth + 1 && subpath.startsWith(`${prefix}/`)) {
      return origin;
    }
  }
  return null;
}

interface CandidateSeed {
  subpath: string;
  defaultName: string;
  origin: RemoteCandidateOrigin;
}

/** Read every candidate's `SKILL.md` in one object read, then sort. */
async function describeCandidates(
  repo: string,
  commit: string,
  seeds: readonly CandidateSeed[],
): Promise<RemoteSkillCandidate[]> {
  if (seeds.length === 0) return [];
  const wanted = new Map(
    seeds.map((seed) => [itemFilePath(seed.subpath, SKILL_FILE), seed]),
  );
  const entries = await lsTreeEntriesForPathspecs(
    repo,
    commit,
    [...wanted.keys()].map(literalPathspec),
  );
  const blobByPath = new Map(
    entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry.object]),
  );
  const blobs = await catFileBlobs(repo, blobByPath.values());
  const candidates: RemoteSkillCandidate[] = [];
  for (const [path, seed] of wanted) {
    const blobId = blobByPath.get(path);
    if (blobId === undefined) continue;
    candidates.push({
      subpath: seed.subpath,
      defaultName: seed.defaultName,
      origin: seed.origin,
      description: descriptionOf(blobs.get(blobId), path),
    });
  }
  return candidates.sort(compareCandidates);
}

function compareCandidates(
  left: RemoteSkillCandidate,
  right: RemoteSkillCandidate,
): number {
  if (left.subpath !== right.subpath) {
    return left.subpath < right.subpath ? -1 : 1;
  }
  return (
    ORIGIN_PRECEDENCE.indexOf(left.origin) -
    ORIGIN_PRECEDENCE.indexOf(right.origin)
  );
}

/**
 * The frontmatter `description`, or null.
 *
 * `parseFrontmatter` takes the extracted block, never the whole file: the
 * closing `---` opens a second YAML document, so passing the file returns no
 * description and one "multiple documents" warning for every skill ever
 * written.
 */
function descriptionOf(
  bytes: Buffer | undefined,
  label: string,
): string | null {
  if (bytes === undefined) return null;
  const block = extractFrontmatter(bytes.toString("utf8"));
  if (block.malformed || block.text === null) return null;
  const meta = parseFrontmatter(block.text, label);
  if (meta.warnings.length > 0) return null;
  return meta.description ?? null;
}

function licenseIn(
  entries: readonly GitTreeEntry[],
  subpath: string,
): GitTreeEntry | null {
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (posix.dirname(entry.path) !== subpath) continue;
    if (LICENSE_NAMES.has(basename(entry.path).toLowerCase())) return entry;
  }
  return null;
}

async function licenseLabel(
  repo: string,
  blobId: string,
): Promise<string | null> {
  const blobs = await catFileBlobs(repo, [blobId]);
  const head = blobs.get(blobId)?.subarray(0, 200).toString("utf8") ?? "";
  for (const [pattern, label] of LICENSE_LABELS) {
    if (pattern.test(head)) return label;
  }
  return null;
}

function defaultNameFor(
  subpath: string,
  repo: string,
  repoName?: string,
): string {
  if (subpath !== ".") return subpath.split("/").at(-1) ?? "";
  if (repoName !== undefined) return repoName;
  return basename(repo).replace(/\.git$/, "");
}

function itemFilePath(subpath: string, relPath: string): string {
  return subpath === "." ? relPath : `${subpath}/${relPath}`;
}
