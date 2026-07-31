import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { hashNamedContents } from "./content-hash";
import { PreconditionError } from "./errors";
import { atomicWriteFile, lstatOrNull } from "./fs-utils";
import {
  lastTouchingCommitForPaths,
  objectTypeAtCommit,
  showAtCommit,
} from "./git";
import { itemOutputTargets } from "./installed";
import type { DataLockEntry } from "./lock";

export const SUBAGENT_TARGETS = ["claude", "codex"] as const;
export type SubagentTarget = (typeof SUBAGENT_TARGETS)[number];

export interface SubagentSource {
  target: SubagentTarget;
  relPath: string;
  outputPath: string;
}

export interface SubagentValidation {
  warnings: string[];
}

export function isSubagentTarget(value: string): value is SubagentTarget {
  return (SUBAGENT_TARGETS as readonly string[]).includes(value);
}

export function subagentSourceCandidates(
  project: string,
  name: string,
): SubagentSource[] {
  return itemOutputTargets(project, "subagents", name).map((target) => ({
    target: target.id as SubagentTarget,
    relPath: target.canonicalRelPath,
    outputPath: target.outputPath,
  }));
}

export async function currentSubagentSources(
  project: string,
  dataRepo: string,
  name: string,
): Promise<SubagentSource[]> {
  const sources = subagentSourceCandidates(project, name).filter((source) =>
    existsSync(join(dataRepo, ...source.relPath.split("/"))),
  );
  if (sources.length === 0) {
    throw new PreconditionError(
      `subagents/${name} has no canonical target sources\n  add claude.md, codex.toml, or both`,
    );
  }
  return sources;
}

export async function subagentSourcesAtCommit(
  project: string,
  dataRepo: string,
  name: string,
  commit: string,
): Promise<SubagentSource[]> {
  const sources: SubagentSource[] = [];
  for (const source of subagentSourceCandidates(project, name)) {
    if (
      (await objectTypeAtCommit(dataRepo, commit, source.relPath)) === "blob"
    ) {
      sources.push(source);
    }
  }
  if (sources.length === 0) {
    throw new Error(
      `subagents/${name} has no canonical target sources at ${commit}`,
    );
  }
  return sources;
}

export async function validateCurrentSubagent(
  project: string,
  dataRepo: string,
  name: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const source of await currentSubagentSources(project, dataRepo, name)) {
    const raw = await readFile(
      join(dataRepo, ...source.relPath.split("/")),
      "utf-8",
    );
    warnings.push(...validateSubagentSource(source.target, name, raw).warnings);
  }
  return warnings;
}

export function validateSubagentSource(
  target: SubagentTarget,
  itemName: string,
  raw: string,
): SubagentValidation {
  return target === "claude"
    ? validateClaudeSubagent(itemName, raw)
    : validateCodexSubagent(itemName, raw);
}

export async function shaOfCurrentSubagent(
  project: string,
  dataRepo: string,
  name: string,
): Promise<string> {
  const entries = await Promise.all(
    (await currentSubagentSources(project, dataRepo, name)).map(
      async (source) => ({
        name: source.relPath,
        content: await readFile(join(dataRepo, ...source.relPath.split("/"))),
      }),
    ),
  );
  return hashNamedContents(entries);
}

export async function shaOfSubagentAtCommit(
  project: string,
  dataRepo: string,
  name: string,
  commit: string,
): Promise<string> {
  const entries = await Promise.all(
    (await subagentSourcesAtCommit(project, dataRepo, name, commit)).map(
      async (source) => ({
        name: source.relPath,
        content: await showAtCommit(dataRepo, commit, source.relPath),
      }),
    ),
  );
  return hashNamedContents(entries);
}

export async function lastTouchingSubagentCommit(
  project: string,
  dataRepo: string,
  name: string,
): Promise<string> {
  return await lastTouchingCommitForPaths(
    dataRepo,
    subagentSourceCandidates(project, name).map((source) => source.relPath),
  );
}

export async function shaOfInstalledSubagent(
  project: string,
  dataRepo: string,
  name: string,
  commit: string,
): Promise<string | null> {
  const entries: Array<{ name: string; content: Uint8Array }> = [];
  for (const source of await subagentSourcesAtCommit(
    project,
    dataRepo,
    name,
    commit,
  )) {
    const stat = lstatOrNull(source.outputPath);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    entries.push({
      name: source.relPath,
      content: await readFile(source.outputPath),
    });
  }
  return hashNamedContents(entries);
}

