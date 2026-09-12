import type { GitReadMemo } from "./git-read-memo";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { atomicWriteFile } from "./fs-utils";
import { dirname, join, relative } from "node:path";
import { hashNamedContents } from "./content-hash";
import {
  cloneConfig,
  configPathLabel,
  findUnmanagedCollision,
  isPlainConfigObject,
  mergeConfigObject,
  mergeConfigObjects,
  removeManagedValue,
  shaOfConfig,
  stableStringifyConfig,
  type ConfigObject,
} from "./config-values";
import {
  isSyntheticOnlyClaudeSettings,
  jsonTextHasComments,
  normalizeClaudeSettingsOutput,
  parseJsonConfigObject,
  stringifyJsonConfig,
  validateClaudeMcpFragment,
  validateClaudeSettingsFragment,
} from "./json-fragments";
import {
  parseTomlConfigObject,
  stringifyTomlConfig,
  tomlTextHasComments,
  validateCodexConfigFragment,
  validateCodexMcpFragment,
} from "./toml-fragments";
import {
  allCanonicalItemRelPaths,
  canonicalItemRelPaths,
  isFragmentItemKind,
  type FragmentItemKind,
  type ItemKind,
} from "./master";
import { dataKey, type DataLockEntry, type Lock } from "./lock";
import type { Manifest } from "./manifest";
import { manifestNamesForKind } from "./manifest";
import { PreconditionError } from "./errors";
import { assertNever } from "./assert";
import { claudeDir, codexProjectConfigDir } from "./paths";
import {
  GitBlobReadError,
  type GitTreeEntry,
  assertPathClean,
  commitExists,
  lastTouchingCommitForPaths,
  literalPathspec,
  lsTreeEntriesForPathspecs,
} from "./git";
import { missingSourceCommitMessage } from "./upstream-check";
import { readEntryBytes } from "./pin";
import type { PinnedBytes, PinTreeEntry } from "./pin";
import { findMasterItemByRef } from "./item-ref";

export type FragmentFormat = "json" | "toml";
export type FragmentTarget = "claude-settings" | "claude-mcp" | "codex-config";
export type FragmentSourceTarget = "claude" | "codex";
export type FragmentContributionState = "ok" | "missing" | "drifted";

export interface FragmentSource {
  kind: FragmentItemKind;
  name: string;
  target: FragmentTarget;
  sourceTarget?: FragmentSourceTarget;
  format: FragmentFormat;
  relPath: string;
}

export interface FragmentOutputSpec {
  target: FragmentTarget;
  format: FragmentFormat;
  outputPath(project: string): string;
  normalizeOutput(value: ConfigObject): ConfigObject;
  isSyntheticOnly(value: ConfigObject): boolean;
  validateFragment(value: ConfigObject, label: string): ConfigObject;
  parse(raw: string, label: string): ConfigObject;
  stringify(value: ConfigObject): string;
}

export interface FragmentOutputPlan {
  target: FragmentTarget;
  path: string;
  currentText: string | null;
  plannedText: string | null;
  currentSha: string | null;
  plannedSha: string | null;
  changed: boolean;
  /** The existing JSONC or TOML file had comments a rewrite cannot preserve. */
  commentLoss: boolean;
  /** How that loss is treated — see `commentLossPolicy`. */
  commentPolicy: CommentLossPolicy;
}

/**
 * Losing comments is destruction in one target and repair in the others.
 *
 * `#` comments are standard TOML and Codex reads `.codex/config.toml` with
 * them, so dropping them is real loss the user must authorize (`gate`).
 *
 * `.claude/settings.json` and `.mcp.json` are strict JSON to the tool that
 * consumes them. Verified against Claude Code 2.1.220: a `//` comment in
 * `settings.json` makes the whole file silently not load — an `env` entry in
 * it never reaches the session — and the same comment in `.mcp.json` reports
 * `[Failed to parse] ... MCP config is not a valid JSON`. capshelf can read
 * either file only because of its own JSONC tolerance (`parseJsonc`). Asking
 * the user to authorize losing those comments would be asking them to
 * authorize keeping a broken config: the rewrite is what makes the file
 * loadable again, so it is announced, not gated (`repair`).
 */
export type CommentLossPolicy = "gate" | "repair";

