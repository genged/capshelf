import type {
  DiffViewName,
  UiDiffResponse,
  UiRegisteredProject,
} from "../shared/api-types";
import { isKind, kindLabel } from "../shared/kind-label";
import {
  type FilterTab,
  filterItems,
  groupByKind,
  groupItems,
  inTab,
  type KindChip,
  matchesQuery,
  projectCounts,
  type ReviewKind,
  summaryLine,
} from "../shared/view-model";
import { CopyButton, EmptyState, KindChips, Notice, Skeleton } from "./common";
import type { ProjectLoad } from "./dashboard";
import { ExternalRow, shadowedItemId, shadowWording } from "./ExternalRow";
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
  displayPath,
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
  kind: ReviewKind | null;
  onKind: (kind: ReviewKind | null) => void;
  query: string;
  /** Home-relative form of an absolute path, for rows that live outside. */
  displayPath: (path: string) => string;
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
  // What a harness loads here that Capshelf does not manage. These rows sit
  // beside the panels, count under All only, and never need attention.
  const externalSkills = data.external;
  const plugins = data.externalClaudePlugins;
  const userSkills = data.externalUserSkills;
  const externalCount = (count: number): number => (tab === "all" ? count : 0);

  const chips: Array<KindChip<ReviewKind>> = [];
  if (externalSkills.length > 0 && !kinds.some((g) => g.kind === "skills")) {
    chips.push({
      id: "skills",
      label: kindLabel("skills"),
      count: externalCount(externalSkills.length),
    });
  }
  for (const group of kinds) {
    chips.push({
      id: group.kind,
      label: group.label,
      count:
        group.rows.filter((item) => inTab(item, tab)).length +
        (group.kind === "skills" ? externalCount(externalSkills.length) : 0),
    });
  }
  if (plugins.length > 0) {
    chips.push({
      id: "plugins",
      label: "Claude plugins",
      count: externalCount(plugins.length),
    });
  }
  if (userSkills.length > 0) {
    chips.push({
      id: "user-skills",
      label: "User-level skills",
      count: externalCount(userSkills.length),
    });
  }

  // A kind chosen in another project may be absent here; then no kind filters.
  const activeKind = chips.some((chip) => chip.id === kind) ? kind : null;
  const activeLabel = chips.find((chip) => chip.id === activeKind)?.label;
  const where = activeLabel === undefined ? "" : ` in ${activeLabel}`;
  const inKind =
    activeKind === null
      ? data.items
      : isKind(activeKind)
        ? data.items.filter((item) => item.kind === activeKind)
        : [];
  // The tabs count inside the chosen kind; the chips count inside the tab.
  const counts = projectCounts(inKind);
  const shown = filterItems(inKind, tab, query);
  const showExternal = (id: ReviewKind): boolean =>
    tab === "all" && (activeKind === null || activeKind === id);
  const shownExternalSkills = showExternal("skills")
    ? externalSkills.filter((skill) =>
        matchesQuery(`skills/${skill.name}`, query),
      )
    : [];
  const shownPlugins = showExternal("plugins")
    ? plugins.filter((plugin) => matchesQuery(`plugins/${plugin.id}`, query))
    : [];
  const shownUserSkills = showExternal("user-skills")
    ? userSkills.filter((skill) => matchesQuery(`skills/${skill.name}`, query))
    : [];
  const groups = groupItems(shown);
  if (
    shownExternalSkills.length > 0 &&
    !groups.some((group) => group.kind === "skills")
  ) {
    groups.push({ kind: "skills", label: kindLabel("skills"), rows: [] });
  }
  const nothingShown =
    shown.length === 0 &&
    shownExternalSkills.length === 0 &&
    shownPlugins.length === 0 &&
    shownUserSkills.length === 0;

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

      {total.items === 0 && chips.length === 0 ? (
        <EmptyState title="No items are tracked in this project">
          <p>
            <code>capshelf add</code> opens the shelf picker. Nothing here has a
            lock entry yet.
          </p>
        </EmptyState>
      ) : nothingShown ? (
        <p class="muted panels-empty">
          {query.trim().length > 0
            ? `Nothing matches “${query}”${where}.`
            : tab === "attention"
              ? `Nothing needs attention${where}.`
              : tab === "ok"
                ? `Nothing is up to date${where}.`
                : `Nothing${where}.`}
        </p>
      ) : (
        <div class="panels">
          {groups.map((group) => (
            <section
              key={group.kind}
              class="kind-group"
              aria-labelledby={`review-kind-${group.kind}`}
            >
              <h2 id={`review-kind-${group.kind}`} class="kind-heading">
                <span>{group.label}</span>
                <span class="kind-count">
                  {group.rows.length +
                    (group.kind === "skills" ? shownExternalSkills.length : 0)}
                </span>
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
                {group.kind === "skills"
                  ? shownExternalSkills.map((skill) => (
                      <ExternalRow
                        key={`skills.sh:${skill.name}`}
                        domId={panelDomId(`external/skills/${skill.name}`)}
                        itemRef={`skills/${skill.name}`}
                        origin="skills.sh"
                        detail={skill.source}
                        note="Managed by skills.sh. Capshelf reports it and never edits it."
                      />
                    ))
                  : null}
              </div>
            </section>
          ))}

          {shownPlugins.length > 0 ? (
            <section class="kind-group" aria-labelledby="review-kind-plugins">
              <h2 id="review-kind-plugins" class="kind-heading">
                <span>Claude plugins</span>
                <span class="kind-count">{shownPlugins.length}</span>
              </h2>
              <div class="kind-panels">
                {shownPlugins.map((plugin) => (
                  <ExternalRow
                    key={`${plugin.scope}:${plugin.id}`}
                    domId={panelDomId(`plugin/${plugin.scope}/${plugin.id}`)}
                    itemRef={`plugins/${plugin.id}`}
                    origin="plugin"
                    detail={`${plugin.enabled ? "enabled" : "disabled"} · ${plugin.scope} · ${displayPath(plugin.settingsPath)}`}
                    note="Enabled in Claude settings. Capshelf reports it and never edits it."
                    machineLink={
                      plugin.scope === "user" || plugin.scope === "managed"
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {shownUserSkills.length > 0 ? (
            <section
              id={panelDomId("user-skills")}
              class="kind-group"
              aria-labelledby="review-kind-user-skills"
            >
              <h2 id="review-kind-user-skills" class="kind-heading">
                <span>User-level skills</span>
                <span class="kind-count">{shownUserSkills.length}</span>
                <a class="kind-link" href="#/machine">
                  This machine
                </a>
              </h2>
              <div class="kind-panels">
                {shownUserSkills.map((skill) => {
                  const words = shadowWording(skill.surface);
                  return (
                    <ExternalRow
                      key={`${skill.surface}:${skill.path}`}
                      domId={panelDomId(`user/${skill.surface}/${skill.name}`)}
                      itemRef={`skills/${skill.name}`}
                      origin={skill.surface === "claude" ? "Claude" : "Codex"}
                      detail={displayPath(skill.path)}
                      note="A user-level skill from the home directory. Capshelf reports it and never edits it."
                      machineLink
                    >
                      {skill.shadows.length > 0 ? (
                        <span class={`external-finding tone-${words.tone}`}>
                          {words.lead}{" "}
                          {skill.shadows.map((shadow, index) => (
                            <span key={shadowedItemId(skill, shadow)}>
                              {index > 0 ? ", " : ""}
                              <a
                                href={`#/status/${encodeURIComponent(project)}/${encodeURIComponent(shadowedItemId(skill, shadow))}`}
                              >
                                {shadow.scope} skills/{skill.name}
                              </a>
                            </span>
                          ))}
                          {words.tail}
                        </span>
                      ) : null}
                    </ExternalRow>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
