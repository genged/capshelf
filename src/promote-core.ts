import type { ItemKind } from "./master";
import type { Manifest } from "./manifest";
import { addManifestName, removeManifestName } from "./manifest";
import { entryIdentity } from "./lock";
import type { DataLockEntry, DataLockEntryV4, Lock, LockV4 } from "./lock";
import type { LocalConfig } from "./local-config";
import type { RuntimeWarning } from "./runtime-warnings";
import type { PinnedSource } from "./pin";
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
  /**
   * The pin for the commit this result names, built by `src/pin.ts` from the
   * committed tree after PIN-11 proved it equals what the project held. Absent
   * only on paths that publish nothing new (`already-current`).
   */
  pin?: PinnedSource;
  committed: boolean;
  /** present only when --stale-ok actually bypassed a stale check */
  staleOverride?: true;
  /** present only when --merge performed a stale three-way merge */
  merged?: true;
  /** full locked base commit used by an actual merge */
  mergeBase?: string;
  /** full data-repo HEAD merged into the installed item */
  mergedUpstreamCommit?: string;
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

/**
 * Whether two data entries select the same content. Compares the identity each
 * one records — `sourcePinDigest` under lock version 4, `sha` before it — via
 * `entryIdentity`, so it never asks a v3 entry for a value it does not carry.
 */
export function dataEntriesMatch(a: DataLockEntry, b: DataLockEntry): boolean {
  return (
    a.source === b.source &&
    entryIdentity(a) === entryIdentity(b) &&
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

/**
 * The same narrowing for a writer, which by definition runs against a lock
 * `assertLockV4` has already accepted. Keeping it explicit means a promote
 * path can read `entry.sourcePinDigest` as a `string` rather than defending
 * against a legacy shape it can never see.
 */
export function dataEntryV4OrThrow(
  entry: LockV4["items"][string] | undefined,
  key: string,
): DataLockEntryV4 {
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
