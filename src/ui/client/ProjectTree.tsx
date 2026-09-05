import { itemIcon } from "../shared/state-label";
import type { TreeEntry } from "../shared/view-model";
import { groupItems, matchesQuery } from "../shared/view-model";
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
            const data = selected ? load?.data : undefined;
            const matches = (text: string): boolean =>
              matchesQuery(text, query) || matchesQuery(entry.display, query);
            const groups = data
              ? groupItems(data.items.filter((item) => matches(item.ref)))
              : [];
            // Read-only rows for what a harness loads here but Capshelf
            // does not manage: skills.sh skills under Skills, and every
            // Claude plugin that loads in this project, whatever its scope.
            const externalSkills = data
              ? data.external.filter((skill) => matches(`skills/${skill.name}`))
              : [];
            const plugins = data
              ? data.externalClaudePlugins.filter((plugin) =>
                  matches(`plugins/${plugin.id}`),
                )
              : [];
            // One row stands for the user-level skills; the page lists them.
            const userSkills = data?.externalUserSkills ?? [];
            const showUserSkills =
              userSkills.length > 0 &&
              (matches("user-level skills") ||
                userSkills.some((skill) => matches(`skills/${skill.name}`)));
            if (
              externalSkills.length > 0 &&
              !groups.some((group) => group.kind === "skills")
            ) {
              groups.push({ kind: "skills", label: "Skills", rows: [] });
            }
            const focusable =
              selected || (selectedPath === null && position === 0);
            const externalRow = (
              id: string,
              name: string,
              title: string,
              chip: string | null = null,
            ): preact.JSX.Element => (
              <li key={id}>
                <button
                  type="button"
                  data-tree-row
                  data-kind="item"
                  data-project={entry.path}
                  class="tree-row tree-item tone-external"
                  tabIndex={-1}
                  onClick={() => onSelectItem(entry.path, id)}
                  onKeyDown={onRowKeyDown}
                  title={title}
                >
                  <Icon name="notequal" label="External" />
                  <span class="tree-item-name">{name}</span>
                  {chip !== null ? <span class="chip">{chip}</span> : null}
                </button>
              </li>
            );
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
                {groups.length > 0 || plugins.length > 0 || showUserSkills ? (
                  <ul class="tree-items">
                    {groups.map((group) => (
                      <li key={group.kind} class="tree-kind">
                        <span class="tree-kind-label kind-heading">
                          {group.label}
                        </span>
                        <ul class="tree-kind-items" aria-label={group.label}>
                          {group.rows.map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                data-tree-row
                                data-kind="item"
                                data-project={entry.path}
                                class={`tree-row tree-item tone-${item.attention ? "attention" : item.tone}`}
                                tabIndex={-1}
                                onClick={() =>
                                  onSelectItem(entry.path, item.id)
                                }
                                onKeyDown={onRowKeyDown}
                                title={`${item.ref} · ${item.stateLabel}`}
                              >
                                <Icon
                                  name={itemIcon(
                                    item.row.state,
                                    item.attention,
                                  )}
                                  label={item.stateLabel}
                                />
                                <span class="tree-item-name">{item.name}</span>
                                {item.scope === "local" ? (
                                  <span class="chip chip-scope">local</span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                          {group.kind === "skills"
                            ? externalSkills.map((skill) =>
                                externalRow(
                                  `external/skills/${skill.name}`,
                                  skill.name,
                                  `skills/${skill.name} · managed by skills.sh`,
                                ),
                              )
                            : null}
                        </ul>
                      </li>
                    ))}
                    {plugins.length > 0 ? (
                      <li class="tree-kind">
                        <span class="tree-kind-label kind-heading">
                          Claude plugins
                        </span>
                        <ul class="tree-kind-items" aria-label="Claude plugins">
                          {plugins.map((plugin) =>
                            externalRow(
                              `plugin/${plugin.scope}/${plugin.id}`,
                              plugin.name,
                              `plugins/${plugin.id} · ${plugin.enabled ? "enabled" : "disabled"} · ${plugin.scope}`,
                              plugin.scope === "project" ? null : plugin.scope,
                            ),
                          )}
                        </ul>
                      </li>
                    ) : null}
                    {showUserSkills ? (
                      <li class="tree-kind">
                        <ul
                          class="tree-kind-items"
                          aria-label="User-level skills"
                        >
                          {externalRow(
                            "user-skills",
                            "User-level skills",
                            `${userSkills.length} user-level ${userSkills.length === 1 ? "skill" : "skills"} from this machine`,
                            String(userSkills.length),
                          )}
                        </ul>
                      </li>
                    ) : null}
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
