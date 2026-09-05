/**
 * The JSON the web UI server sends and the client reads. Both sides import
 * this file, so a field renamed on one side fails to type-check on the other.
 *
 * Every row, diff, and state here is the CLI's own value. The server adds
 * labels and commands; it computes no new fact.
 */
import type {
  ExternalClaudePlugin,
  ExternalSkill,
  ExternalUserSkill,
} from "../../external";
import type { ItemKind } from "../../master";
import type { ItemNeeds } from "../../metadata";
import type { InstallMode } from "../../paths";
import type { ExternalPersonalClaudeSkill, StatusRow } from "../../status-core";
import type { StatusDiff } from "../../status-diff";

export type DiffViewName = "installed" | "upstream";

export type StateTone = "ok" | "attention" | "kept";

export interface UiAction {
  command: string;
  purpose: string;
}

export interface UiRegisteredProject {
  /** Absolute path, as the registry holds it. */
  path: string;
  /** Home-relative path for display. */
  display: string;
  /** Whether a manifest exists at the path today. */
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
  /** The project `capshelf ui` ran inside, when it ran inside one. */
  currentProject: string | null;
  registryPath: string;
  registryDisplay: string;
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
  /** `git status --porcelain` printed nothing. */
  clean: boolean;
  revisions: UiRevision[];
}

export interface UiItem {
  /** `<scope>/<source>/<kind>/<name>`, unique in a project. */
  id: string;
  ref: string;
  kind: ItemKind;
  name: string;
  scope: "project" | "local";
  source: "data" | "system";
  /** The row `capshelf status --json` prints, unchanged. */
  row: StatusRow;
  /** `capshelf status --strict` would fail on this row. */
  attention: boolean;
  tone: StateTone;
  /** Short state label for the panel header. */
  stateLabel: string;
  /** The sentence the CLI prints for the state. */
  stateDetail: string;
  actions: UiAction[];
  diffViews: DiffViewName[];
  /** Project-relative install or output path, when one path names it. */
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
  /** `cd <project>`, quoted for a shell. */
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
  generatedAt: string;
}

export interface UiDiffResponse {
  item: string;
  view: DiffViewName;
  /** Null when the CLI has no comparison to show for this view. */
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
  /** The pin names the item's current shelf commit. Null when unknown. */
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
  /** Metadata and bundle parse warnings, deduplicated. */
  warnings: string[];
  /** Registered projects bound to this shelf. */
  projects: UiRegisteredProject[];
  generatedAt: string;
}

export interface UiShelfFile {
  name: string;
  /** Null when the file is binary or larger than the read limit. */
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
  /** Absolute path in the data repo, or null for a bundled system item. */
  path: string | null;
  metadata: UiShelfItemMetadata;
  /** Item-relative file names, sorted. */
  files: string[];
  /** The requested file, or the item's primary file. */
  file: UiShelfFile | null;
}

export interface UiError {
  error: {
    message: string;
    hint?: string;
    exitCode?: number;
  };
}
