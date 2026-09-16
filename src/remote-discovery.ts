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
import {
  loadClaudeMarketplaceAtCommit,
  type ClaudePlugin,
} from "./claude-marketplace";
import { isConfigString } from "./config-values";
import { NotFoundError, PreconditionError } from "./errors";
import {
  catFileBlobs,
  literalPathspec,
  lsTreeEntriesForPathspecs,
} from "./git";
import type { GitTreeEntry } from "./git";
import type { GitTreeSource } from "./item-source";
import { extractFrontmatter, parseFrontmatter } from "./metadata";
import { itemTreeEntriesAtCommit } from "./pin";

const SKILL_FILE = "SKILL.md";
const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

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
}

export interface RemoteDiscovery {
  candidates: RemoteSkillCandidate[];
  /** A10: a marketplace document that is present and does not parse. */
  warnings: string[];
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

  const warnings: string[] = [];
  for (const dir of await marketplaceDirectories(repo, commit, warnings)) {
    if (!skillDirs.has(dir)) continue;
    if (!found.has(dir)) found.set(dir, "marketplace");
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
  return { candidates, warnings };
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
  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec(skillPath),
  ]);
  if (entries.length === 0) {
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
  return candidate;
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

/** Every directory that holds a `SKILL.md` at the commit. */
function skillDirectories(entries: readonly GitTreeEntry[]): Set<string> {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
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

/**
 * The skill directories a marketplace document names.
 *
 * `claudePluginSkills` is deliberately not used: it returns `[]` for an entry
 * capshelf does not *manage*, and those rules are capshelf's own. A repository
 * outside the shelf owes them nothing, so filtering by them would silently drop
 * a real skill directory.
 */
async function marketplaceDirectories(
  repo: string,
  commit: string,
  warnings: string[],
): Promise<string[]> {
  let plugins: ClaudePlugin[];
  try {
    plugins = (await loadClaudeMarketplaceAtCommit(repo, commit)).plugins;
  } catch (error) {
    // A10. An absent document is the ordinary case and says nothing. A present
    // document that does not parse is a fact the user needs, and it never fails
    // the command: refusing would block an install over a file that has nothing
    // to do with the skill the user asked for.
    if (!(error instanceof NotFoundError)) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `${MARKETPLACE_PATH} is present and could not be read: ${message.split("\n")[0] ?? message}`,
      );
    }
    return [];
  }
  const dirs: string[] = [];
  for (const plugin of plugins) {
    if (!Array.isArray(plugin.skills)) continue;
    for (const skill of plugin.skills) {
      if (!isConfigString(skill) || !skill.startsWith("./")) continue;
      const ref = skill.slice(2);
      const dir = ref.endsWith(`/${SKILL_FILE}`)
        ? ref.slice(0, -(SKILL_FILE.length + 1))
        : ref;
      if (isSafeItemRoot(dir)) dirs.push(dir);
    }
  }
  return dirs;
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