export function commentLossPolicy(format: FragmentFormat): CommentLossPolicy {
  return format === "toml" ? "gate" : "repair";
}

export interface ApplyFragmentOutputOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  oldManifest?: Manifest;
  nextManifest?: Manifest;
  oldLock: Lock;
  nextLock: Lock;
  target: FragmentTarget;
  dryRun?: boolean;
  memo?: GitReadMemo;
}

export interface FragmentApplyResult {
  key: string;
  source: "data";
  target: FragmentTarget;
  action: "reconciled" | "would-reconcile" | "already-current";
  path: string;
  currentSha: string | null;
  plannedSha: string | null;
  dryRun?: true;
}

export interface ApplyFragmentPlansOptions {
  dryRun?: boolean;
  beforeWrite?: (plan: FragmentOutputPlan, index: number) => Promise<void>;
}

export interface FragmentValue {
  source: FragmentSource;
  value: ConfigObject;
}

export function fragmentOutputPath(
  project: string,
  target: FragmentTarget,
): string {
  return fragmentOutputSpec(target).outputPath(project);
}

export function fragmentOutputSpec(target: FragmentTarget): FragmentOutputSpec {
  switch (target) {
    case "claude-settings":
      return {
        target,
        format: "json",
        outputPath: (project) => join(claudeDir(project), "settings.json"),
        normalizeOutput: normalizeClaudeSettingsOutput,
        isSyntheticOnly: isSyntheticOnlyClaudeSettings,
        validateFragment: validateClaudeSettingsFragment,
        parse: parseJsonConfigObject,
        stringify: stringifyJsonConfig,
      };
    case "claude-mcp":
      return {
        target,
        format: "json",
        outputPath: (project) => join(project, ".mcp.json"),
        normalizeOutput: identityOutput,
        isSyntheticOnly: isEmptyObject,
        validateFragment: validateClaudeMcpFragment,
        parse: parseJsonConfigObject,
        stringify: stringifyJsonConfig,
      };
    case "codex-config":
      return {
        target,
        format: "toml",
        outputPath: (project) =>
          join(codexProjectConfigDir(project), "config.toml"),
        normalizeOutput: identityOutput,
        isSyntheticOnly: isEmptyObject,
        validateFragment: validateCodexConfigFragment,
        parse: parseTomlConfigObject,
        stringify: stringifyTomlConfig,
      };
    default:
      return assertNever(target);
  }
}

export function fragmentTargetKey(target: FragmentTarget): string {
  return `data/${target}/(merged)`;
}

export function fragmentSourceCandidates(
  kind: FragmentItemKind,
  name: string,
): FragmentSource[] {
  switch (kind) {
    case "settings":
      return [
        {
          kind,
          name,
          target: "claude-settings",
          format: "json",
          relPath: `settings/${name}/settings.json`,
        },
      ];
    case "mcp":
      return [
        {
          kind,
          name,
          target: "claude-mcp",
          sourceTarget: "claude",
          format: "json",
          relPath: `mcp/${name}/claude.json`,
        },
        {
          kind,
          name,
          target: "codex-config",
          sourceTarget: "codex",
          format: "toml",
          relPath: `mcp/${name}/codex.toml`,
        },
      ];
    case "codex-config":
      return [
        {
          kind,
          name,
          target: "codex-config",
          format: "toml",
          relPath: `codex/config/${name}/config.toml`,
        },
      ];
    default:
      return assertNever(kind);
  }
}

/**
 * One candidate runtime target of an item, marked present or absent.
 *
 * The whole candidate record is carried, not a flattened tuple:
 * `FragmentSource.target` is an *output* target, not a runtime one, and
 * callers pass `kind`, `name`, `format`, and `relPath` into output planning,
 * validation, JSON rendering, and content reads.
 *
 * `present` is `boolean | null`. `null` means coverage was not readable at
 * all — a caller that could not reach a commit builds the rows itself.
 */
export interface TargetPresence {
  source: FragmentSource;
  /** "claude" | "codex" for multi-target kinds; null for single-target kinds. */
  runtimeTarget: FragmentSourceTarget | null;
  present: boolean | null;
}

