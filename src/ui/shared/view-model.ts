/**
 * Pure helpers the dashboard uses to order, count, and filter the rows the
 * server sends. They carry no DOM, so they are unit tests.
 */
import type {
  ExternalClaudePlugin,
  ExternalSkill,
  ExternalUserSkill,
} from "../../external";
import type { ItemKind } from "../../master";
import type { UiItem, UiProjectStatus } from "./api-types";
import { KIND_ORDER, kindLabel } from "./kind-label";

export type FilterTab = "all" | "attention" | "ok";

/** What a kind chip can select: a kind, or one of the two external groups. */
export type ReviewKind = ItemKind | "claude-plugins" | "user-skills";

export interface KindChip<Id extends string> {
  id: Id;
  label: string;
  /** The rows the other filters leave for this kind. */
  count: number;
}

export interface ProjectCounts {
  items: number;
  attention: number;
  ok: number;
  kept: number;
}

export function projectCounts(items: readonly UiItem[]): ProjectCounts {
  let attention = 0;
  let kept = 0;
  for (const item of items) {
    if (item.attention) attention += 1;
    else if (item.tone === "kept") kept += 1;
  }
  return {
    items: items.length,
    attention,
    ok: items.length - attention - kept,
    kept,
  };
}

const TONE_ORDER = { attention: 0, kept: 1, ok: 2 } as const;

/** Attention first, then kept-local, then up to date; each group by ref. */
export function sortItems(items: readonly UiItem[]): UiItem[] {
  return [...items].sort((a, b) => {
    const toneA = a.attention ? 0 : TONE_ORDER[a.tone];
    const toneB = b.attention ? 0 : TONE_ORDER[b.tone];
    if (toneA !== toneB) return toneA - toneB;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
  });
}

export interface KindGroup<Row extends { kind: ItemKind }> {
  kind: ItemKind;
  label: string;
  rows: Row[];
}

/** One group per kind that has a row, in `KIND_ORDER`. Rows keep their order. */
export function groupByKind<Row extends { kind: ItemKind }>(
  rows: readonly Row[],
): KindGroup<Row>[] {
  const groups: KindGroup<Row>[] = [];
  for (const kind of KIND_ORDER) {
    const members = rows.filter((row) => row.kind === kind);
    if (members.length > 0) {
      groups.push({ kind, label: kindLabel(kind), rows: members });
    }
  }
  return groups;
}

/**
 * The kind groups a project shows. A kind with a finding comes first, as the
 * tree orders projects; ties keep `KIND_ORDER`. Rows follow `sortItems`.
 */
export function groupItems(items: readonly UiItem[]): KindGroup<UiItem>[] {
  const findings = (rows: readonly UiItem[]): number =>
    rows.filter((row) => row.attention).length;
  return groupByKind(sortItems(items)).sort(
    (a, b) => findings(b.rows) - findings(a.rows),
  );
}

export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return text.toLowerCase().includes(needle);
}

export function inTab(item: UiItem, tab: FilterTab): boolean {
  return tab === "all" || (tab === "attention") === item.attention;
}

export function filterItems(
  items: readonly UiItem[],
  tab: FilterTab,
  query: string,
  kind: ItemKind | null = null,
): UiItem[] {
  return sortItems(items).filter(
    (item) =>
      (kind === null || item.kind === kind) &&
      inTab(item, tab) &&
      matchesQuery(item.ref, query),
  );
}

/** `5 items · 3 up to date · 1 update available · 1 drifted`. */
export function summaryLine(items: readonly UiItem[]): string {
  const parts: string[] = [
    `${items.length} ${items.length === 1 ? "item" : "items"}`,
  ];
  const counts = new Map<string, number>();
  for (const item of sortItems(items)) {
    const label =
      item.stateLabel.charAt(0).toLowerCase() + item.stateLabel.slice(1);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ok = counts.get("up to date");
  if (ok !== undefined) parts.push(`${ok} up to date`);
  for (const [label, count] of counts) {
    if (label === "up to date") continue;
    parts.push(`${count} ${label}`);
  }
  return parts.join(" · ");
}

/**
 * The rows whose state or identity moved between two refreshes. The UI
 * highlights each once.
 */
export function changedItemIds(
  previous: readonly UiItem[] | undefined,
  next: readonly UiItem[],
): Set<string> {
  const out = new Set<string>();
  if (!previous) return out;
  const before = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) {
    const old = before.get(item.id);
    if (!old) {
      out.add(item.id);
      continue;
    }
    if (
      old.row.state !== item.row.state ||
      old.row.lockedSha !== item.row.lockedSha ||
      old.row.currentSha !== item.row.currentSha ||
      old.row.upstreamSha !== item.row.upstreamSha ||
      old.row.needsState !== item.row.needsState
    ) {
      out.add(item.id);
    }
  }
  return out;
}

