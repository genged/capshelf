import type { ItemKind } from "./master";
import type { Manifest } from "./manifest";
import { addManifestName, removeManifestName } from "./manifest";
import type { DataLockEntry, Lock } from "./lock";
import type { LocalConfig } from "./local-config";
import type { RuntimeWarning } from "./runtime-warnings";
import type { ItemRef } from "./item-ref";
import { claudeSkillPath, codexSkillPath, installedPath } from "./installed";

export type Scope = "project" | "local";

export interface PromoteResult {
  source: "data";
  kind: ItemKind;
  name: string;
  /**
   * "already-upstream": the content being promoted is byte-identical to what
   * upstream already has (e.g. a teammate promoted the same fix first); the
   * lock was re-pinned without a commit. Consumers must tolerate new action
   * values (append-only enum).
   */
  action: "promoted" | "created" | "already-current" | "already-upstream";
  sha: string;
  sourceCommit: string;
  committed: boolean;
  /** present only when --stale-ok actually bypassed a stale check */
  staleOverride?: true;
  runtimeWarnings?: RuntimeWarning[];
  privateDotenvWarnings?: string[];
}

export interface AdoptOptions {
  installMode: Manifest["installMode"];
  message?: string;
  sourceScope?: Scope;
}

export interface MoveScopeState {
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  localConfig: LocalConfig | null;
}

export interface MoveScopeResult {
  kind: ItemKind;
  name: string;
  from: Scope;
  to: Scope;
  sha: string;
  sourceCommit: string;
  alreadyCurrent?: true;
}

export interface ItemSnapshot {
  source: "git-visible" | "filesystem";
  localPath: string;
  sha: string;
  files: string[];
}

export function expectedAdoptionPath(
  project: string,
  kind: ItemKind,
  name: string,
  mode: Manifest["installMode"],
): string {
  if (kind === "skills" && mode !== "claude-only") {
    return `${codexSkillPath(project, name)} or ${claudeSkillPath(project, name)}`;
  }
  return installedPath(project, kind, name, mode);
}

export function dataEntriesMatch(a: DataLockEntry, b: DataLockEntry): boolean {
  return (
    a.source === b.source &&
    a.sha === b.sha &&
    a.sourceCommit === b.sourceCommit
  );
}

export function dataEntryOrThrow(
  entry: Lock["items"][string] | undefined,
  key: string,
): DataLockEntry {
  if (entry?.source !== "data") {
    throw new Error(`expected data lock entry for ${key}`);
  }
  return entry;
}

export function refDisplay(ref: ItemRef): string {
  return `${ref.kind ? `${ref.kind}/` : ""}${ref.name}`;
}

export function addToManifest(m: Manifest, kind: ItemKind, name: string): void {
  addManifestName(m, kind, name);
}

export function removeFromManifest(
  m: Manifest,
  kind: ItemKind,
  name: string,
): void {
  removeManifestName(m, kind, name);
}
