import { stateIcon } from "../shared/state-label";
import type { TreeEntry } from "../shared/view-model";
import { matchesQuery, sortItems } from "../shared/view-model";
import type { ProjectLoad } from "./dashboard";
import { Icon } from "./icons";

export function ProjectTree({
  entries,
  loads,
  selectedPath,
  query,
  registryDisplay,
  onSelect,
  onSelectItem,
}: {
  entries: TreeEntry[];
  loads: Map<string, ProjectLoad>;
  selectedPath: string | null;
  query: string;
  registryDisplay: string | null;
  onSelect: (path: string) => void;
  onSelectItem: (path: string, itemId: string) => void;
}): preact.JSX.Element {
  const visible = entries.filter((entry) => {
    if (matchesQuery(entry.display, query)) return true;
    const load = loads.get(entry.path);
    return (
      load?.data?.items.some((item) => matchesQuery(item.ref, query)) ?? false
    );
  });

  // Roving focus over every row, project and item alike, in document order.
  const onRowKeyDown = (event: KeyboardEvent): void => {
    const current = event.currentTarget as HTMLElement;
    const list = current.closest(".tree-list");
    if (!list) return;
    const all = Array.from(
      list.querySelectorAll<HTMLElement>("[data-tree-row]"),
    );
    const index = all.indexOf(current);
    if (index === -1) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all[all.length - 1])?.focus();
      return;
    }
    if (event.key === "ArrowRight") {
      const project = current.dataset.project;
      if (
        project &&
        current.dataset.kind === "project" &&
        project !== selectedPath
      ) {
        event.preventDefault();
        onSelect(project);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      const project = current.dataset.project;
      if (project && current.dataset.kind === "item") {
        event.preventDefault();
        all
          .find(
            (row) =>
              row.dataset.kind === "project" && row.dataset.project === project,
          )
          ?.focus();
      }
    }
  };

  return (
    <nav class="tree" aria-label="Projects">
      <div class="tree-head">
        <h2>Projects</h2>
        {registryDisplay ? (
          <span class="muted tree-registry" title={registryDisplay}>
            registry
          </span>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p class="tree-empty muted">No projects registered.</p>
      ) : visible.length === 0 ? (
        <p class="tree-empty muted">Nothing matches “{query}”.</p>
      ) : (
        <ul class="tree-list">
          {visible.map((entry, position) => {
            const selected = entry.path === selectedPath;
            const load = loads.get(entry.path);
            const items =
              selected && load?.data ? sortItems(load.data.items) : [];
            const focusable =
              selected || (selectedPath === null && position === 0);
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  data-tree-row
                  data-kind="project"
                  data-project={entry.path}
                  class={`tree-row tree-project${selected ? " is-selected" : ""} state-${entry.state}`}
                  aria-current={selected ? "true" : undefined}
                  aria-expanded={selected}
                  tabIndex={focusable ? 0 : -1}
                  onClick={() => onSelect(entry.path)}
                  onKeyDown={onRowKeyDown}
                  title={entry.path}
                >
                  <Icon name="chevron" />
                  <Icon name="folder" />
                  <span class="tree-path">{entry.display}</span>
                  <TreeCounts entry={entry} />
                </button>
                {selected && items.length > 0 ? (
                  <ul class="tree-items">
                    {items
                      .filter(
                        (item) =>
                          matchesQuery(item.ref, query) ||
                          matchesQuery(entry.display, query),
                      )
                      .map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            data-tree-row
                            data-kind="item"
                            data-project={entry.path}
                            class={`tree-row tree-item tone-${item.attention ? "attention" : item.tone}`}
                            tabIndex={-1}
                            onClick={() => onSelectItem(entry.path, item.id)}
                            onKeyDown={onRowKeyDown}
                            title={`${item.ref} · ${item.stateLabel}`}
                          >
                            <Icon
                              name={stateIcon(item.row.state)}
                              label={item.stateLabel}
                            />
                            <span class="tree-item-name">{item.name}</span>
                            {item.scope === "local" ? (
                              <span class="chip chip-scope">local</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function TreeCounts({ entry }: { entry: TreeEntry }): preact.JSX.Element {
  if (entry.state === "missing") {
    return <span class="tree-count tone-attention">missing</span>;
  }
  if (entry.state === "error") {
    return <span class="tree-count tone-attention">error</span>;
  }
  if (entry.counts === null) {
    return (
      <span class="tree-count is-loading">
        <span class="skeleton-dot" />
        <span class="visually-hidden">loading</span>
      </span>
    );
  }
  const { items, attention } = entry.counts;
  if (attention === 0) {
    return (
      <span
        class="tree-count tone-ok"
        title={`${items} ${items === 1 ? "item" : "items"}, all up to date`}
      >
        <Icon name="check" />
        {items}
        <span class="visually-hidden">
          {" "}
          {items === 1 ? "item" : "items"}, all up to date
        </span>
      </span>
    );
  }
  return (
    <span
      class="tree-count tone-attention"
      title={`${attention} of ${items} ${items === 1 ? "item needs" : "items need"} attention`}
    >
      <Icon name="alert" />
      {attention}
      <span class="visually-hidden">
        {" "}
        of {items} {items === 1 ? "item needs" : "items need"} attention
      </span>
    </span>
  );
}
