import type { ItemKind } from "./master";
import type { Manifest } from "./manifest";
import { addManifestName, removeManifestName } from "./manifest";
import { entryIdentity } from "./lock";
import type {
  DataLockEntry,
  DataLockEntryV4,
  Lock,
  WritableLock,
} from "./lock";
import type { LocalConfig } from "./local-config";
import type { RuntimeWarning } from "./runtime-warnings";
import type { PinnedSource } from "./pin";
import type { ItemRef } from "./item-ref";
import type { PreviousOwnerKind } from "./previous-owner";
import type { SidecarProvenance } from "./metadata";
import type { NamedFile } from "./merge-tree";
import { claudeSkillPath, codexSkillPath, installedPath } from "./installed";

export type Scope = "project" | "local";

export interface PromoteResult {
  source: "data";
  kind: ItemKind;
  name: string;
  /**
   * "already-upstream": content is byte-identical to upstream, so the lock was
   * re-pinned without a commit. Consumers must tolerate new action values.
   */
  action: "promoted" | "created" | "already-current" | "already-upstream";
  sha: string;
  sourceCommit: string;
  pin?: PinnedSource;
  committed: boolean;
  adoptedFrom?: PreviousOwnerKind;
  previousOwnerReleased?: boolean;
  staleOverride?: true;
  runtimeWarnings?: RuntimeWarning[];
  privateDotenvWarnings?: string[];
}

export interface AdoptOptions {
  installMode: Manifest["installMode"];
  message?: string;
  sourceScope?: Scope;
  allowExistingUpstream?: boolean;
  allowPreviousOwner?: boolean;
  /**
   * Written to the sidecar in the same commit; the sidecar is excluded from the
   * pin, so it changes no identity.
   */
  provenance?: SidecarProvenance;
  /**
   * Runs before any data-repo write, and the commit proof refuses a tree that
   * differs from the candidate, so a check over it binds the commit.
   */
  checkCandidate?: (candidate: AdoptionCandidate) => Promise<void>;
}

export interface AdoptionCandidate {
  files: NamedFile[];
  snapshot: ItemSnapshot;
  path: string;
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
 * Compares `entryIdentity` (digest in v4, `sha` before) so a v3 entry is never
 * asked for a value it lacks.
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
 * A writer runs after `assertWritableLock`, so it can read
 * `entry.sourcePinDigest` as a `string` without defending against legacy
 * shapes.
 */
export function dataEntryV4OrThrow(
  entry: WritableLock["items"][string] | undefined,
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