export type TreeState = "loading" | "ready" | "error" | "missing";

export interface TreeEntry {
  path: string;
  display: string;
  state: TreeState;
  counts: ProjectCounts | null;
}

/** Attention count descending, then the display path. */
export function sortTree(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const attentionA = a.counts?.attention ?? -1;
    const attentionB = b.counts?.attention ?? -1;
    if (attentionA !== attentionB) return attentionB - attentionA;
    return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
  });
}

/** The first twelve characters of a 64-character digest, as the CLI prints. */
export function shortDigest(value: string | null | undefined): string {
  if (!value) return "(missing)";
  return value.length === 64 ? value.slice(0, 12) : value;
}

export function shortCommit(value: string | null | undefined): string {
  if (!value) return "";
  return value.length >= 40 ? value.slice(0, 7) : value;
}

/**
 * The CLI prints some sentences with a full 64-character digest. The panel
 * shows the same sentence with the 12-character form the CLI uses elsewhere.
 */
export function shortenDigests(text: string): string {
  return text.replace(/\b[0-9a-f]{64}\b/g, (digest) => digest.slice(0, 12));
}

export interface ProjectFindings {
  project: string;
  display: string;
  name: string;
  rows: UiItem[];
}

/**
 * Every finding on the machine, one group per project that has one. The
 * project with the most findings comes first, then by display path. Rows
 * keep `sortItems` order.
 */
export function findingsAcrossProjects(
  statuses: readonly UiProjectStatus[],
): ProjectFindings[] {
  return statuses
    .map((status) => ({
      project: status.project,
      display: status.display,
      name: splitDisplayPath(status.display).name,
      rows: sortItems(status.items.filter((item) => item.attention)),
    }))
    .filter((group) => group.rows.length > 0)
    .sort(
      (a, b) =>
        b.rows.length - a.rows.length || a.display.localeCompare(b.display),
    );
}

export interface SharedFinding {
  ref: string;
  /** Project names, in the order the findings list shows them. */
  projects: string[];
}

/**
 * Shelf items behind the shelf in more than one project. Each project still
 * takes the update on its own; the note only says the change is the same.
 */
