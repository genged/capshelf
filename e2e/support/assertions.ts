import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type CommandResult,
  describeCommand,
  describeOutcome,
} from "./command";
import type { World } from "./world";

function fail(message: string, result?: CommandResult): never {
  throw new Error(result ? `${message}\n${describeCommand(result)}` : message);
}

/** Exact documented exit code. A signal, timeout, or spawn failure is not it. */
export function expectExit(result: CommandResult, exitCode: number): void {
  if (result.outcome.kind !== "exit") {
    fail(
      `expected exit ${exitCode}, but the process ${describeOutcome(result.outcome)}`,
      result,
    );
  }
  if (result.outcome.exitCode !== exitCode) {
    fail(
      `expected exit ${exitCode}, got exit ${result.outcome.exitCode}`,
      result,
    );
  }
}

export function expectOutputContains(
  result: CommandResult,
  needle: string,
): void {
  if (!`${result.stdout}${result.stderr}`.includes(needle)) {
    fail(`expected output to contain ${JSON.stringify(needle)}`, result);
  }
}

export function expectOutputExcludes(
  result: CommandResult,
  needle: string,
): void {
  if (`${result.stdout}${result.stderr}`.includes(needle)) {
    fail(`expected output not to contain ${JSON.stringify(needle)}`, result);
  }
}

/**
 * A refusal must name the way out. This asserts the recovery command the user
 * is told to run, not the whole message: prose is not a contract, but the
 * command in it is what the user types.
 */
export function expectRecovery(result: CommandResult, command: string): void {
  expectOutputContains(result, command);
}

export function parseJson(result: CommandResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    return fail(
      `expected JSON on stdout: ${err instanceof Error ? err.message : String(err)}`,
      result,
    );
  }
}

export interface ApplyRow {
  key: string;
  action: string;
}

/** Semantic rows from `apply --json`, not a text snapshot of its output. */
export function parseApplyRows(stdout: string): ApplyRow[] {
  const payload: unknown = JSON.parse(stdout);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    throw new Error(`apply --json has no items array: ${stdout}`);
  }
  const items = (payload as { items: unknown[] }).items;
  return items.map((item) => {
    const row = item as { key?: unknown; action?: unknown };
    if (typeof row.key !== "string" || typeof row.action !== "string") {
      throw new Error(`unexpected apply row: ${JSON.stringify(item)}`);
    }
    return { key: row.key, action: row.action };
  });
}

export interface StatusRow {
  scope: string;
  source: string;
  kind: string;
  name: string;
  state: string;
  [field: string]: unknown;
}

/** Semantic rows from `status --json`. */
export function parseStatusRows(stdout: string): StatusRow[] {
  const payload: unknown = JSON.parse(stdout);
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error(`status --json has no items array: ${stdout}`);
  }
  return items.map((item) => {
    const row = item as Partial<StatusRow>;
    if (
      typeof row.kind !== "string" ||
      typeof row.name !== "string" ||
      typeof row.state !== "string"
    ) {
      throw new Error(`unexpected status row: ${JSON.stringify(item)}`);
    }
    return row as StatusRow;
  });
}

export function statusRow(
  rows: readonly StatusRow[],
  kind: string,
  name: string,
): StatusRow {
  const found = rows.find((row) => row.kind === kind && row.name === name);
  if (!found) {
    throw new Error(
      `no status row for ${kind}/${name}; rows: ${rows
        .map((row) => `${row.kind}/${row.name}=${row.state}`)
        .join(", ")}`,
    );
  }
  return found;
}

/** `expected === null` asserts the path is absent. */
export async function expectBytes(
  path: string,
  expected: string | null,
): Promise<void> {
  let actual: string | null = null;
  try {
    actual = await readFile(path, "utf-8");
  } catch {
    actual = null;
  }
  if (expected === null) {
    if (actual !== null) {
      throw new Error(
        `expected ${path} to be absent, found ${actual.length} bytes`,
      );
    }
    return;
  }
  if (actual === null) throw new Error(`expected ${path} to exist`);
  if (actual !== expected) {
    throw new Error(
      `bytes differ at ${path}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    );
  }
}

export async function expectAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch {
    return;
  }
  throw new Error(`expected ${path} to be absent`);
}

/** A real directory, not a symlink that happens to resolve to one. */
export async function expectRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) throw new Error(`expected a directory at ${path}`);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `expected a real directory at ${path}, found a symlink to ${await readlink(path)}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`expected a directory at ${path}`);
  }
}

