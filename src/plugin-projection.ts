import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PreconditionError } from "./errors";
import {
  assertRegularBlobEntries,
  gitVisibleFilesUnderPath,
  gitText,
  literalPathspec,
  lsTreeEntriesAtCommit,
  showAtCommit,
} from "./git";
import { isPrivateDotenvPath } from "./dotfiles";
import { assertNoSymlinkAncestors } from "./path-safety";

export interface ProjectionFile {
  path: string;
  bytes: Buffer;
  executable: boolean;
}

export function validateProjectionFiles(files: ProjectionFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (
      !file.path ||
      file.path.startsWith("/") ||
      /^[A-Za-z]:/.test(file.path) ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new PreconditionError(
        `unsafe generated projection path "${file.path}"`,
      );
    }
    if (seen.has(file.path)) {
      throw new PreconditionError(
        `duplicate generated projection path "${file.path}"`,
      );
    }
    seen.add(file.path);
  }
  for (const child of seen) {
    const segments = child.split("/");
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join("/");
      if (seen.has(parent)) {
        throw new PreconditionError(
          `generated projection path collision between "${parent}" and "${child}"`,
        );
      }
    }
  }
}

export interface SelectedSkill {
  ref: string;
  name: string;
  files: ProjectionFile[];
}

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const IDENTITY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAUDE_RESERVED_MARKETPLACES = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "anthropic-agent-skills",
  "knowledge-work-plugins",
  "life-sciences",
  "claude-plugins-community",
  "claude-community",
  "claude-for-legal",
  "claude-for-financial-services",
  "financial-services-plugins",
  "first-party-plugins",
  "healthcare",
  "inline",
  "builtin",
  "skills-dir",
]);

export function canonicalSkillRef(input: string): string {
  if (input.includes("\\") || input.startsWith("/") || input.includes("//")) {
    throw new PreconditionError(`invalid skill ref "${input}"`);
  }
  const parts = input.split("/");
  if (parts.includes(".") || parts.includes("..")) {
    throw new PreconditionError(`invalid skill ref "${input}"`);
  }
  const name = parts.length === 1 ? parts[0] : parts[1];
  if (
    name === undefined ||
    (parts.length !== 1 && (parts.length !== 2 || parts[0] !== "skills")) ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    throw new PreconditionError(
      `invalid skill ref "${input}"; expected skills/<name>`,
    );
  }
  return `skills/${name}`;
}

export function validateMarketplaceName(
  name: string,
  label: string,
  target?: "claude" | "codex",
): void {
  if (!IDENTITY_PATTERN.test(name) || name.length > 64) {
    throw new PreconditionError(
      `invalid ${label} "${name}"; use 1-64 lowercase letters, digits, and single hyphens`,
    );
  }
  if (
    new Set(["claude", "anthropic", "codex", "openai", "capshelf"]).has(name)
  ) {
    throw new PreconditionError(`reserved ${label} "${name}"`);
  }
  if (
    target === "claude" &&
    label === "marketplace name" &&
    (CLAUDE_RESERVED_MARKETPLACES.has(name) ||
      [...CLAUDE_RESERVED_MARKETPLACES].some((reserved) =>
        name.startsWith(`${reserved}-`),
      ) ||
      name.includes("anthropic") ||
      (name.includes("official") &&
        (name.includes("claude") ||
          name.includes("plugin") ||
          name.includes("marketplace"))))
  ) {
    throw new PreconditionError(
      `reserved or impersonating Claude marketplace name "${name}"`,
    );
  }
}

export async function collectSelectedSkill(
  dataRepo: string,
  input: string,
  fromHead = false,
): Promise<SelectedSkill> {
  const ref = canonicalSkillRef(input);
  const name = ref.slice("skills/".length);
  const files = fromHead
    ? await collectHeadFiles(dataRepo, ref)
    : await collectWorkingFiles(dataRepo, ref);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new PreconditionError(`${ref} must contain a Git-visible SKILL.md`);
  }
  const privateFiles = files
    .map((file) => file.path)
    .filter(isPrivateDotenvPath);
  if (privateFiles.length > 0) {
    throw new PreconditionError(
      `${ref} contains private dotenv files: ${privateFiles.join(", ")}`,
    );
  }
  return { ref, name, files };
}

async function collectWorkingFiles(
  dataRepo: string,
  ref: string,
): Promise<ProjectionFile[]> {
  const root = join(dataRepo, ...ref.split("/"));
  await assertNoSymlinkAncestors(dataRepo, ref);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink()) {
      throw new PreconditionError(`${ref} is a symlink`);
    }
    if (!rootInfo.isDirectory()) {
      throw new PreconditionError(`${ref} is not a directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PreconditionError(`${ref} does not exist`);
    }
    throw error;
  }
  const relPaths = await gitVisibleFilesUnderPath(dataRepo, ref);
  const trackedModes = await trackedModesUnderPath(dataRepo, ref);
  const files: ProjectionFile[] = [];
  for (const relPath of relPaths) {
    if (relPath === ".capshelf.yml") continue;
    await assertNoSymlinkAncestors(dataRepo, `${ref}/${relPath}`);
    const absolute = join(dataRepo, ...ref.split("/"), ...relPath.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new PreconditionError(`${ref}/${relPath} is a symlink`);
    }
    if (!info.isFile()) continue;
    files.push({
      path: relPath,
      bytes: await readFile(absolute),
      executable:
        trackedModes.get(relPath) === "100755" ||
        (!trackedModes.has(relPath) && (info.mode & 0o111) !== 0),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectHeadFiles(
  dataRepo: string,
  ref: string,
): Promise<ProjectionFile[]> {
  const entries = await lsTreeEntriesAtCommit(dataRepo, "HEAD", ref);
  assertRegularBlobEntries(entries, ref);
  const prefix = `${ref}/`;
  const files: ProjectionFile[] = [];
  for (const entry of entries) {
    const relPath = entry.path.slice(prefix.length);
    if (relPath === ".capshelf.yml") continue;
    files.push({
      path: relPath,
      bytes: await showAtCommit(dataRepo, "HEAD", entry.path),
      executable: entry.mode === "100755",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function logicalContentHash(
  metadata: unknown,
  files: ProjectionFile[],
): string {
  const hash = createHash("sha256");
  hash.update(`${JSON.stringify(canonicalizeJson(metadata))}\0`);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0`);
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function trackedModesUnderPath(
  dataRepo: string,
  ref: string,
): Promise<Map<string, string>> {
  const out = await gitText(dataRepo, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    literalPathspec(ref),
  ]);
  const prefix = `${ref}/`;
  const modes = new Map<string, string>();
  for (const record of out.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`unexpected git ls-files output: ${record}`);
    if (match[2]!.startsWith(prefix)) {
      modes.set(match[2]!.slice(prefix.length), match[1]!);
    }
  }
  return modes;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    );
  }
  return value;
}

export function jsonFile(path: string, value: unknown): ProjectionFile {
  return {
    path,
    bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    executable: false,
  };
}