export function fragmentTargetPresence(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): TargetPresence[] {
  return fragmentSourceCandidates(kind, name).map((source) => ({
    source,
    runtimeTarget: source.sourceTarget ?? null,
    present: existsSync(join(dataRepo, ...source.relPath.split("/"))),
  }));
}

export function fragmentTargetPresenceInPaths(
  kind: FragmentItemKind,
  name: string,
  repoRelPaths: Iterable<string>,
): TargetPresence[] {
  const present = new Set(repoRelPaths);
  return fragmentSourceCandidates(kind, name).map((source) => ({
    source,
    runtimeTarget: source.sourceTarget ?? null,
    present: present.has(source.relPath),
  }));
}

export async function loadFragmentSourcesAtCommit(input: {
  dataRepo: string;
  kind: FragmentItemKind;
  name: string;
  commit: string;
  manifest?: Manifest;
  memo?: GitReadMemo;
}): Promise<{
  presence: TargetPresence[];
  values: Map<string, ConfigObject>;
  rawByRelPath: Map<string, Buffer>;
}> {
  const { dataRepo, kind, name, commit, manifest, memo } = input;
  await assertSourceCommitExists(dataRepo, commit, manifest, memo);
  const candidates = fragmentSourceCandidates(kind, name);
  let tree: GitTreeEntry[];
  try {
    tree = await lsTreeEntriesForPathspecs(
      dataRepo,
      commit,
      candidates.map((source) => literalPathspec(source.relPath)),
      { includeTrees: true, memo },
    );
  } catch (cause) {
    throw new PreconditionError(
      `cannot enumerate ${candidates.map((source) => source.relPath).join(", ")} at ${commit}`,
      { cause },
    );
  }
  const entries: PinTreeEntry[] = [];
  for (const source of candidates) {
    const entry = tree.find((candidate) => candidate.path === source.relPath);
    if (!entry) continue;
    if (entry.type === "tree") {
      throw new PreconditionError(
        `${source.relPath} is a directory at ${commit}\n  a canonical source must be a regular file`,
      );
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      throw new PreconditionError(
        `${source.relPath} is not a regular file at ${commit} (mode ${entry.mode}, type ${entry.type})`,
      );
    }
    entries.push({
      path: source.relPath,
      repoRelPath: source.relPath,
      mode: entry.mode,
      blobId: entry.object,
    });
  }
  const presence = fragmentTargetPresenceInPaths(
    kind,
    name,
    entries.map((entry) => entry.repoRelPath),
  );
  let bytes: PinnedBytes[];
  try {
    bytes = await readEntryBytes(dataRepo, entries, memo);
  } catch (cause) {
    const failedEntries =
      cause instanceof GitBlobReadError
        ? entries.filter((entry) => entry.blobId === cause.blobId)
        : entries;
    throw new PreconditionError(
      failedEntries
        .map((entry) => `cannot read ${entry.repoRelPath} at ${commit}`)
        .join("\n"),
      { cause },
    );
  }
  const rawByRelPath = new Map(
    bytes.map((entry) => [entry.path, entry.content]),
  );
  const values = new Map<string, ConfigObject>();
  for (const source of presentSources(presence)) {
    const raw = rawByRelPath.get(source.relPath)!;
    try {
      values.set(
        source.relPath,
        parseFragmentSourceText(source, raw.toString("utf-8")),
      );
    } catch (cause) {
      throw new PreconditionError(
        `cannot parse ${source.relPath} at ${commit}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  return { presence, values, rawByRelPath };
}

/**
 * The present half of a presence list. `fragmentSources` and
 * `fragmentSourcesAtCommit` are expressed through this so the records they
 * return are the same objects the coverage report describes, and the two
 * cannot drift.
 */
export function presentSources(presence: TargetPresence[]): FragmentSource[] {
  return presence
    .filter((row) => row.present === true)
    .map((row) => row.source);
}

export async function fragmentSources(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<FragmentSource[]> {
  const sources = presentSources(fragmentTargetPresence(dataRepo, kind, name));
  if (sources.length === 0) {
    throw new PreconditionError(
      `data repo does not have canonical source files for ${kind}/${name}`,
    );
  }
  return sources;
}

export async function fragmentSourcesAtCommit(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
  commit: string,
  manifest?: Manifest,
  memo?: GitReadMemo,
): Promise<FragmentSource[]> {
  return presentSources(
    (
      await loadFragmentSourcesAtCommit({
        dataRepo,
        kind,
        name,
        commit,
        manifest,
        memo,
      })
    ).presence,
  );
}

export async function shaOfFragmentItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<string> {
  const relPaths = await canonicalItemRelPaths(dataRepo, kind, name);
  return hashNamedContents(
    await Promise.all(
      relPaths.map(async (relPath) => ({
        name: relPath,
        content: await readFile(join(dataRepo, ...relPath.split("/"))),
      })),
    ),
  );
}

export async function shaOfFragmentItemAtCommit(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
  commit: string,
): Promise<string> {
  const { rawByRelPath } = await loadFragmentSourcesAtCommit({
    dataRepo,
    kind,
    name,
    commit,
  });
  return hashNamedContents(
    [...rawByRelPath].map(([path, content]) => ({ name: path, content })),
  );
}

export async function lastTouchingFragmentCommit(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<string> {
  await canonicalItemRelPaths(dataRepo, kind, name);
  return await lastTouchingCommitForPaths(
    dataRepo,
    allCanonicalItemRelPaths(kind, name),
  );
}

export async function assertFragmentSourcesClean(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<void> {
  for (const relPath of await canonicalItemRelPaths(dataRepo, kind, name)) {
    await assertPathClean(dataRepo, relPath);
  }
}

export async function readFragmentAtCommit(
  dataRepo: string,
  manifest: Manifest,
  source: FragmentSource,
  commit: string,
): Promise<ConfigObject> {
  const loaded = await loadFragmentSourcesAtCommit({
    dataRepo,
    kind: source.kind,
    name: source.name,
    commit,
    manifest,
  });
  const value = loaded.values.get(source.relPath);
  if (value === undefined)
    throw new PreconditionError(`${source.relPath} is absent at ${commit}`);
  return value;
}

export function parseFragmentSourceText(
  source: FragmentSource,
  raw: string,
): ConfigObject {
  const spec = fragmentOutputSpec(source.target);
  return validateFragmentSource(source, spec.parse(raw, source.relPath));
}

export async function planFragmentOutput(
  opts: ApplyFragmentOutputOptions,
): Promise<FragmentOutputPlan> {
  const spec = fragmentOutputSpec(opts.target);
  const path = spec.outputPath(opts.project);
  const currentText = existsSync(path) ? await readFile(path, "utf-8") : null;
  const current =
    currentText === null
      ? {}
      : spec.parse(currentText, relative(opts.project, path));
  const rawOldManaged = await mergeFragmentContributions({
    dataRepo: opts.dataRepo,
    manifest: opts.oldManifest ?? opts.manifest,
    lock: opts.oldLock,
    target: opts.target,
    memo: opts.memo,
  });
  const oldManaged = spec.normalizeOutput(rawOldManaged);
  const nextFragments = await fragmentValuesForTarget({
    dataRepo: opts.dataRepo,
    manifest: opts.nextManifest ?? opts.manifest,
    lock: opts.nextLock,
    target: opts.target,
    memo: opts.memo,
  });
  const rawNextManaged = mergeConfigObjects(
    nextFragments.map((fragment) => fragment.value),
  );

  const baseValue = removeManagedValue(current, oldManaged) ?? {};
  let base = isPlainConfigObject(baseValue) ? baseValue : {};
  if (spec.isSyntheticOnly(base)) base = {};
  assertNoFragmentConflicts(path, nextFragments);
  assertNoUnmanagedCollisions(path, base, nextFragments);

  const planned = spec.normalizeOutput(mergeConfigObject(base, rawNextManaged));
  const plannedText = spec.isSyntheticOnly(planned)
    ? null
    : spec.stringify(planned);
  const currentSha = currentText === null ? null : shaOfConfig(current);
  const plannedSha = plannedText === null ? null : shaOfConfig(planned);
  const changed =
    plannedText === null
      ? currentText !== null
      : stableStringifyConfig(current) !== stableStringifyConfig(planned);

  const commentLoss =
    changed &&
    currentText !== null &&
    (spec.format === "json"
      ? jsonTextHasComments(currentText)
      : tomlTextHasComments(currentText));

  return {
    target: opts.target,
    path,
    currentText,
    plannedText,
    currentSha,
    plannedSha,
    changed,
    commentLoss,
    commentPolicy: commentLossPolicy(spec.format),
  };
}

export async function applyFragmentOutput(
  opts: ApplyFragmentOutputOptions,
): Promise<FragmentApplyResult> {
  const plan = await planFragmentOutput(opts);
  return (await applyFragmentOutputPlans([plan], { dryRun: opts.dryRun }))[0]!;
}

export async function applyFragmentOutputPlans(
  plans: FragmentOutputPlan[],
  opts: ApplyFragmentPlansOptions = {},
): Promise<FragmentApplyResult[]> {
  if (opts.dryRun) {
    return plans.map((plan) => fragmentApplyResult(plan, true));
  }

  for (const plan of plans) {
    const currentText = existsSync(plan.path)
      ? await readFile(plan.path, "utf-8")
      : null;
    if (currentText !== plan.currentText) {
      throw new PreconditionError(
        `cannot reconcile ${plan.path}: the output changed after preflight; retry`,
      );
    }
  }

  const attempted: FragmentOutputPlan[] = [];
  try {
    for (const [index, plan] of plans.entries()) {
      if (!plan.changed) continue;
      if (plan.commentLoss) {
        console.error(
          plan.commentPolicy === "gate"
            ? `⚠ ${plan.path}: comments in this file are not preserved when capshelf rewrites its managed content`
            : `⚠ ${plan.path}: comments removed — the tool that reads this file requires strict JSON, so it was not loading the file at all; the rewrite repairs that`,
        );
      }
      await opts.beforeWrite?.(plan, index);
      attempted.push(plan);
      await writeFragmentPlan(plan, plan.plannedText);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const plan of attempted.reverse()) {
      try {
        await writeFragmentPlan(plan, plan.currentText);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    throw error;
  }

  return plans.map((plan) => fragmentApplyResult(plan, false));
}

function fragmentApplyResult(
  plan: FragmentOutputPlan,
  dryRun: boolean,
): FragmentApplyResult {
  return {
    key: fragmentTargetKey(plan.target),
    source: "data",
    target: plan.target,
    action: plan.changed
      ? dryRun
        ? "would-reconcile"
        : "reconciled"
      : "already-current",
    path: plan.path,
    currentSha: plan.currentSha,
    plannedSha: plan.plannedSha,
    ...(dryRun && { dryRun: true as const }),
  };
}

async function writeFragmentPlan(
  plan: FragmentOutputPlan,
  text: string | null,
): Promise<void> {
  if (text === null) {
    await rm(plan.path, { force: true });
    return;
  }
  await mkdir(dirname(plan.path), { recursive: true });
  await atomicWriteFile(plan.path, text);
}

export async function fragmentContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  target: FragmentTarget,
  memo?: GitReadMemo,
): Promise<FragmentContributionState> {
  const spec = fragmentOutputSpec(target);
  const path = spec.outputPath(project);
  const managed = spec.normalizeOutput(
    await mergeFragmentContributions({
      dataRepo,
      manifest,
      lock,
      target,
      memo,
    }),
  );
  if (spec.isSyntheticOnly(managed)) return "ok";
  if (!existsSync(path)) return "missing";
  const current = spec.parse(
    await readFile(path, "utf-8"),
    relative(project, path),
  );
  return containsManagedOutput(current, managed) ? "ok" : "drifted";
}

export function isFragmentKind(kind: ItemKind): kind is FragmentItemKind {
  return isFragmentItemKind(kind);
}

export async function currentFragmentSourcesForItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<FragmentSource[]> {
  return await fragmentSources(dataRepo, kind, name);
}

export async function lockedFragmentTargetsForItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
  entry: DataLockEntry,
  manifest?: Manifest,
  memo?: GitReadMemo,
): Promise<FragmentTarget[]> {
  const sources = await fragmentSourcesAtCommit(
    dataRepo,
    kind,
    name,
    entry.sourceCommit,
    manifest,
    memo,
  );
  return uniqueTargets(sources);
}

export async function currentFragmentTargetsForItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<FragmentTarget[]> {
  return uniqueTargets(await fragmentSources(dataRepo, kind, name));
}

export async function touchedFragmentTargetsForItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
  oldEntry?: DataLockEntry,
  manifest?: Manifest,
  memo?: GitReadMemo,
): Promise<FragmentTarget[]> {
  const targets = oldEntry
    ? await lockedFragmentTargetsForItem(
        dataRepo,
        kind,
        name,
        oldEntry,
        manifest,
        memo,
      )
    : [];
  if (await findMasterItemByRef(dataRepo, { kind, name })) {
    targets.push(
      ...(await currentFragmentTargetsForItem(dataRepo, kind, name)),
    );
  }
  return [...new Set(targets)];
}

export function allFragmentTargets(): FragmentTarget[] {
  return ["claude-settings", "claude-mcp", "codex-config"];
}

export function fragmentTargetsForKinds(
  kinds: Iterable<FragmentItemKind>,
): FragmentTarget[] {
  const targets: FragmentTarget[] = [];
  for (const kind of kinds) {
    switch (kind) {
      case "settings":
        targets.push("claude-settings");
        break;
      case "mcp":
        targets.push("claude-mcp", "codex-config");
        break;
      case "codex-config":
        targets.push("codex-config");
        break;
      default:
        assertNever(kind);
    }
  }
  return [...new Set(targets)];
}

export function fragmentKindForTarget(
  target: FragmentTarget,
): FragmentItemKind {
  switch (target) {
    case "claude-settings":
      return "settings";
    case "claude-mcp":
      return "mcp";
    case "codex-config":
      return "codex-config";
    default:
      return assertNever(target);
  }
}

export function sourceTargetForCli(
  value: string | undefined,
): FragmentSourceTarget | null {
  if (value === undefined) return null;
  if (value === "claude" || value === "codex") return value;
  throw new Error(`invalid target "${value}" (expected claude or codex)`);
}

export function sourceMatchesCliTarget(
  source: FragmentSource,
  target: FragmentSourceTarget | null,
): boolean {
  return target === null || source.sourceTarget === target;
}

export function assertFragmentKind(
  kind: ItemKind,
  verb: string,
): FragmentItemKind {
  if (isFragmentItemKind(kind)) return kind;
  throw new Error(`${verb} expected a fragment item`);
}

export function allCanonicalFragmentRelPaths(
  kind: FragmentItemKind,
  name: string,
): string[] {
  return allCanonicalItemRelPaths(kind, name);
}

async function mergeFragmentContributions(opts: {
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  target: FragmentTarget;
  memo?: GitReadMemo;
}): Promise<ConfigObject> {
  return mergeConfigObjects(
    (await fragmentValuesForTarget(opts)).map((fragment) => fragment.value),
  );
}

export async function fragmentValuesForTarget(opts: {
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  target: FragmentTarget;
  memo?: GitReadMemo;
}): Promise<FragmentValue[]> {
  const values: FragmentValue[] = [];
  for (const kind of contributionKindsForTarget(opts.target)) {
    for (const name of manifestNamesForKind(opts.manifest, kind)) {
      const entry = opts.lock.items[dataKey(kind, name)];
      if (entry?.source !== "data" || entry.local === true) continue;
      const loaded = await loadFragmentSourcesAtCommit({
        dataRepo: opts.dataRepo,
        kind,
        name,
        commit: entry.sourceCommit,
        manifest: opts.manifest,
        memo: opts.memo,
      });
      for (const source of presentSources(loaded.presence)) {
        if (source.target !== opts.target) continue;
        values.push({ source, value: loaded.values.get(source.relPath)! });
      }
    }
  }
  return values;
}

function contributionKindsForTarget(
  target: FragmentTarget,
): FragmentItemKind[] {
  switch (target) {
    case "claude-settings":
      return ["settings"];
    case "claude-mcp":
      return ["mcp"];
    case "codex-config":
      return ["codex-config", "mcp"];
    default:
      return assertNever(target);
  }
}

function validateFragmentSource(
  source: FragmentSource,
  value: ConfigObject,
): ConfigObject {
  if (source.kind === "settings") {
    return validateClaudeSettingsFragment(value, source.relPath);
  }
  if (source.kind === "mcp" && source.sourceTarget === "claude") {
    return validateClaudeMcpFragment(value, source.relPath);
  }
  if (source.kind === "mcp" && source.sourceTarget === "codex") {
    return validateCodexMcpFragment(value, source.relPath);
  }
  return validateCodexConfigFragment(value, source.relPath);
}

async function assertSourceCommitExists(
  dataRepo: string,
  commit: string,
  manifest?: Manifest,
  memo?: GitReadMemo,
): Promise<void> {
  if (await commitExists(dataRepo, commit, memo)) return;
  if (manifest) {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  throw new Error(`data repo at ${dataRepo} does not contain commit ${commit}`);
}

function assertNoUnmanagedCollisions(
  outputPath: string,
  base: ConfigObject,
  fragments: FragmentValue[],
): void {
  for (const fragment of fragments) {
    const collision = findUnmanagedCollision(base, fragment.value);
    if (!collision) continue;
    throw new Error(
      `cannot reconcile ${outputPath}: ${fragment.source.relPath} would overwrite unmanaged local value at ${configPathLabel(collision.path)} (${collision.localKind} vs ${collision.managedKind}). Edit the local output, change fragment order, or remove the conflicting fragment.`,
    );
  }
}

/**
 * Refuse when two fragments targeting the same output set the same key to
 * conflicting values. Without this, mergeConfigValues resolves scalar
 * conflicts as last-write-wins (config-values.ts), so the output would depend
 * silently on manifest order. Arrays (concat+dedupe), deep-mergeable objects,
 * and identical values are not conflicts and merge as before.
 */
function assertNoFragmentConflicts(
  outputPath: string,
  fragments: FragmentValue[],
): void {
  let mergedSoFar: ConfigObject = {};
  // Leaf path -> the fragment that set it, so a conflict names both.
  const provenance = new Map<string, string>();
  for (const fragment of fragments) {
    const collision = findUnmanagedCollision(mergedSoFar, fragment.value);
    if (collision) {
      const earlier =
        provenance.get(provenanceKey(collision.path)) ?? "an earlier fragment";
      throw new Error(
        `cannot reconcile ${outputPath}: ${fragment.source.relPath} and ${earlier} set a conflicting value at ${configPathLabel(collision.path)} (${collision.managedKind} vs ${collision.localKind}). Two fragments set the same key to different values — reconcile or remove one.`,
      );
    }
    recordLeafProvenance(
      fragment.value,
      fragment.source.relPath,
      [],
      provenance,
    );
    mergedSoFar = mergeConfigObject(mergedSoFar, fragment.value);
  }
}

function recordLeafProvenance(
  value: ConfigObject,
  source: string,
  prefix: string[],
  out: Map<string, string>,
): void {
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isPlainConfigObject(child)) {
      recordLeafProvenance(child, source, path, out);
    } else {
      out.set(provenanceKey(path), source);
    }
  }
}

/**
 * The map key for a leaf path.
 *
 * One writer and one reader must agree on this, and nothing else in the file
 * enforces that, so it is a function rather than a separator repeated twice. A
 * joined string needs a character no key contains, and both JSON and YAML let
 * a key hold any character at all. `JSON.stringify` escapes instead of
 * guessing, so distinct paths cannot collide.
 */
function provenanceKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function containsManagedOutput(
  current: ConfigObject,
  managed: ConfigObject,
): boolean {
  return Object.entries(managed).every(([key, value]) => {
    if (!Object.hasOwn(current, key)) return false;
    if (Array.isArray(value)) {
      const currentArray = current[key];
      if (!Array.isArray(currentArray)) return false;
      const currentKeys = new Set(currentArray.map(stableStringifyConfig));
      return value.every((entry) =>
        currentKeys.has(stableStringifyConfig(entry)),
      );
    }
    if (isPlainConfigObject(value)) {
      const currentValue = current[key];
      if (!isPlainConfigObject(currentValue)) return false;
      return containsManagedOutput(currentValue, value);
    }
    return stableStringifyConfig(current[key]) === stableStringifyConfig(value);
  });
}

function uniqueTargets(sources: FragmentSource[]): FragmentTarget[] {
  return [...new Set(sources.map((source) => source.target))];
}

function identityOutput(value: ConfigObject): ConfigObject {
  return cloneConfig(value);
}

function isEmptyObject(value: ConfigObject): boolean {
  return Object.keys(value).length === 0;
}