export async function assertSubagentOutputAvailable(
  project: string,
  dataRepo: string,
  name: string,
): Promise<void> {
  for (const source of await currentSubagentSources(project, dataRepo, name)) {
    if (lstatOrNull(source.outputPath)) {
      throw new PreconditionError(
        `target already exists and is not managed by capshelf: ${source.outputPath}`,
      );
    }
  }
}

export interface MaterializeSubagentOptions {
  project: string;
  dataRepo: string;
  name: string;
  entry: DataLockEntry;
  previousEntry?: DataLockEntry;
  dryRun?: boolean;
  hooks?: {
    beforeReplace?: (
      source: SubagentSource,
      index: number,
    ) => void | Promise<void>;
  };
}

export interface MaterializeSubagentResult {
  paths: string[];
  removedPaths: string[];
  warnings: string[];
  changed: boolean;
}

export async function removeSubagentOutputs(
  project: string,
  dataRepo: string,
  name: string,
  entry: DataLockEntry,
): Promise<string[]> {
  const sources = await subagentSourcesAtCommit(
    project,
    dataRepo,
    name,
    entry.sourceCommit,
  );
  const snapshots = new Map<string, Buffer>();
  for (const source of sources) {
    const stat = lstatOrNull(source.outputPath);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PreconditionError(
        `managed subagent target is not a regular file: ${source.outputPath}`,
      );
    }
    snapshots.set(source.outputPath, await readFile(source.outputPath));
  }
  try {
    for (const path of snapshots.keys()) await rm(path, { force: true });
  } catch (error) {
    for (const [path, content] of snapshots) {
      await mkdir(dirname(path), { recursive: true }).catch(() => {});
      await atomicWriteFile(path, content).catch(() => {});
    }
    throw error;
  }
  return [...snapshots.keys()];
}

export async function materializeSubagent(
  options: MaterializeSubagentOptions,
): Promise<MaterializeSubagentResult> {
  const desired = await subagentSourcesAtCommit(
    options.project,
    options.dataRepo,
    options.name,
    options.entry.sourceCommit,
  );
  const previous = options.previousEntry
    ? await subagentSourcesAtCommit(
        options.project,
        options.dataRepo,
        options.name,
        options.previousEntry.sourceCommit,
      )
    : desired;
  const managedTargets = new Set(previous.map((source) => source.target));
  const desiredTargets = new Set(desired.map((source) => source.target));
  const contents = new Map<SubagentTarget, Buffer>();
  const warnings: string[] = [];

  for (const source of desired) {
    const content = await showAtCommit(
      options.dataRepo,
      options.entry.sourceCommit,
      source.relPath,
    );
    warnings.push(
      ...validateSubagentSource(
        source.target,
        options.name,
        content.toString("utf-8"),
      ).warnings,
    );
    contents.set(source.target, content);
    const stat = lstatOrNull(source.outputPath);
    if (stat && !managedTargets.has(source.target)) {
      throw new PreconditionError(
        `target already exists and is not managed by capshelf: ${source.outputPath}`,
      );
    }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new PreconditionError(
        `managed subagent target is not a regular file: ${source.outputPath}`,
      );
    }
  }

  const sourceSha = hashNamedContents(
    desired.map((source) => ({
      name: source.relPath,
      content: contents.get(source.target)!,
    })),
  );
  if (sourceSha !== options.entry.sha) {
    throw new Error(
      `locked sha mismatch for data/subagents/${options.name}: expected ${options.entry.sha}, got ${sourceSha}`,
    );
  }

  const stale = previous.filter((source) => !desiredTargets.has(source.target));
  for (const source of stale) {
    const stat = lstatOrNull(source.outputPath);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new PreconditionError(
        `managed subagent target is not a regular file: ${source.outputPath}`,
      );
    }
  }
  let changed = stale.some((source) => lstatOrNull(source.outputPath) !== null);
  for (const source of desired) {
    const current =
      lstatOrNull(source.outputPath)?.isFile() === true
        ? await readFile(source.outputPath)
        : null;
    if (!current?.equals(contents.get(source.target)!)) changed = true;
  }
  if (options.dryRun || !changed) {
    return {
      paths: desired.map((source) => source.outputPath),
      removedPaths: stale.map((source) => source.outputPath),
      warnings,
      changed,
    };
  }

  const touched = [...desired, ...stale].map((source) => source.outputPath);
  const snapshots = new Map<string, Buffer | null>();
  for (const path of touched) {
    const stat = lstatOrNull(path);
    snapshots.set(path, stat?.isFile() ? await readFile(path) : null);
  }

  try {
    for (const [index, source] of desired.entries()) {
      await mkdir(dirname(source.outputPath), { recursive: true });
      await options.hooks?.beforeReplace?.(source, index);
      await atomicWriteFile(source.outputPath, contents.get(source.target)!);
    }
    for (const source of stale) {
      await rm(source.outputPath, { force: true });
    }
    const installedSha = await shaOfInstalledSubagent(
      options.project,
      options.dataRepo,
      options.name,
      options.entry.sourceCommit,
    );
    if (installedSha !== options.entry.sha) {
      throw new Error(
        `post-materialization sha mismatch for data/subagents/${options.name}: expected ${options.entry.sha}, got ${installedSha ?? "missing"}`,
      );
    }
  } catch (error) {
    for (const [path, snapshot] of snapshots) {
      if (snapshot === null) {
        await rm(path, { force: true }).catch(() => {});
      } else {
        await mkdir(dirname(path), { recursive: true }).catch(() => {});
        await atomicWriteFile(path, snapshot).catch(() => {});
      }
    }
    throw error;
  }

  return {
    paths: desired.map((source) => source.outputPath),
    removedPaths: stale.map((source) => source.outputPath),
    warnings,
    changed: true,
  };
}