/**
 * Reading bytes through a link proves the bytes, not the link. The
 * compatibility path is a *relative* symlink, so the project stays portable
 * when it is cloned somewhere else.
 */
export async function expectRelativeSymlink(
  path: string,
  target: string,
): Promise<void> {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) throw new Error(`expected a symlink at ${path}`);
  if (!stats.isSymbolicLink()) {
    throw new Error(`expected a symlink at ${path}, found a real entry`);
  }
  const actual = await readlink(path);
  if (actual !== target) {
    throw new Error(
      `symlink at ${path} points at ${JSON.stringify(actual)}, expected ${JSON.stringify(target)}`,
    );
  }
}

export async function expectExecutable(
  path: string,
  executable: boolean,
): Promise<void> {
  const stats = await lstat(path);
  const isExecutable = (stats.mode & 0o111) !== 0;
  if (isExecutable !== executable) {
    throw new Error(
      `expected ${path} to be ${executable ? "executable" : "not executable"}, mode is ${(stats.mode & 0o777).toString(8)}`,
    );
  }
}

/** Independent observation: git's own answer, in this world's environment. */
export async function expectIgnored(
  world: World,
  repo: string,
  relPaths: readonly string[],
): Promise<void> {
  for (const relPath of relPaths) {
    const result = await world.git.run(repo, [
      "check-ignore",
      "-q",
      "--",
      relPath,
    ]);
    if (result.outcome.kind !== "exit" || result.outcome.exitCode !== 0) {
      fail(`expected ${relPath} to be ignored in ${repo}`, result);
    }
  }
}

export async function expectHeadTreeContains(
  world: World,
  repo: string,
  relPaths: readonly string[],
): Promise<void> {
  const tree = await world.git.lsTree(repo);
  const missing = relPaths.filter((path) => !tree.includes(path));
  if (missing.length > 0) {
    throw new Error(
      `HEAD tree of ${repo} is missing:\n  ${missing.join("\n  ")}\nit contains:\n  ${tree.join("\n  ")}`,
    );
  }
}

export async function expectHeadTreeExcludes(
  world: World,
  repo: string,
  relPaths: readonly string[],
): Promise<void> {
  const tree = await world.git.lsTree(repo);
  const present = relPaths.filter((path) => tree.includes(path));
  if (present.length > 0) {
    throw new Error(
      `HEAD tree of ${repo} must not contain:\n  ${present.join("\n  ")}`,
    );
  }
}

/**
 * Project paths a capshelf command may own. A snapshot covers all of them so a
 * refusal cannot quietly write outside the paths a scenario happens to name.
 */
export const OWNED_PROJECT_PATHS = [
  ".capshelf",
  ".agents",
  ".claude",
  ".codex",
  ".pi",
  ".mcp.json",
] as const;

export interface FileEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  mode?: string;
  sha256?: string;
  target?: string;
}

export interface OwnedStateSelection {
  /** Project files: `.capshelf/**` plus managed runtime outputs. */
  projectFiles?: string | { path: string; include: readonly string[] };
  /** Project Git: HEAD, refs, index bytes, porcelain status. */
  projectGit?: string;
  /**
   * Managed source paths plus Git state in the data repo. `refPrefixes`
   * narrows the refs the snapshot covers — a command that fetches moves
   * remote-tracking refs by design, so a test about the *local* branch selects
   * `refs/heads/` and says so.
   */
  dataRepo?: {
    path: string;
    paths: readonly string[];
    refPrefixes?: readonly string[];
  };
  /** Advertised refs, for a workflow that can change a remote. */
  bareRemote?: string;
  /** Absolute paths that must stay absent. */
  requiredAbsent?: readonly string[];
}

