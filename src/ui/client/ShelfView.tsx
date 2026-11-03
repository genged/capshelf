import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ItemKind } from "../../master";
import { rankRows } from "../../pick-rank";
import type {
  UiOverview,
  UiProjectStatus,
  UiShelf,
  UiShelfItemDetail,
} from "../shared/api-types";
import { capshelfCommand, commandDataOverride } from "../../command-text";
import { kindNoun } from "../shared/kind-label";
import type { ShelfSection } from "../shared/route";
import { itemIcon } from "../shared/state-label";
import {
  type CoverageRow,
  groupByKind,
  type ProjectUsage,
  type Rollout,
  shelfCoverage,
  shelfRollouts,
  splitDisplayPath,
  type UsageState,
  usageState,
} from "../shared/view-model";
import { ApiError, apiGet } from "./api";
import {
  CommandText,
  CopyButton,
  EmptyState,
  formatDay,
  PaneFocus,
  Skeleton,
} from "./common";
import { highlightLine, languageForPath } from "./highlight";
import { DetailHead } from "./ItemDetail";
import { onListKeyDown } from "./ItemRow";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import type { Route } from "./router";

type Load<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; error: ApiError };

type ShelfRoute = Extract<Route, { view: "shelf" }>;

interface ShelfRow {
  ref: string;
  name: string;
  tags: string[];
  description?: string;
  source: "data" | "system" | "bundle";
  detail: string;
}

/** Bundles first, then one section per kind, as `ls` prints them. */
interface ShelfGroup {
  id: ItemKind | "bundles";
  label: string;
  rows: ShelfRow[];
}

const SECTIONS: ReadonlyArray<{
  id: ShelfSection;
  label: string;
  icon: IconName;
}> = [
  { id: "items", label: "Items", icon: "shelf" },
  { id: "rollouts", label: "Rollouts", icon: "refresh" },
  { id: "coverage", label: "Coverage", icon: "folder" },
];

/**
 * The shelf in the B1 frame. The rail picks the shelf and the section:
 * Items, Rollouts, or Coverage. Rollouts and Coverage join the shelf's usage
 * with each project's status rows, so the state per project is the CLI's.
 */
