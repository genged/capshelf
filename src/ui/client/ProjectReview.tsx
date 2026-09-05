import type { ItemKind } from "../../master";
import type {
  DiffViewName,
  UiDiffResponse,
  UiProjectStatus,
  UiRegisteredProject,
} from "../shared/api-types";
import {
  filterItems,
  groupByKind,
  groupItems,
  inTab,
  projectCounts,
  summaryLine,
  type FilterTab,
} from "../shared/view-model";
import type { ProjectLoad } from "./dashboard";
import { CopyButton, EmptyState, KindChips, Notice, Skeleton } from "./common";
import { Icon } from "./icons";
import { ItemPanel } from "./ItemPanel";

const TABS: Array<{ id: FilterTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "ok", label: "Up to date" },
];

export function ReviewLoading(): preact.JSX.Element {
  return (
    <div class="review-body">
      <Skeleton lines={2} label="Loading the project" />
      <Skeleton lines={5} label="Loading items" />
    </div>
  );
}

export function ProjectReview({
  project,
  registered,
  load,
  tab,
  onTab,
  kind,
  onKind,
  query,
  isExpanded,
  onToggle,
  loadDiff,
  panelDomId,
}: {
  project: string;
  registered: UiRegisteredProject;
  load: ProjectLoad;
  tab: FilterTab;
  onTab: (tab: FilterTab) => void;
  kind: ItemKind | null;
  onKind: (kind: ItemKind | null) => void;
  query: string;
  isExpanded: (itemId: string) => boolean;
  onToggle: (itemId: string) => void;
  loadDiff: (itemId: string, view: DiffViewName) => Promise<UiDiffResponse>;
  panelDomId: (itemId: string) => string;
}): preact.JSX.Element {
  const data = load.data;

  if (load.state === "error" && !data) {
    return (
      <div class="review-body">
        <h1 class="review-title">{registered.display}</h1>
        <EmptyState title="This project could not be read">
          <p>{load.error?.message ?? "unknown error"}</p>
          {load.error?.hint ? <p class="muted">{load.error.hint}</p> : null}
          <p class="muted">
            <code>capshelf status</code> in the project prints the same refusal.
          </p>
        </EmptyState>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="review-body">
        <h1 class="review-title">{registered.display}</h1>
        <p class="muted">Reading the lock and the data repo…</p>
        <Skeleton lines={5} label="Loading items" />
      </div>
    );
  }

  const total = projectCounts(data.items);
  const kinds = groupByKind(data.items);
  // A kind chosen in another project may be absent here; then no kind filters.
  const activeKind = kinds.some((group) => group.kind === kind) ? kind : null;
  const activeLabel = kinds.find((group) => group.kind === activeKind)?.label;
  const where = activeLabel === undefined ? "" : ` in ${activeLabel}`;
  const inKind =
    activeKind === null
      ? data.items
      : data.items.filter((item) => item.kind === activeKind);
  // The tabs count inside the chosen kind; the chips count inside the tab.
  const counts = projectCounts(inKind);
  const shown = filterItems(inKind, tab, query);
  const chips = kinds.map((group) => ({
    id: group.kind,
    label: group.label,
    count: group.rows.filter((item) => inTab(item, tab)).length,
  }));
  const tabCount = (id: FilterTab): number =>
    id === "all"
      ? counts.items
      : id === "attention"
        ? counts.attention
        : counts.items - counts.attention;

  const onTabKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next =
      TABS[
        (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) %
          TABS.length
      ];
    if (next) {
      onTab(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  };

  return (
    <div
      class={`review-body${load.state === "loading" ? " is-refreshing" : ""}`}
    >
      <header class="review-head">
        <h1 class="review-title" title={project}>
          {data.display}
        </h1>
        <p class="review-summary">{summaryLine(data.items)}</p>
        <p class="review-meta muted">
          {data.installMode} · lock v{data.lockVersion}
          {data.localLockVersion !== data.lockVersion
            ? ` (local v${data.localLockVersion})`
            : ""}
          {data.dataRepo !== null && data.dataRepoDisplay ? (
            <>
              {" · shelf "}
              <a
                class="mono"
                href={`#/shelf/${encodeURIComponent(data.dataRepo)}`}
                title="Open the shelf"
              >
                {data.dataRepoDisplay}
              </a>
            </>
          ) : (
            " · no data repo bound"
          )}
          {load.state === "error" && load.error ? (
            <span class="tone-attention">
              {" "}
              · refresh failed: {load.error.message}
            </span>
          ) : null}
        </p>
        <p class="review-run">
          <span>
            Run from <span class="mono">{data.display}</span>
          </span>
          <CopyButton
            text={data.cdCommand}
            label={`Copy ${data.cdCommand}`}
            compact
          />
          <span class="muted">
            Read-only. Every command runs as printed from the project root.
          </span>
        </p>
      </header>

      {data.notices.map((notice) => (
        <Notice key={notice.message} notice={notice} />
      ))}

      {total.items > 0 && total.attention === 0 ? (
        <p class="all-clear" role="status">
          <Icon name="check" />
          <span>
            All {total.items} {total.items === 1 ? "item is" : "items are"} up
            to date{total.kept > 0 ? `, ${total.kept} kept local` : ""}.
          </span>
        </p>
      ) : null}

      <div
        class="tabs"
        role="tablist"
        aria-label="Filter items"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            id={`tab-${entry.id}`}
            type="button"
            role="tab"
            class={`tab${tab === entry.id ? " is-active" : ""}`}
            aria-selected={tab === entry.id}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => onTab(entry.id)}
          >
            {entry.label} <span class="tab-count">{tabCount(entry.id)}</span>
          </button>
        ))}
      </div>

      <KindChips
        label="Filter by kind"
        chips={chips}
        selected={activeKind}
        onSelect={onKind}
      />

      {total.items === 0 ? (
        <EmptyState title="No items are tracked in this project">
          <p>
            <code>capshelf add</code> opens the shelf picker. Nothing here has a
            lock entry yet.
          </p>
        </EmptyState>
      ) : shown.length === 0 ? (
        <p class="muted panels-empty">
          {query.trim().length > 0
            ? `Nothing matches “${query}”${where}.`
            : tab === "attention"
              ? `Nothing needs attention${where}.`
              : `Nothing is up to date${where}.`}
        </p>
      ) : (
        <div class="panels">
          {groupItems(shown).map((group) => (
            <section
              key={group.kind}
              class="kind-group"
              aria-labelledby={`review-kind-${group.kind}`}
            >
              <h2 id={`review-kind-${group.kind}`} class="kind-heading">
                <span>{group.label}</span>
                <span class="kind-count">{group.rows.length}</span>
              </h2>
              <div class="kind-panels">
                {group.rows.map((item) => (
                  <ItemPanel
                    key={item.id}
                    item={item}
                    expanded={isExpanded(item.id)}
                    changed={load.changed.has(item.id)}
                    onToggle={() => onToggle(item.id)}
                    loadDiff={(view) => loadDiff(item.id, view)}
                    domId={panelDomId(item.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <ExternalState status={data} />
    </div>
  );
}

function ExternalState({
  status,
}: {
  status: UiProjectStatus;
}): preact.JSX.Element | null {
  const {
    external,
    externalClaudePlugins,
    personalClaudeExternal,
    externalUserSkills,
  } = status;
  if (
    external.length === 0 &&
    externalClaudePlugins.length === 0 &&
    personalClaudeExternal.length === 0 &&
    externalUserSkills.length === 0
  ) {
    return null;
  }
  return (
    <section class="external" aria-labelledby="external-title">
      <h2 id="external-title">External state</h2>
      <p class="muted">Capshelf reports these and never edits them.</p>
      {personalClaudeExternal.length > 0 ? (
        <div class="external-group">
          <h3>Personal Claude skills that shadow a project skill</h3>
          <ul>
            {personalClaudeExternal.map((skill) => (
              <li key={skill.path}>
                <Icon name="alert" label="Warning" />
                <span class="mono">skills/{skill.name}</span>
                <span class="muted"> · {skill.warning.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {external.length > 0 ? (
        <div class="external-group">
          <h3>Managed by skills.sh</h3>
          <ul>
            {external.map((skill) => (
              <li key={skill.name}>
                <span class="mono">skills/{skill.name}</span>
                <span class="muted"> · {skill.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {externalClaudePlugins.length > 0 ? (
        <div class="external-group">
          <h3>Claude plugins</h3>
          <ul>
            {externalClaudePlugins.map((plugin) => (
              <li key={`${plugin.scope}:${plugin.id}`}>
                <span class="mono">plugins/{plugin.id}</span>
                <span class="muted">
                  {" "}
                  · {plugin.enabled ? "enabled" : "disabled"} · {plugin.scope}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {externalUserSkills.length > 0 ? (
        <div class="external-group">
          <h3>User-level skills</h3>
          <ul>
            {externalUserSkills.map((skill) => (
              <li key={`${skill.surface}:${skill.path}`}>
                <span class="mono">skills/{skill.name}</span>
                <span class="muted">
                  {" "}
                  · {skill.surface === "claude" ? "Claude" : "Codex"}
                  {skill.shadows.length > 0
                    ? ` · shadows ${skill.shadows
                        .map((shadow) => `${shadow.scope}/${shadow.source}`)
                        .join(", ")}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
