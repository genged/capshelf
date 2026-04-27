import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeDir } from "./paths";
import { dataKey, type Lock } from "./lock";
import type { Manifest } from "./manifest";
import { showAtCommit } from "./git";
import { missingSourceCommitMessage } from "./upstream-check";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const CLAUDE_SETTINGS_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

export interface SettingsApplyResult {
  action: "reconciled" | "would-reconcile" | "already-current";
  path: string;
  currentSha: string | null;
  plannedSha: string;
  dryRun?: true;
}

export type SettingsContributionState = "ok" | "missing" | "drifted";

export interface ApplySettingsOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  oldManifest?: Manifest;
  nextManifest?: Manifest;
  oldLock: Lock;
  nextLock: Lock;
  dryRun?: boolean;
}

export interface SettingsOutputPlan {
  path: string;
  currentText: string | null;
  plannedText: string;
  currentSha: string | null;
  plannedSha: string;
  changed: boolean;
}

export function settingsOutputPath(project: string): string {
  return join(claudeDir(project), "settings.json");
}

export async function applySettingsFragments(
  opts: ApplySettingsOptions,
): Promise<SettingsApplyResult> {
  const plan = await planSettingsOutput(opts);

  if (!opts.dryRun && plan.changed) {
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, plan.plannedText);
  }

  return {
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

export async function planSettingsOutput(
  opts: ApplySettingsOptions,
): Promise<SettingsOutputPlan> {
  const path = settingsOutputPath(opts.project);
  const currentText = existsSync(path) ? await readFile(path, "utf-8") : null;
  const current = currentText === null ? {} : parseJsonObject(currentText, path);
  const oldManaged = await mergedManagedSettings(
    opts.dataRepo,
    opts.oldManifest ?? opts.manifest,
    opts.oldLock,
  );
  const nextManaged = await mergedManagedSettings(
    opts.dataRepo,
    opts.nextManifest ?? opts.manifest,
    opts.nextLock,
  );

  const baseValue = removeManaged(current, oldManaged) ?? {};
  const base = isPlainObject(baseValue) ? baseValue : {};
  const planned = withSchema(mergeClaudeSettings(base, nextManaged));
  const plannedText = JSON.stringify(stableSort(planned), null, 2) + "\n";
  const currentSha = currentText === null ? null : shaOfJson(current);
  const plannedSha = shaOfJson(planned);

  return {
    path,
    currentText,
    plannedText,
    currentSha,
    plannedSha,
    changed: stableStringify(current) !== stableStringify(planned),
  };
}

export async function settingsContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<SettingsContributionState> {
  const path = settingsOutputPath(project);
  const managed = await mergedManagedSettings(dataRepo, manifest, lock);
  if (Object.keys(managed).length === 0) return "ok";
  if (!existsSync(path)) return "missing";

  const current = await readJsonObject(path);
  return containsManaged(current, managed) ? "ok" : "drifted";
}

async function mergedManagedSettings(
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<JsonObject> {
  const fragments: JsonObject[] = [];
  for (const name of manifest.settings) {
    const entry = lock.items[dataKey("settings", name)];
    if (!entry || entry.source !== "data" || entry.local === true) continue;
    fragments.push(
      await readSettingsFragmentAtCommit(
        dataRepo,
        manifest,
        name,
        entry.sourceCommit,
      ),
    );
  }
  return mergeSettingsFragments(fragments);
}

export function mergeSettingsFragments(fragments: JsonObject[]): JsonObject {
  let merged: JsonObject = {};
  for (const fragment of fragments) {
    merged = mergeClaudeSettings(merged, fragment);
  }
  return merged;
}

async function readSettingsFragmentAtCommit(
  dataRepo: string,
  manifest: Manifest,
  name: string,
  commit: string,
): Promise<JsonObject> {
  let raw: Buffer;
  try {
    raw = await showAtCommit(dataRepo, commit, `settings/${name}/settings.json`);
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  return parseJsonObject(raw.toString("utf-8"), `settings/${name}/settings.json`);
}

async function readJsonObject(path: string): Promise<JsonObject> {
  return parseJsonObject(await readFile(path, "utf-8"), path);
}

function parseJsonObject(raw: string, label: string): JsonObject {
  const parsed = JSON.parse(raw) as JsonValue;
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function mergeClaudeSettings(base: JsonObject, overlay: JsonObject): JsonObject {
  return mergeValues(base, overlay) as JsonObject;
}

function mergeValues(base: JsonValue | undefined, overlay: JsonValue): JsonValue {
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return dedupeArray([...base, ...overlay]);
  }
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: JsonObject = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      out[key] = key in out ? mergeValues(out[key], value) : cloneJson(value);
    }
    return out;
  }
  return cloneJson(overlay);
}

function removeManaged(
  current: JsonValue | undefined,
  managed: JsonValue | undefined,
): JsonValue | undefined {
  if (managed === undefined) return cloneJson(current);
  if (current === undefined) return undefined;

  if (Array.isArray(current) && Array.isArray(managed)) {
    const managedKeys = new Set(managed.map(stableStringify));
    const kept = current.filter((value) => !managedKeys.has(stableStringify(value)));
    return kept.length > 0 ? kept : undefined;
  }

  if (isPlainObject(current) && isPlainObject(managed)) {
    const out: JsonObject = { ...current };
    for (const key of Object.keys(managed)) {
      const next = removeManaged(out[key], managed[key]);
      if (next === undefined) delete out[key];
      else out[key] = next;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return stableStringify(current) === stableStringify(managed)
    ? undefined
    : cloneJson(current);
}

function containsManaged(current: JsonValue | undefined, managed: JsonValue): boolean {
  if (Array.isArray(managed)) {
    if (!Array.isArray(current)) return false;
    const currentKeys = new Set(current.map(stableStringify));
    return managed.every((value) => currentKeys.has(stableStringify(value)));
  }

  if (isPlainObject(managed)) {
    if (!isPlainObject(current)) return false;
    return Object.entries(managed).every(([key, value]) =>
      containsManaged(current[key], value),
    );
  }

  return stableStringify(current) === stableStringify(managed);
}

function withSchema(settings: JsonObject): JsonObject {
  if ("$schema" in settings) return settings;
  return { $schema: CLAUDE_SETTINGS_SCHEMA, ...settings };
}

function dedupeArray(values: JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const out: JsonValue[] = [];
  for (const value of values) {
    const key = stableStringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cloneJson(value));
  }
  return out;
}

function shaOfJson(value: JsonValue): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableStringify(value));
  return hasher.digest("hex").slice(0, 12);
}

function stableStringify(value: JsonValue | undefined): string {
  return JSON.stringify(stableSort(value));
}

function stableSort(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.map(stableSort) as JsonValue[];
  if (!isPlainObject(value)) return value;

  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableSort(value[key]) as JsonValue;
  }
  return out;
}

function cloneJson<T extends JsonValue | undefined>(value: T): T {
  return value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
