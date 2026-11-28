/** Shared by server and client so a renamed field fails to type-check. */
import type {
  ExternalClaudePlugin,
  ExternalSkill,
  ExternalUserSkill,
} from "../../external";
import type { ItemKind } from "../../master";
import type { ItemNeeds } from "../../metadata";
import type { InstallMode } from "../../paths";
import type {
  ExternalPersonalClaudeSkill,
  RowSource,
  StatusRow,
} from "../../status-core";
import type { StatusDiff } from "../../status-diff";

export type DiffViewName = "installed" | "upstream";

export type StateTone = "ok" | "attention" | "kept";

export interface UiAction {
  command: string;
  purpose: string;
}

export interface UiRegisteredProject {
  path: string;
  display: string;
  exists: boolean;
  registeredAt: string;
}

export interface UiShelfRef {
  dataRepo: string;
  display: string;
}

export interface UiOverview {
  host: string;
  cliVersion: string;
  currentProject: string | null;
  registryPath: string;
  registryDisplay: string;
  home: string;
  dataOverride: string | null;
  projects: UiRegisteredProject[];
  shelves: UiShelfRef[];
  generatedAt: string;
}

export interface UiRevision {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface UiShelfFacts {
  dataRepo: string;
  display: string;
  head: string;
  headShort: string;
  branch: string | null;
  origin: string | null;
  clean: boolean;
  revisions: UiRevision[];
}

export interface UiItem {
  id: string;
  ref: string;
  kind: ItemKind;
  name: string;
  scope: "project" | "local";
  source: RowSource;
  row: StatusRow;
  attention: boolean;
  tone: StateTone;
  stateLabel: string;
  stateDetail: string;
  /** The `status` invocation line for a skill, or null with no transcripts. */
  invocationDetail: string | null;
  actions: UiAction[];
  diffViews: DiffViewName[];
  installedPath: string | null;
}

export interface UiNotice {
  level: "info" | "warn";
  message: string;
  actions?: UiAction[];
}

export interface UiProjectStatus {
  project: string;
  display: string;
  cdCommand: string;
  dataRepo: string | null;
  dataRepoDisplay: string | null;
  dataRepoUpstream: string | null;
  lockVersion: number;
  localLockVersion: number;
  installMode: InstallMode;
  cliVersion: string;
  items: UiItem[];
  external: ExternalSkill[];
  externalClaudePlugins: ExternalClaudePlugin[];
  externalUserSkills: ExternalUserSkill[];
  personalClaudeExternal: ExternalPersonalClaudeSkill[];
  shelf: UiShelfFacts | null;
  notices: UiNotice[];
  /**
   * Diff requests name this id so the comparison comes from these rows, not a
   * later read.
   */
  snapshot: string;
  generatedAt: string;
}

export interface UiDiffResponse {
  item: string;
  view: DiffViewName;
  diff: StatusDiff | null;
}

export interface UiItemUsage {
  project: string;
  display: string;
  scope: "project" | "local";
  /** Null for a system entry, which pins a CLI version instead. */
  sourceCommit: string | null;
  sourceCommitShort: string | null;
  cliVersion: string | null;
  lockedSha: string;
  current: boolean | null;
  keptLocal: boolean;
}

export interface UiShelfItem {
  ref: string;
  kind: ItemKind;
  name: string;
  source: "data" | "system";
  description?: string;
  tags: string[];
  lastCommit: UiRevision | null;
  usage: UiItemUsage[];
}

export interface UiBundle {
  ref: string;
  name: string;
  description?: string;
  tags: string[];
  members: string[];
  malformed?: string;
}

export interface UiShelf {
  dataRepo: string;
  display: string;
  facts: UiShelfFacts;
  items: UiShelfItem[];
  bundles: UiBundle[];
  warnings: string[];
  projects: UiRegisteredProject[];
  generatedAt: string;
}

export interface UiShelfFile {
  name: string;
  text: string | null;
  binary: boolean;
  size: number;
}

export interface UiShelfItemMetadata {
  description?: string;
  tags: string[];
  requires: string[];
  conflictsWith: string[];
  needs: ItemNeeds;
  warnings: string[];
}

export interface UiShelfItemDetail extends UiShelfItem {
  path: string | null;
  metadata: UiShelfItemMetadata;
  files: string[];
  file: UiShelfFile | null;
}

export interface UiError {
  error: {
    message: string;
    hint?: string;
    exitCode?: number;
  };
}