export function sharedFindings(
  groups: readonly ProjectFindings[],
): SharedFinding[] {
  const behind = new Map<string, string[]>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (
        row.source !== "data" ||
        (row.row.state !== "update_available" &&
          row.row.state !== "drifted_and_update")
      ) {
        continue;
      }
      const names = behind.get(row.ref) ?? [];
      names.push(group.name);
      behind.set(row.ref, names);
    }
  }
  return [...behind]
    .filter(([, projects]) => projects.length > 1)
    .map(([ref, projects]) => ({ ref, projects }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Where a jump row leads. The client maps it to a route. */
export type JumpTarget =
  | { type: "item"; project: string; item: string }
  | { type: "project"; project: string }
  | { type: "shelf"; repo: string; ref: string }
  | { type: "machine" };

export type JumpGroup =
  | "Findings"
  | "Projects"
  | "Items"
  | "Shelf"
  | "This machine";

export interface JumpRow {
  /** The text the query matches and highlights. */
  ref: string;
  tags: string[];
  description?: string;
  group: JumpGroup;
  /** Quiet words after the name: the project, the kind, or the state. */
  detail: string;
  /** A finding's recommended command, for the `c` key. */
  command: string | null;
  target: JumpTarget;
  /** Unique across every row, for list keys. */
  key: string;
}

/** The order the jump dialog shows its groups in. */
export const JUMP_GROUPS: readonly JumpGroup[] = [
  "Findings",
  "Projects",
  "Items",
  "Shelf",
  "This machine",
];

export interface JumpShelf {
  dataRepo: string;
  items: ReadonlyArray<{
    ref: string;
    name: string;
    tags: string[];
    description?: string;
    usage: readonly unknown[];
  }>;
}

/**
 * Everything the jump dialog can open: findings first, then projects,
 * the other items, the shelf items, and the user-level skills. A finding
 * and its item are one row, under Findings.
 */
export function jumpCandidates(
  statuses: readonly UiProjectStatus[],
  shelves: readonly JumpShelf[],
): JumpRow[] {
  const rows: JumpRow[] = [];
  for (const status of statuses) {
    const projectName = splitDisplayPath(status.display).name;
    rows.push({
      ref: projectName,
      tags: [],
      description: status.display,
      group: "Projects",
      detail: status.display,
      command: null,
      target: { type: "project", project: status.project },
      key: `project:${status.project}`,
    });
    for (const item of status.items) {
      rows.push({
        ref: item.name,
        tags: [projectName, item.kind],
        description: item.ref,
        group: item.attention ? "Findings" : "Items",
        detail: item.attention
          ? `${projectName} · ${item.stateLabel}`
          : projectName,
        command: item.attention ? (item.actions[0]?.command ?? null) : null,
        target: { type: "item", project: status.project, item: item.id },
        key: `item:${status.project}:${item.id}`,
      });
    }
  }
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      rows.push({
        ref: item.name,
        tags: item.tags,
        ...(item.description !== undefined && {
          description: item.description,
        }),
        group: "Shelf",
        detail:
          item.usage.length === 0
            ? `${item.ref} · used nowhere`
            : `${item.ref} · ${item.usage.length} ${item.usage.length === 1 ? "project" : "projects"}`,
        command: null,
        target: { type: "shelf", repo: shelf.dataRepo, ref: item.ref },
        key: `shelf:${shelf.dataRepo}:${item.ref}`,
      });
    }
  }
  const seen = new Set<string>();
  for (const status of statuses) {
    for (const skill of status.externalUserSkills) {
      const key = `machine:${skill.surface}:${skill.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ref: skill.name,
        tags: [skill.surface],
        group: "This machine",
        detail: `${skill.surface === "claude" ? "Claude" : "Codex"} user skill`,
        command: null,
        target: { type: "machine" },
        key,
      });
    }
  }
  return rows;
}

/**
 * The CLI's state sentence, shortened, or null when it only restates the
 * label: `up-to-date` under "Up to date" adds nothing, while
 * `drifted + update available → 4ca4018c5a54` names the target.
 */
export function stateSentence(label: string, detail: string): string | null {
  const words = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const sentence = shortenDigests(detail).trim();
  if (sentence.length === 0) return null;
  return words(sentence) === words(label) ? null : sentence;
}

/**
 * A project's display path as the rail shows it: the folder name first,
 * because it tells projects apart, and the parent below it.
 * `~/code/billing-api` → name `billing-api`, parent `~/code`.
 */
export interface DisplayPathParts {
  name: string;
  parent: string;
}

export function splitDisplayPath(display: string): DisplayPathParts {
  const trimmed = display.length > 1 ? display.replace(/\/+$/, "") : display;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return { name: trimmed, parent: "" };
  return {
    name: trimmed.slice(slash + 1) || trimmed,
    parent: slash === 0 ? "/" : trimmed.slice(0, slash),
  };
}

export type ListGroupId = "attention" | "kept" | "ok";

export interface ListGroup {
  id: ListGroupId;
  label: string;
  rows: UiItem[];
}

const LIST_GROUPS: ReadonlyArray<{ id: ListGroupId; label: string }> = [
  { id: "attention", label: "Needs attention" },
  { id: "kept", label: "Kept local" },
  { id: "ok", label: "Up to date" },
];

/**
 * The item list groups by state, not by kind: findings first, then kept
 * local, then up to date. Rows keep `sortItems` order. Empty groups drop.
 */
export function listGroups(items: readonly UiItem[]): ListGroup[] {
  const sorted = sortItems(items);
  const groupOf = (item: UiItem): ListGroupId =>
    item.attention ? "attention" : item.tone === "kept" ? "kept" : "ok";
  return LIST_GROUPS.map((group) => ({
    ...group,
    rows: sorted.filter((item) => groupOf(item) === group.id),
  })).filter((group) => group.rows.length > 0);
}

/**
 * Something a harness loads in a project that Capshelf does not manage. The
 * id is the route segment that selects it, so it must not collide with an
 * item id (`<scope>/<source>/<kind>/<name>`).
 */
export type ExternalEntry =
  | { type: "skills.sh"; id: string; name: string; skill: ExternalSkill }
  | {
      type: "plugin";
      id: string;
      name: string;
      plugin: ExternalClaudePlugin;
    }
  | {
      type: "user-skill";
      id: string;
      name: string;
      skill: ExternalUserSkill;
    };

/** Every external row of a project, ordered by name, then by id. */
export function externalEntries(
  status: Pick<
    UiProjectStatus,
    "external" | "externalClaudePlugins" | "externalUserSkills"
  >,
): ExternalEntry[] {
  const entries: ExternalEntry[] = [
    ...status.external.map(
      (skill): ExternalEntry => ({
        type: "skills.sh",
        id: `external/skills/${skill.name}`,
        name: skill.name,
        skill,
      }),
    ),
    ...status.externalClaudePlugins.map(
      (plugin): ExternalEntry => ({
        type: "plugin",
        id: `plugin/${plugin.scope}/${plugin.id}`,
        name: plugin.name,
        plugin,
      }),
    ),
    ...status.externalUserSkills.map(
      (skill): ExternalEntry => ({
        type: "user-skill",
        id: `user/${skill.surface}/${skill.name}`,
        name: skill.name,
        skill,
      }),
    ),
  ];
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
