import type {
  DiffViewName,
  UiDiffResponse,
  UiProjectStatus,
  UiRegisteredProject,
} from "../shared/api-types";
import {
  filterItems,
  projectCounts,
  summaryLine,
  type FilterTab,
} from "../shared/view-model";
import type { ProjectLoad } from "./dashboard";
import { EmptyState, Notice, Skeleton } from "./common";
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

  const counts = projectCounts(data.items);
  const shown = filterItems(data.items, tab, query);
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
          {data.dataRepoDisplay ? (
            <>
              {" · shelf "}
              <span class="mono">{data.dataRepoDisplay}</span>
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
      </header>

      {data.notices.map((notice) => (
        <Notice key={notice.message} notice={notice} />
      ))}

      {counts.items > 0 && counts.attention === 0 ? (
        <p class="all-clear" role="status">
          <Icon name="check" />
          <span>
            All {counts.items} {counts.items === 1 ? "item is" : "items are"} up
            to date{counts.kept > 0 ? `, ${counts.kept} kept local` : ""}.
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

      {counts.items === 0 ? (
        <EmptyState title="No items are tracked in this project">
          <p>
            <code>capshelf add</code> opens the shelf picker. Nothing here has a
            lock entry yet.
          </p>
        </EmptyState>
      ) : shown.length === 0 ? (
        <p class="muted panels-empty">
          {query.trim().length > 0
            ? `No item matches “${query}”.`
            : tab === "attention"
              ? "Nothing needs attention."
              : "No item is up to date."}
        </p>
      ) : (
        <div class="panels">
          {shown.map((item) => (
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