export function ShelfView({
  overview,
  route,
  navigate,
  statuses,
  pending,
  generation,
}: {
  overview: UiOverview | null;
  route: ShelfRoute;
  navigate: (route: Route) => void;
  statuses: ReadonlyMap<string, UiProjectStatus>;
  /** Projects on their first status read; see `usageState`. */
  pending: ReadonlySet<string>;
  /**
   * Changes on every dashboard refresh. The shelf's usage and pins must be
   * read again with the statuses they are joined to.
   */
  generation: number;
}): preact.JSX.Element {
  const repo = route.repo ?? overview?.shelves[0]?.dataRepo ?? null;
  // Every printed command repeats the session's --data override, as the
  // server's own actions do (src/status-actions.ts).
  const dataOverride = commandDataOverride(overview?.dataOverride, repo);
  const [shelf, setShelf] = useState<Load<UiShelf>>({ state: "idle" });
  const [query, setQuery] = useState("");

  // `generation` is in the dependencies as the refresh trigger.
  useEffect(() => {
    if (repo === null) return;
    // A refresh keeps the last read of the same shelf on screen.
    setShelf((previous) =>
      previous.state === "ready" && previous.data.dataRepo === repo
        ? previous
        : { state: "loading" },
    );
    apiGet<UiShelf>("/api/shelf", { repo }).then(
      (data) => setShelf({ state: "ready", data }),
      (cause: unknown) =>
        setShelf({
          state: "error",
          error:
            cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
        }),
    );
  }, [repo, generation]);

  const go = (section: ShelfSection, ref: string | null): void =>
    navigate({ view: "shelf", repo, section, ref });

  const rollouts = useMemo<Rollout[]>(
    () =>
      shelf.state === "ready"
        ? shelfRollouts(shelf.data.items, statuses, pending)
        : [],
    [shelf, statuses, pending],
  );

  if (overview === null) {
    return (
      <main class="page-message">
        <Skeleton lines={4} label="Loading the shelf" />
      </main>
    );
  }
  if (repo === null) {
    return (
      <main class="page-message">
        <EmptyState title="No shelf to show">
          <p>No registered project is bound to a data repo on this machine.</p>
        </EmptyState>
      </main>
    );
  }

  // The phone's stand-in for the rail: the shelf, when there is more than
  // one, and the view.
  const picker = (
    <div class="rail-picker-group">
      {overview.shelves.length > 1 ? (
        <label class="rail-picker">
          <Icon name="shelf" />
          <span>Shelf</span>
          <select
            value={repo}
            onChange={(event) =>
              navigate({
                view: "shelf",
                repo: event.currentTarget.value,
                section: route.section,
                ref: null,
              })
            }
          >
            {overview.shelves.map((entry) => (
              <option key={entry.dataRepo} value={entry.dataRepo}>
                {splitDisplayPath(entry.display).name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label class="rail-picker">
        <Icon name={overview.shelves.length > 1 ? "folder" : "shelf"} />
        <span>{overview.shelves.length > 1 ? "View" : "Shelf"}</span>
        <select
          value={route.section}
          onChange={(event) => {
            const value = event.currentTarget.value;
            const next = SECTIONS.find((section) => section.id === value);
            if (next) go(next.id, null);
          }}
        >
          {SECTIONS.map((section) => (
            <option key={section.id} value={section.id}>
              {section.label}
              {section.id === "rollouts" ? ` (${rollouts.length})` : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  const rail = (
    <ShelfRail
      overview={overview}
      repo={repo}
      shelf={shelf.state === "ready" ? shelf.data : null}
      section={route.section}
      rollouts={rollouts.length}
      onShelf={(next) =>
        navigate({
          view: "shelf",
          repo: next,
          section: route.section,
          ref: null,
        })
      }
    />
  );

  if (shelf.state !== "ready") {
    return (
      <div class="frame">
        {rail}
        <section class="list" aria-label="Shelf">
          {picker}
          {shelf.state === "error" ? (
            <EmptyState title="The shelf could not be read">
              <p>{shelf.error.message}</p>
              {shelf.error.hint ? (
                <p class="muted">{shelf.error.hint}</p>
              ) : null}
            </EmptyState>
          ) : (
            <div class="list-empty">
              <Skeleton lines={6} label="Loading the shelf" />
            </div>
          )}
        </section>
        <section class="detail" aria-hidden="true" />
      </div>
    );
  }

  const data = shelf.data;
  // A phone shows the detail only for an entry that still exists. A rollout
  // that an update finished, or an item a refresh removed, falls back to the
  // list and its picker instead of an empty page.
  const ref = route.ref;
  const selectionExists =
    ref !== null &&
    (route.section === "rollouts"
      ? rollouts.some((entry) => entry.ref === ref)
      : data.items.some((item) => item.ref === ref) ||
        data.bundles.some((bundle) => bundle.ref === ref));
  if (route.section === "coverage") {
    return (
      <div class="frame is-two">
        {rail}
        <CoveragePane
          picker={picker}
          shelf={data}
          statuses={statuses}
          pending={pending}
          onItem={(ref) => go("items", ref)}
        />
      </div>
    );
  }

  return (
    <div class={`frame${selectionExists ? " has-selection" : ""}`}>
      <PaneFocus
        selection={selectionExists ? `${route.section}\t${ref}` : null}
      />
      {rail}
      {route.section === "rollouts" ? (
        <>
          <RolloutList
            picker={picker}
            rollouts={rollouts}
            selected={route.ref}
            onSelect={(ref) => go("rollouts", ref)}
          />
          <RolloutDetail
            rollout={
              rollouts.find((entry) => entry.ref === route.ref) ??
              (route.ref === null ? (rollouts[0] ?? null) : null)
            }
            statuses={statuses}
            dataOverride={dataOverride}
            onBack={() => go("rollouts", null)}
            onItem={(ref) => go("items", ref)}
          />
        </>
      ) : (
        <>
          <ItemList
            picker={picker}
            shelf={data}
            query={query}
            onQuery={setQuery}
            selected={route.ref}
            onSelect={(ref) => go("items", ref)}
          />
          {route.ref === null ? (
            <ShelfOverview shelf={data} rollouts={rollouts.length} />
          ) : route.ref.startsWith("bundles/") ? (
            <BundleReader
              shelf={data}
              dataOverride={dataOverride}
              bundleRef={route.ref}
              onSelect={(ref) => go("items", ref)}
              onBack={() => go("items", null)}
            />
          ) : (
            <ItemReader
              key={route.ref}
              repo={repo}
              itemRef={route.ref}
              statuses={statuses}
              pending={pending}
              dataOverride={dataOverride}
              generation={generation}
              onSelect={(ref) => go("items", ref)}
              onBack={() => go("items", null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ShelfRail({
  overview,
  repo,
  shelf,
  section,
  rollouts,
  onShelf,
}: {
  overview: UiOverview;
  repo: string;
  shelf: UiShelf | null;
  section: ShelfSection;
  rollouts: number;
  onShelf: (repo: string) => void;
}): preact.JSX.Element {
  const href = (id: ShelfSection): string =>
    id === "items"
      ? `#/shelf/${encodeURIComponent(repo)}`
      : `#/shelf/${encodeURIComponent(repo)}/${id}`;
  const facts = shelf?.facts ?? null;
  return (
    <nav class="rail" aria-label="Shelf">
      <h2 class="rail-head">Shelf</h2>
      <ul class="rail-list">
        {overview.shelves.map((entry) => (
          <li key={entry.dataRepo}>
            <button
              type="button"
              class="rail-row"
              aria-current={entry.dataRepo === repo ? "true" : undefined}
              onClick={() => onShelf(entry.dataRepo)}
              title={entry.dataRepo}
            >
              <span class="rail-row-name">
                {splitDisplayPath(entry.display).name}
              </span>
              <span class="rail-row-parent">
                {entry.dataRepo === repo && facts
                  ? `${facts.branch ?? "detached"} @ ${facts.headShort || "no commits"}`
                  : entry.display}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h2 class="rail-head">Views</h2>
      <ul class="rail-list">
        {SECTIONS.map((entry) => (
          <li key={entry.id}>
            <a
              class="rail-row has-icon"
              href={href(entry.id)}
              aria-current={section === entry.id ? "page" : undefined}
            >
              <Icon name={entry.icon} />
              <span class="rail-row-name">{entry.label}</span>
              {entry.id === "items" && shelf ? (
                <span class="count">
                  {shelf.items.length + shelf.bundles.length}
                </span>
              ) : entry.id === "rollouts" && shelf ? (
                <span class={`count${rollouts > 0 ? " is-attention" : ""}`}>
                  {rollouts}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
      {facts && facts.revisions.length > 0 ? (
        <>
          <h2 class="rail-head">Recent commits</h2>
          <ol class="rail-commits">
            {facts.revisions.slice(0, 5).map((revision) => (
              <li key={revision.sha}>
                <span class="mono">{revision.short}</span> {revision.subject}
                <span class="rail-row-parent">
                  {revision.author} · {formatDay(revision.date)}
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <div class="rail-foot">
        {facts?.origin ? <span class="mono">{facts.origin}</span> : null}
        {facts && !facts.clean ? (
          <span class="tone-attention">uncommitted changes</span>
        ) : null}
        {shelf ? (
          <span>
            Bound to {shelf.projects.length}{" "}
            {shelf.projects.length === 1 ? "project" : "projects"}
          </span>
        ) : null}
      </div>
    </nav>
  );
}

function ItemList({
  picker,
  shelf,
  query,
  onQuery,
  selected,
  onSelect,
}: {
  picker: ComponentChildren;
  shelf: UiShelf;
  query: string;
  onQuery: (query: string) => void;
  selected: string | null;
  onSelect: (ref: string) => void;
}): preact.JSX.Element {
  const groups = useMemo<ShelfGroup[]>(() => {
    const bundles: ShelfRow[] = shelf.bundles.map((bundle) => ({
      ref: bundle.ref,
      name: bundle.name,
      tags: bundle.tags,
      ...(bundle.description !== undefined && {
        description: bundle.description,
      }),
      source: "bundle",
      detail: bundle.malformed
        ? "malformed"
        : `${bundle.members.length} ${bundle.members.length === 1 ? "member" : "members"}`,
    }));
    return [
      ...(bundles.length > 0
        ? [{ id: "bundles" as const, label: "Bundles", rows: bundles }]
        : []),
      ...groupByKind(shelf.items).map((group) => ({
        id: group.kind,
        label: group.label,
        rows: group.rows.map(
          (item): ShelfRow => ({
            ref: item.ref,
            name: item.name,
            tags: item.tags,
            ...(item.description !== undefined && {
              description: item.description,
            }),
            source: item.source,
            detail:
              item.usage.length === 0
                ? "used nowhere"
                : `${item.usage.length} ${item.usage.length === 1 ? "project" : "projects"}`,
          }),
        ),
      })),
    ];
  }, [shelf]);
  const ranked = useMemo(
    () =>
      query.trim().length === 0
        ? null
        : rankRows(
            query,
            groups.flatMap((group) => group.rows),
          ),
    [groups, query],
  );
  const row = (entry: ShelfRow, positions: number[]): preact.JSX.Element => (
    <li key={entry.ref}>
      <button
        type="button"
        class="list-row tone-shelf"
        aria-current={selected === entry.ref ? "true" : undefined}
        onClick={() => onSelect(entry.ref)}
        onKeyDown={onListKeyDown}
        title={entry.ref}
      >
        <Icon name={entry.source === "bundle" ? "folder" : "shelf"} />
        <span class="list-row-name">
          <HighlightedRef text={entry.name} positions={positions} />
          {entry.source === "system" ? (
            <span class="list-row-kind">system</span>
          ) : null}
        </span>
        <span class="list-row-state">{entry.detail}</span>
        {entry.description ? (
          <span class="list-row-sub">{entry.description}</span>
        ) : null}
      </button>
    </li>
  );
  return (
    <section class="list" aria-label="Shelf items">
      {picker}
      <div class="list-head">
        <h1 class="list-title">Items</h1>
        <label class="list-search">
          <Icon name="search" />
          <span class="visually-hidden">Search items and bundles</span>
          <input
            type="search"
            placeholder="Search items and bundles"
            value={query}
            onInput={(event) => onQuery(event.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
        </label>
      </div>
      {groups.length === 0 ? (
        <p class="list-empty">The shelf holds no items or bundles yet.</p>
      ) : ranked === null ? (
        groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <h2 class="list-group-head">
              {group.label}
              <span class="count">{group.rows.length}</span>
            </h2>
            <ul class="list-rows">
              {group.rows.map((entry) => row(entry, []))}
            </ul>
          </section>
        ))
      ) : ranked.length === 0 ? (
        <p class="list-empty">Nothing matches “{query}”.</p>
      ) : (
        <ul class="list-rows" aria-label="Search results">
          {ranked.map((entry) =>
            row(entry.row, positionsInName(entry.row, entry.positions)),
          )}
        </ul>
      )}
      {shelf.warnings.length > 0 ? (
        <section aria-label="Catalog warnings">
          <h2 class="list-group-head">Catalog warnings</h2>
          {shelf.warnings.map((warning) => (
            <p key={warning} class="list-note">
              <Icon name="alert" />
              <span>{warning}</span>
            </p>
          ))}
        </section>
      ) : null}
    </section>
  );
}

/**
 * `rankRows` highlights positions in the ref (`skills/quick-review`); the
 * row shows the name, so the positions shift by the kind prefix.
 */
function positionsInName(row: ShelfRow, positions: number[]): number[] {
  const offset = row.ref.length - row.name.length;
  return positions
    .filter((position) => position >= offset)
    .map((position) => position - offset);
}

/** The reader before a click: the shelf itself, its projects, its commits. */
function ShelfOverview({
  shelf,
  rollouts,
}: {
  shelf: UiShelf;
  rollouts: number;
}): preact.JSX.Element {
  const { facts, projects } = shelf;
  const name = splitDisplayPath(shelf.display).name;
  return (
    <article class="detail" aria-label={`${name} overview`}>
      <div class="detail-body">
        <DetailHead
          crumbs="Shelf"
          title={name}
          backLabel="Items"
          onBack={() => undefined}
        />
        <p class="section-note">
          Select an item to read it and see the projects that hold it.
        </p>
        {rollouts > 0 ? (
          <p class="banner tone-attention">
            <Icon name="refresh" />
            <span>
              {rollouts} {rollouts === 1 ? "item has" : "items have"} a shelf
              change that some projects have not taken.{" "}
              <a
                href={`#/shelf/${encodeURIComponent(shelf.dataRepo)}/rollouts`}
              >
                Open Rollouts
              </a>
            </span>
          </p>
        ) : null}
        <section class="detail-section" aria-label="Shelf facts">
          <div class="card">
            <dl class="props">
              <dt>Path</dt>
              <dd class="mono">{shelf.display}</dd>
              <dt>Head</dt>
              <dd>
                <span class="mono">{facts.headShort || "no commits"}</span>
                {facts.branch ? (
                  <span class="muted">
                    {" "}
                    on <span class="mono">{facts.branch}</span>
                  </span>
                ) : null}
                {facts.clean ? null : (
                  <span class="tone-attention"> · uncommitted changes</span>
                )}
              </dd>
              {facts.origin ? (
                <>
                  <dt>Origin</dt>
                  <dd class="mono">{facts.origin}</dd>
                </>
              ) : null}
              <dt>Bound to</dt>
              <dd>
                {projects.length === 0
                  ? "no registered project"
                  : projects.map((project, index) => (
                      <span key={project.path}>
                        {index > 0 ? ", " : ""}
                        <a
                          href={`#/status/${encodeURIComponent(project.path)}`}
                        >
                          {splitDisplayPath(project.display).name}
                        </a>
                        {project.exists ? "" : " (missing)"}
                      </span>
                    ))}
              </dd>
            </dl>
          </div>
        </section>
        <section class="detail-section" aria-label="Recent commits">
          <h3 class="section-label">Recent commits</h3>
          {facts.revisions.length === 0 ? (
            <p class="muted">The data repo has no commits yet.</p>
          ) : (
            <ol class="revisions">
              {facts.revisions.map((revision) => (
                <li key={revision.sha} class="revision">
                  <span class="mono revision-sha">{revision.short}</span>
                  <span class="revision-subject">{revision.subject}</span>
                  <span class="muted revision-meta">
                    {formatDay(revision.date)} · {revision.author}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </article>
  );
}

const USAGE_WORDS: Record<
  UsageState,
  { icon: IconName; tone: string; word: string }
> = {
  current: { icon: "check", tone: "ok", word: "Up to date" },
  behind: { icon: "alert", tone: "attention", word: "Behind the shelf" },
  "behind-edited": {
    icon: "pencil",
    tone: "attention",
    word: "Behind, edited here",
  },
  kept: { icon: "notequal", tone: "kept", word: "Kept local" },
  other: { icon: "bang", tone: "attention", word: "Needs attention" },
  // From the lock only, while the first status read runs: a pin fact, not a
  // state of the installed copy.
  "pin-current": {
    icon: "question",
    tone: "kept",
    word: "Pin is current, reading status",
  },
  "pin-behind": {
    icon: "question",
    tone: "attention",
    word: "Pin is behind, reading status",
  },
  unknown: { icon: "question", tone: "kept", word: "No status" },
};

/** A usage state as an icon and a word, never by color alone. */
function UsageBadge({ usage }: { usage: ProjectUsage }): preact.JSX.Element {
  const words = USAGE_WORDS[usage.state];
  // A read row draws the icon the project list draws for the same state.
  const icon =
    usage.rowState === null
      ? words.icon
      : itemIcon(usage.rowState, usage.state !== "current");
  return (
    <span class={`state-badge tone-${words.tone}`}>
      <Icon name={icon} />
      <span>{usage.label ?? words.word}</span>
    </span>
  );
}

function projectItemHref(usage: ProjectUsage): string {
  return usage.itemId === null
    ? `#/status/${encodeURIComponent(usage.project)}`
    : `#/status/${encodeURIComponent(usage.project)}/${encodeURIComponent(usage.itemId)}`;
}

function ItemReader({
  repo,
  itemRef,
  statuses,
  pending,
  dataOverride,
  generation,
  onSelect,
  onBack,
}: {
  repo: string;
  itemRef: string;
  statuses: ReadonlyMap<string, UiProjectStatus>;
  pending: ReadonlySet<string>;
  dataOverride: string | undefined;
  /** Changes on every dashboard refresh; see `ShelfView`. */
  generation: number;
  onSelect: (ref: string) => void;
  onBack: () => void;
}): preact.JSX.Element {
  const [file, setFile] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<UiShelfItemDetail>>({
    state: "loading",
  });
  // `generation` is in the dependencies as the refresh trigger.
  useEffect(() => {
    // A refresh keeps the last read of the same item on screen.
    setDetail((previous) =>
      previous.state === "ready" && previous.data.ref === itemRef
        ? previous
        : { state: "loading" },
    );
    apiGet<UiShelfItemDetail>("/api/shelf/item", {
      repo,
      ref: itemRef,
      ...(file !== null && { file }),
    }).then(
      (data) => setDetail({ state: "ready", data }),
      (cause: unknown) =>
        setDetail({
          state: "error",
          error:
            cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
        }),
    );
  }, [repo, itemRef, file, generation]);

  if (detail.state !== "ready") {
    // On a phone the list is hidden here, so the back link must stay.
    return (
      <article class="detail" aria-label={itemRef}>
        <div class="detail-body">
          <button type="button" class="link-button back-link" onClick={onBack}>
            <Icon name="chevron" />
            Items
          </button>
          {detail.state === "error" ? (
            <EmptyState title="The item could not be read">
              <p>{detail.error.message}</p>
              {detail.error.hint ? (
                <p class="muted">{detail.error.hint}</p>
              ) : null}
            </EmptyState>
          ) : (
            <Skeleton lines={8} label="Loading the item" />
          )}
        </div>
      </article>
    );
  }

  const data = detail.data;
  const current = data.file;
  const currentName = current?.name ?? file;
  const isMarkdown = currentName?.toLowerCase().endsWith(".md") ?? false;
  const { metadata } = data;
  const usages = data.usage.map((usage) =>
    usageState(data.ref, usage, statuses, data.source, pending),
  );
  const addCommand = capshelfCommand(dataOverride, ["add", data.ref]);
  return (
    <article class="detail" aria-label={data.ref}>
      <div class="detail-body">
        <DetailHead
          crumbs={
            <>
              Shelf / {kindNoun(data.kind)}
              {data.source === "system" ? " · system" : ""}
            </>
          }
          title={data.name}
          backLabel="Items"
          onBack={onBack}
        >
          {data.description ? (
            <p class="detail-lead">{data.description}</p>
          ) : null}
          <p class="section-note">
            {data.lastCommit ? (
              <>
                Last changed in{" "}
                <span class="mono">{data.lastCommit.short}</span>,{" "}
                {formatDay(data.lastCommit.date)} · {data.lastCommit.subject}
              </>
            ) : data.source === "system" ? (
              "Bundled in this CLI."
            ) : (
              "No committed change found."
            )}
            {data.tags.length > 0 ? (
              <span>
                {" "}
                ·{" "}
                {data.tags.map((tag) => (
                  <span key={tag} class="chip chip-tag">
                    #{tag}
                  </span>
                ))}
              </span>
            ) : null}
          </p>
        </DetailHead>

        <section class="detail-section" aria-label="Used in">
          <h3 class="section-label">
            {usages.length === 0
              ? "Used by no registered project"
              : `Used in ${usages.length} ${usages.length === 1 ? "project" : "projects"}`}
          </h3>
          {usages.length > 0 ? (
            <table class="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Pin</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {usages.map((usage, index) => {
                  const raw = data.usage[index];
                  return (
                    <tr key={`${usage.project}:${usage.scope}`}>
                      <td>
                        <a href={projectItemHref(usage)}>{usage.name}</a>
                        {usage.scope === "local" ? (
                          <span class="muted"> · local</span>
                        ) : null}
                      </td>
                      <td class="mono">
                        {raw?.sourceCommitShort ??
                          (raw?.cliVersion ? `capshelf ${raw.cliVersion}` : "")}
                      </td>
                      <td>
                        <UsageBadge usage={usage} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </section>

        {data.source === "data" ? (
          <section class="detail-section" aria-label="Add to a project">
            <h3 class="section-label">Add to another project</h3>
            <div class="recommended is-plain">
              <CommandText command={addCommand} />
              <CopyButton text={addCommand} label={`Copy ${addCommand}`} />
            </div>
            <p class="section-note">
              <AddNote dataOverride={dataOverride} />
            </p>
          </section>
        ) : null}

        {metadata.requires.length > 0 ||
        metadata.conflictsWith.length > 0 ||
        hasNeeds(metadata.needs) ? (
          <section class="detail-section" aria-label="Metadata">
            <div class="card">
              <dl class="props">
                {metadata.requires.length > 0 ? (
                  <>
                    <dt>Requires</dt>
                    <dd>
                      {metadata.requires.map((requirement) => (
                        <button
                          key={requirement}
                          type="button"
                          class="link-button mono"
                          onClick={() => onSelect(requirement)}
                        >
                          {requirement}
                        </button>
                      ))}
                    </dd>
                  </>
                ) : null}
                {metadata.conflictsWith.length > 0 ? (
                  <>
                    <dt>Conflicts with</dt>
                    <dd class="mono">{metadata.conflictsWith.join(", ")}</dd>
                  </>
                ) : null}
                {hasNeeds(metadata.needs) ? (
                  <>
                    <dt>Needs</dt>
                    <dd>{needsText(metadata.needs)}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </section>
        ) : null}

        {data.files.length > 0 ? (
          <section class="detail-section" aria-label="Files">
            <div class="file-tabs" role="tablist" aria-label="Files">
              {data.files.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  class={`tab${currentName === name ? " is-active" : ""}`}
                  aria-selected={currentName === name}
                  onClick={() => setFile(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            {current === null ? (
              <p class="muted">No file to show.</p>
            ) : current.binary ? (
              <p class="muted">
                <span class="mono">{current.name}</span> is a binary file (
                {current.size} bytes).
              </p>
            ) : current.text === null ? (
              <p class="muted">
                <span class="mono">{current.name}</span> is larger than 256 KiB
                ({current.size} bytes). Open it in the data repo.
              </p>
            ) : isMarkdown ? (
              <Markdown text={current.text} />
            ) : (
              <pre class="mono code-block">
                {current.text.split("\n").map((line, index) => (
                  <span key={index} class="code-line">
                    {highlightLine(line, languageForPath(current.name))}
                    {"\n"}
                  </span>
                ))}
              </pre>
            )}
          </section>
        ) : null}

        {data.path ? (
          <p class="section-note">
            Data repo path: <span class="mono">{data.path}</span>
          </p>
        ) : null}
        {metadata.warnings.length > 0 ? (
          <ul class="reader-warnings">
            {metadata.warnings.map((warning) => (
              <li key={warning}>
                <Icon name="alert" label="Warning" /> {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Where an add command runs. Without `--data`, `add` reads the shelf the
 * project is bound to, which may not be the shelf on screen.
 */
function AddNote({
  dataOverride,
}: {
  dataOverride: string | undefined;
}): preact.JSX.Element {
  return dataOverride === undefined ? (
    <>Run it in a project that is bound to this shelf.</>
  ) : (
    <>Run it in the project folder.</>
  );
}

function BundleReader({
  shelf,
  dataOverride,
  bundleRef,
  onSelect,
  onBack,
}: {
  shelf: UiShelf;
  dataOverride: string | undefined;
  bundleRef: string;
  onSelect: (ref: string) => void;
  onBack: () => void;
}): preact.JSX.Element {
  const bundle = shelf.bundles.find((entry) => entry.ref === bundleRef);
  if (!bundle) {
    return (
      <article class="detail">
        <div class="detail-body">
          <EmptyState title="Bundle not found" />
        </div>
      </article>
    );
  }
  const addCommand = capshelfCommand(dataOverride, ["add", bundle.ref]);
  return (
    <article class="detail" aria-label={bundle.ref}>
      <div class="detail-body">
        <DetailHead
          crumbs="Shelf / bundle"
          title={bundle.name}
          backLabel="Items"
          onBack={onBack}
        >
          {bundle.description ? (
            <p class="detail-lead">{bundle.description}</p>
          ) : null}
        </DetailHead>
        {bundle.malformed ? (
          <p class="banner tone-attention">
            <Icon name="alert" />
            <span>{bundle.malformed}</span>
          </p>
        ) : (
          <section class="detail-section" aria-label="Members">
            <h3 class="section-label">
              {bundle.members.length}{" "}
              {bundle.members.length === 1 ? "member" : "members"}
            </h3>
            <ul class="alts">
              {bundle.members.map((member) => (
                <li key={member} class="alt-row">
                  <button
                    type="button"
                    class="link-button mono"
                    onClick={() => onSelect(member)}
                  >
                    {member}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section class="detail-section" aria-label="Add">
          <h3 class="section-label">Add to a project</h3>
          <div class="recommended is-plain">
            <CommandText command={addCommand} />
            <CopyButton text={addCommand} label={`Copy ${addCommand}`} />
          </div>
          <p class="section-note">
            <AddNote dataOverride={dataOverride} />
          </p>
        </section>
      </div>
    </article>
  );
}

function RolloutList({
  picker,
  rollouts,
  selected,
  onSelect,
}: {
  picker: ComponentChildren;
  rollouts: Rollout[];
  selected: string | null;
  onSelect: (ref: string) => void;
}): preact.JSX.Element {
  const active = selected ?? rollouts[0]?.ref ?? null;
  return (
    <section class="list" aria-label="Rollouts">
      {picker}
      <div class="list-head">
        <h1 class="list-title">Rollouts</h1>
        <p class="list-sub">
          Shelf changes that some projects have not taken. Each project changes
          only when its own update runs.
        </p>
      </div>
      {rollouts.length === 0 ? (
        <p class="list-empty">
          Every project that uses an item from this shelf has its latest
          version.
        </p>
      ) : (
        <ul class="list-rows">
          {rollouts.map((rollout) => (
            <li key={rollout.ref}>
              <button
                type="button"
                class="list-row tone-attention"
                aria-current={active === rollout.ref ? "true" : undefined}
                onClick={() => onSelect(rollout.ref)}
                onKeyDown={onListKeyDown}
              >
                <Icon name="refresh" />
                <span class="list-row-name">
                  {rollout.name}
                  <span class="list-row-kind">{kindNoun(rollout.kind)}</span>
                </span>
                <span class="list-row-state">
                  {rollout.behind} of {rollout.projects.length} behind
                </span>
                {rollout.commit ? (
                  <span class="list-row-sub">
                    changed in <span class="mono">{rollout.commit}</span>
                    {rollout.subject ? ` · ${rollout.subject}` : ""}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RolloutDetail({
  rollout,
  statuses,
  dataOverride,
  onBack,
  onItem,
}: {
  rollout: Rollout | null;
  statuses: ReadonlyMap<string, UiProjectStatus>;
  dataOverride: string | undefined;
  onBack: () => void;
  onItem: (ref: string) => void;
}): preact.JSX.Element {
  if (rollout === null) {
    return <section class="detail detail-empty" aria-hidden="true" />;
  }
  const clean = rollout.projects.filter((entry) => entry.state === "behind");
  // One command per clean project, with its cd, because each project takes
  // the update on its own. A project still loading has no cd command yet.
  // The update part is built like the server's own action: the same prefix,
  // the ref quoted, and --local after it (src/status-actions.ts).
  const commands = clean.flatMap((entry) => {
    const cd = statuses.get(entry.project)?.cdCommand;
    if (!cd) return [];
    const update = capshelfCommand(dataOverride, [
      "update",
      rollout.ref,
      ...(entry.scope === "local" ? ["--local"] : []),
    ]);
    return [{ project: entry.name, command: `${cd} && ${update}` }];
  });
  return (
    <article class="detail" aria-label={`${rollout.name} rollout`}>
      <div class="detail-body">
        <DetailHead
          crumbs="Shelf / Rollouts"
          title={rollout.name}
          backLabel="Rollouts"
          onBack={onBack}
        >
          <p class="detail-state tone-attention">
            <Icon name="refresh" />
            <span>
              <b>
                {rollout.behind} of {rollout.projects.length}{" "}
                {rollout.projects.length === 1
                  ? "project pins"
                  : "projects pin"}{" "}
                an older version.
              </b>{" "}
              <span class="muted">
                Each project changes only when its own update runs.
              </span>
            </span>
          </p>
        </DetailHead>

        <section class="detail-section" aria-label="Projects">
          <h3 class="section-label">Projects</h3>
          <table class="table">
            <tbody>
              {rollout.projects.map((usage) => (
                <tr key={`${usage.project}:${usage.scope}`}>
                  <td>
                    <a href={projectItemHref(usage)}>{usage.name}</a>
                    {usage.scope === "local" ? (
                      <span class="muted"> · local</span>
                    ) : null}
                  </td>
                  <td>
                    <UsageBadge usage={usage} />
                  </td>
                  <td class="muted table-note">
                    {usage.state === "behind-edited"
                      ? "Decide in the project: merge or overwrite."
                      : usage.state === "behind"
                        ? "No local edit. A plain update takes it."
                        : usage.state === "other" && usage.pinCurrent === false
                          ? "Pins an older version. Resolve the finding in the project first."
                          : usage.state === "pin-behind"
                            ? "Reading the project's status."
                            : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {commands.length > 0 ? (
          <section class="detail-section" aria-label="Commands">
            <h3 class="section-label">
              {commands.length === 1
                ? "Update the clean project"
                : `Update the ${commands.length} clean projects`}
            </h3>
            <ul class="alts">
              {commands.map((entry) => (
                <li key={entry.command} class="alt-row">
                  <span class="alt-row-purpose">{entry.project}</span>
                  <CommandText command={entry.command} />
                  <CopyButton
                    text={entry.command}
                    label={`Copy ${entry.command}`}
                    compact
                  />
                </li>
              ))}
            </ul>
            <p class="section-note">
              A project with a local edit is not in this list. Open it to merge
              or overwrite on its own.
            </p>
          </section>
        ) : null}

        <p class="section-note">
          <button
            type="button"
            class="link-button"
            onClick={() => onItem(rollout.ref)}
          >
            Read {rollout.name} on the shelf
          </button>
        </p>
      </div>
    </article>
  );
}

function CoveragePane({
  picker,
  shelf,
  statuses,
  pending,
  onItem,
}: {
  picker: ComponentChildren;
  shelf: UiShelf;
  statuses: ReadonlyMap<string, UiProjectStatus>;
  pending: ReadonlySet<string>;
  onItem: (ref: string) => void;
}): preact.JSX.Element {
  const projects = shelf.projects.filter((project) => project.exists);
  const rows: CoverageRow[] = shelfCoverage(
    shelf.items,
    projects.map((project) => project.path),
    statuses,
    pending,
  );
  return (
    <section class="list coverage" aria-label="Coverage">
      {picker}
      <div class="list-head">
        <h1 class="list-title">Coverage</h1>
        <p class="list-sub">
          Shelf items by the projects bound to this shelf. A dash means the
          project does not have the item.
        </p>
      </div>
      {rows.length === 0 || projects.length === 0 ? (
        <p class="list-empty">
          {projects.length === 0
            ? "No registered project is bound to this shelf."
            : "The shelf holds no items yet."}
        </p>
      ) : (
        <div class="coverage-scroll">
          <table class="table coverage-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                {projects.map((project) => (
                  <th key={project.path} scope="col" title={project.path}>
                    {splitDisplayPath(project.display).name}
                  </th>
                ))}
                <th scope="col">Projects</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ref} class={row.used === 0 ? "is-unused" : ""}>
                  <th scope="row">
                    <button
                      type="button"
                      class="link-button"
                      onClick={() => onItem(row.ref)}
                    >
                      {row.name}
                    </button>
                    <span class="list-row-kind">{kindNoun(row.kind)}</span>
                  </th>
                  {row.cells.map((cell, index) => (
                    <td key={projects[index]?.path ?? index}>
                      {cell === null ? (
                        <span class="coverage-none">
                          <span aria-hidden="true">—</span>
                          <span class="visually-hidden">not added</span>
                        </span>
                      ) : (
                        <a href={projectItemHref(cell)} class="coverage-cell">
                          <UsageBadge usage={cell} />
                        </a>
                      )}
                    </td>
                  ))}
                  <td class={row.used === 0 ? "tone-attention" : "muted"}>
                    {row.used === 0 ? "used nowhere" : row.used}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function hasNeeds(needs: {
  network: string[];
  env: string[];
  bin: string[];
}): boolean {
  return (
    needs.network.length > 0 || needs.env.length > 0 || needs.bin.length > 0
  );
}

function needsText(needs: {
  network: string[];
  env: string[];
  bin: string[];
}): string {
  return [
    needs.network.length > 0 ? `network ${needs.network.join(", ")}` : null,
    needs.env.length > 0 ? `env ${needs.env.join(", ")}` : null,
    needs.bin.length > 0 ? `bin ${needs.bin.join(", ")}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function HighlightedRef({
  text,
  positions,
}: {
  text: string;
  positions: number[];
}): preact.JSX.Element {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  const chars = [...text];
  const parts: preact.JSX.Element[] = [];
  let run = "";
  let plain = "";
  const flushPlain = (): void => {
    if (plain) parts.push(<span key={`p${parts.length}`}>{plain}</span>);
    plain = "";
  };
  const flushRun = (): void => {
    if (run) parts.push(<mark key={`m${parts.length}`}>{run}</mark>);
    run = "";
  };
  chars.forEach((char, index) => {
    if (marked.has(index)) {
      flushPlain();
      run += char;
    } else {
      flushRun();
      plain += char;
    }
  });
  flushPlain();
  flushRun();
  return <>{parts}</>;
}