export interface SubagentTargetStatus {
  target: SubagentTarget;
  sourcePath: string;
  outputPath: string;
  state: "ok" | "missing" | "drifted";
}

export async function subagentTargetStatusAtCommit(
  project: string,
  dataRepo: string,
  name: string,
  commit: string,
): Promise<SubagentTargetStatus[]> {
  const result: SubagentTargetStatus[] = [];
  for (const source of await subagentSourcesAtCommit(
    project,
    dataRepo,
    name,
    commit,
  )) {
    const stat = lstatOrNull(source.outputPath);
    let state: SubagentTargetStatus["state"] = "missing";
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const [installed, expected] = await Promise.all([
        readFile(source.outputPath),
        showAtCommit(dataRepo, commit, source.relPath),
      ]);
      state = installed.equals(expected) ? "ok" : "drifted";
    } else if (stat !== null) {
      state = "drifted";
    }
    result.push({
      target: source.target,
      sourcePath: source.relPath,
      outputPath: source.outputPath,
      state,
    });
  }
  return result;
}

function validateClaudeSubagent(
  itemName: string,
  raw: string,
): SubagentValidation {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    throw new PreconditionError(
      `invalid Claude subagent subagents/${itemName}/claude.md: missing YAML frontmatter`,
    );
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new PreconditionError(
      `invalid Claude subagent subagents/${itemName}/claude.md: frontmatter has no closing ---`,
    );
  }
  const doc = parseDocument(match[1]!);
  if (doc.errors.length > 0) {
    throw new PreconditionError(
      `invalid Claude subagent subagents/${itemName}/claude.md: ${doc.errors[0]!.message}`,
    );
  }
  const value = doc.toJS() as unknown;
  if (!isRecord(value)) {
    throw new PreconditionError(
      `invalid Claude subagent subagents/${itemName}/claude.md: frontmatter must be a mapping`,
    );
  }
  const name = requiredString(value, "name", "Claude", itemName);
  requiredString(value, "description", "Claude", itemName);
  if (!match[2]!.trim()) {
    throw new PreconditionError(
      `invalid Claude subagent subagents/${itemName}/claude.md: prompt body must be non-empty`,
    );
  }
  return {
    warnings:
      name === itemName
        ? []
        : [
            `subagents/${itemName}: Claude name "${name}" differs from item name`,
          ],
  };
}

function validateCodexSubagent(
  itemName: string,
  raw: string,
): SubagentValidation {
  let value: unknown;
  try {
    value = parseToml(raw) as unknown;
  } catch (error) {
    throw new PreconditionError(
      `invalid Codex subagent subagents/${itemName}/codex.toml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new PreconditionError(
      `invalid Codex subagent subagents/${itemName}/codex.toml: root must be a table`,
    );
  }
  const name = requiredString(value, "name", "Codex", itemName);
  requiredString(value, "description", "Codex", itemName);
  requiredString(value, "developer_instructions", "Codex", itemName);
  return {
    warnings:
      name === itemName
        ? []
        : [
            `subagents/${itemName}: Codex name "${name}" differs from item name`,
          ],
  };
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  runtime: string,
  itemName: string,
): string {
  const selected = value[field];
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new PreconditionError(
      `invalid ${runtime} subagent subagents/${itemName}/${runtime === "Claude" ? "claude.md" : "codex.toml"}: ${field} must be a non-empty string`,
    );
  }
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