export interface OwnedState {
  projectFiles?: FileEntry[];
  projectGit?: GitState;
  dataRepoFiles?: FileEntry[];
  dataRepoGit?: GitState;
  bareRemoteRefs?: string[];
  requiredAbsent?: Record<string, "absent">;
}

export interface GitState {
  head: string;
  refs: string[];
  index: string[];
  porcelain: string;
}

/**
 * Build the snapshot a safe-failure assertion compares. Every snapshot is
 * selected by the scenario: there is no catch-all "all owned state", because a
 * label that names nothing cannot be checked for completeness.
 *
 * Git object storage, pack layout, and reflogs are deliberately outside it.
 * Git may change those without changing anything a user contracted for.
 */
export async function captureOwnedState(
  world: World,
  selection: OwnedStateSelection,
): Promise<OwnedState> {
  const keys = Object.keys(selection).filter(
    (key) => selection[key as keyof OwnedStateSelection] !== undefined,
  );
  if (keys.length === 0) {
    throw new Error(
      "captureOwnedState needs at least one selected snapshot: projectFiles, projectGit, dataRepo, bareRemote, or requiredAbsent",
    );
  }

  const state: OwnedState = {};
  if (selection.projectFiles !== undefined) {
    const target =
      typeof selection.projectFiles === "string"
        ? { path: selection.projectFiles, include: OWNED_PROJECT_PATHS }
        : selection.projectFiles;
    state.projectFiles = await snapshotPaths(target.path, target.include);
  }
  if (selection.projectGit !== undefined) {
    state.projectGit = await snapshotGit(world, selection.projectGit);
  }
  if (selection.dataRepo !== undefined) {
    state.dataRepoFiles = await snapshotPaths(
      selection.dataRepo.path,
      selection.dataRepo.paths,
    );
    state.dataRepoGit = await snapshotGit(
      world,
      selection.dataRepo.path,
      selection.dataRepo.refPrefixes,
    );
  }
  if (selection.bareRemote !== undefined) {
    state.bareRemoteRefs = await world.git.advertisedRefs(selection.bareRemote);
  }
  if (selection.requiredAbsent !== undefined) {
    const absent: Record<string, "absent"> = {};
    for (const path of selection.requiredAbsent) {
      await expectAbsent(path);
      absent[path] = "absent";
    }
    state.requiredAbsent = absent;
  }
  return state;
}

async function snapshotGit(
  world: World,
  repo: string,
  refPrefixes?: readonly string[],
): Promise<GitState> {
  const refs = await world.git.refs(repo);
  return {
    head: await world.git.head(repo),
    refs: refPrefixes
      ? refs.filter((line) =>
          refPrefixes.some((prefix) => line.includes(` ${prefix}`)),
        )
      : refs,
    index: await world.git.indexEntries(repo),
    porcelain: await world.git.porcelain(repo),
  };
}

async function snapshotPaths(
  root: string,
  include: readonly string[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for (const relPath of include) {
    await collect(root, join(root, relPath), entries);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

async function collect(
  root: string,
  target: string,
  entries: FileEntry[],
): Promise<void> {
  const stats = await lstat(target).catch(() => null);
  if (stats === null) return;
  const path = relative(root, target);
  if (stats.isSymbolicLink()) {
    entries.push({ path, type: "symlink", target: await readlink(target) });
    return;
  }
  if (stats.isDirectory()) {
    entries.push({
      path,
      type: "dir",
      mode: (stats.mode & 0o777).toString(8),
    });
    const children = await readdir(target);
    for (const child of children.sort()) {
      await collect(root, join(target, child), entries);
    }
    return;
  }
  const bytes = await readFile(target);
  entries.push({
    path,
    type: "file",
    mode: (stats.mode & 0o777).toString(8),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

/**
 * A command expected to refuse must prove more than a non-zero exit: the state
 * it owns has to be byte-identical afterwards.
 */
export function expectSameState(
  before: OwnedState,
  after: OwnedState,
  label: string,
): void {
  const b = JSON.stringify(before, null, 2);
  const a = JSON.stringify(after, null, 2);
  if (a !== b) {
    throw new Error(
      `${label}: owned state changed\nbefore:\n${b}\nafter:\n${a}`,
    );
  }
}
