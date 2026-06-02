import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  cloneConfig,
  configPathLabel,
  findUnmanagedCollision,
  isPlainConfigObject,
  mergeConfigObjects,
  mergeConfigValues,
  removeManagedValue,
  shaOfConfig,
  stableStringifyConfig,
  type ConfigObject,
} from "./config-values";
import {
  isSyntheticOnlyClaudeSettings,
  normalizeClaudeSettingsOutput,
  parseJsonConfigObject,
  stringifyJsonConfig,
  validateClaudeMcpFragment,
  validateClaudeSettingsFragment,
} from "./json-fragments";
import {
  parseTomlConfigObject,
  stringifyTomlConfig,
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
  assertPathClean,
  commitExists,
  lastTouchingCommitForPaths,
  showAtCommit,
} from "./git";
import { missingSourceCommitMessage } from "./upstream-check";

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

interface FragmentValue {
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

export async function fragmentSources(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<FragmentSource[]> {
  const sources = fragmentSourceCandidates(kind, name).filter((source) =>
    existsSync(join(dataRepo, ...source.relPath.split("/"))),
  );
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
): Promise<FragmentSource[]> {
  await assertSourceCommitExists(dataRepo, commit, manifest);
  const sources: FragmentSource[] = [];
  for (const source of fragmentSourceCandidates(kind, name)) {
    if (await sourceExistsAtCommit(dataRepo, commit, source.relPath)) {
      sources.push(source);
    }
  }
  return sources;
}

export async function shaOfFragmentItem(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<string> {
  const relPaths = await canonicalItemRelPaths(dataRepo, kind, name);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const relPath of relPaths.sort()) {
    hasher.update(relPath);
    hasher.update("\0");
    hasher.update(await readFile(join(dataRepo, ...relPath.split("/"))));
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
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
  let raw: Buffer;
  try {
    raw = await showAtCommit(dataRepo, commit, source.relPath);
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  const spec = fragmentOutputSpec(source.target);
  const parsed = spec.parse(raw.toString("utf-8"), source.relPath);
  return validateFragmentSource(source, parsed);
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
  });
  const oldManaged = spec.normalizeOutput(rawOldManaged);
  const nextFragments = await fragmentValuesForTarget({
    dataRepo: opts.dataRepo,
    manifest: opts.nextManifest ?? opts.manifest,
    lock: opts.nextLock,
    target: opts.target,
  });
  const rawNextManaged = mergeConfigObjects(
    nextFragments.map((fragment) => fragment.value),
  );

  const baseValue = removeManagedValue(current, oldManaged) ?? {};
  let base = isPlainConfigObject(baseValue) ? baseValue : {};
  if (spec.isSyntheticOnly(base)) base = {};
  assertNoUnmanagedCollisions(path, base, nextFragments);

  const planned = spec.normalizeOutput(
    mergeConfigValues(base, rawNextManaged) as ConfigObject,
  );
  const plannedText = spec.isSyntheticOnly(planned)
    ? null
    : spec.stringify(planned);
  const currentSha = currentText === null ? null : shaOfConfig(current);
  const plannedSha = plannedText === null ? null : shaOfConfig(planned);
  const changed =
    plannedText === null
      ? currentText !== null
      : stableStringifyConfig(current) !== stableStringifyConfig(planned);

  return {
    target: opts.target,
    path,
    currentText,
    plannedText,
    currentSha,
    plannedSha,
    changed,
  };
}

export async function applyFragmentOutput(
  opts: ApplyFragmentOutputOptions,
): Promise<FragmentApplyResult> {
  const plan = await planFragmentOutput(opts);
  if (!opts.dryRun && plan.changed) {
    if (plan.plannedText === null) {
      await rm(plan.path, { force: true });
    } else {
      await mkdir(dirname(plan.path), { recursive: true });
      await writeFile(plan.path, plan.plannedText);
    }
  }
  return {
    key: fragmentTargetKey(opts.target),
    source: "data",
    target: opts.target,
    action: plan.changed
      ? opts.dryRun
        ? "would-reconcile"
        : "reconciled"
      : "already-current",
    path: plan.path,
    currentSha: plan.currentSha,
    plannedSha: plan.plannedSha,
    ...(opts.dryRun && { dryRun: true as const }),
  };
}

export async function fragmentContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  target: FragmentTarget,
): Promise<FragmentContributionState> {
  const spec = fragmentOutputSpec(target);
  const path = spec.outputPath(project);
  const managed = spec.normalizeOutput(
    await mergeFragmentContributions({ dataRepo, manifest, lock, target }),
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
): Promise<FragmentTarget[]> {
  const sources = await fragmentSourcesAtCommit(
    dataRepo,
    kind,
    name,
    entry.sourceCommit,
    manifest,
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
): Promise<FragmentTarget[]> {
  const targets = oldEntry
    ? await lockedFragmentTargetsForItem(
        dataRepo,
        kind,
        name,
        oldEntry,
        manifest,
      )
    : [];
  try {
    targets.push(
      ...(await currentFragmentTargetsForItem(dataRepo, kind, name)),
    );
  } catch {
    // Missing current upstream is handled by the caller for item-level status.
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
}): Promise<ConfigObject> {
  return mergeConfigObjects(
    (await fragmentValuesForTarget(opts)).map((fragment) => fragment.value),
  );
}

async function fragmentValuesForTarget(opts: {
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  target: FragmentTarget;
}): Promise<FragmentValue[]> {
  const values: FragmentValue[] = [];
  for (const kind of contributionKindsForTarget(opts.target)) {
    for (const name of manifestNamesForKind(opts.manifest, kind)) {
      const entry = opts.lock.items[dataKey(kind, name)];
      if (entry?.source !== "data" || entry.local === true) continue;
      await assertSourceCommitExists(
        opts.dataRepo,
        entry.sourceCommit,
        opts.manifest,
      );
      for (const source of fragmentSourceCandidates(kind, name)) {
        if (source.target !== opts.target) continue;
        if (
          !(await sourceExistsAtCommit(
            opts.dataRepo,
            entry.sourceCommit,
            source.relPath,
          ))
        ) {
          continue;
        }
        values.push({
          source,
          value: await readFragmentAtCommit(
            opts.dataRepo,
            opts.manifest,
            source,
            entry.sourceCommit,
          ),
        });
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
): Promise<void> {
  if (await commitExists(dataRepo, commit)) return;
  if (manifest) {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  throw new Error(`data repo at ${dataRepo} does not contain commit ${commit}`);
}

async function sourceExistsAtCommit(
  dataRepo: string,
  commit: string,
  relPath: string,
): Promise<boolean> {
  try {
    await showAtCommit(dataRepo, commit, relPath);
    return true;
  } catch {
    return false;
  }
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

function containsManagedOutput(
  current: ConfigObject,
  managed: ConfigObject,
): boolean {
  return Object.entries(managed).every(([key, value]) => {
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
