import type { ComponentChildren } from "preact";
import type {
  DiffViewName,
  UiDiffResponse,
  UiProjectStatus,
  UiRegisteredProject,
} from "../shared/api-types";
import {
  type ExternalEntry,
  externalEntries,
  listGroups,
  projectCounts,
  splitDisplayPath,
} from "../shared/view-model";
import {
  CommandText,
  CopyButton,
  EmptyState,
  Notice,
  Skeleton,
} from "./common";
import type { ProjectLoad } from "./dashboard";
import { ExternalDetail, externalRowText } from "./ExternalRow";
import { ActionBar, DetailHead, ItemDetail } from "./ItemDetail";
import { ItemRow, onListKeyDown } from "./ItemRow";
import { Icon } from "./icons";

export type ListFilter = "attention" | "all";

/**
 * The project as two panes: the item list and the detail of the selected
 * item, or the project overview when nothing is selected.
 */
export function ProjectView({
  project,
  registered,
  load,
  filter,
  onFilter,
  selected,
  onSelect,
  displayPath,
  loadDiff,
  picker,
}: {
  /** The phone's project picker; hidden on wider screens. */
  picker: ComponentChildren;
  project: string;
  registered: UiRegisteredProject;
  load: ProjectLoad;
  filter: ListFilter;
  onFilter: (filter: ListFilter) => void;
  selected: string | null;
  onSelect: (itemId: string | null) => void;
  displayPath: (path: string) => string;
  loadDiff: (itemId: string, view: DiffViewName) => Promise<UiDiffResponse>;
}): preact.JSX.Element {
  const data = load.data;
  const name = splitDisplayPath(registered.display).name;

  if (!data) {
    return (
      <>
        <section class="list" aria-label={`${name} items`}>
          {picker}
          <div class="list-head">
            <h1 class="list-title">{name}</h1>
            <p class="list-sub mono">{registered.display}</p>
          </div>
          {load.state === "error" ? (
            <EmptyState title="This project could not be read">
              <p>{load.error?.message ?? "unknown error"}</p>
              {load.error?.hint ? <p class="muted">{load.error.hint}</p> : null}
              <p class="muted">
                <code>capshelf status</code> in the project prints the same
                refusal.
              </p>
            </EmptyState>
          ) : (
            <div class="list-empty">
              <Skeleton lines={5} label="Reading the lock and the data repo" />
            </div>
          )}
        </section>
        <section class="detail" aria-hidden="true" />
      </>
    );
  }

  const externals = externalEntries(data);
  const item = data.items.find((entry) => entry.id === selected) ?? null;
  const external =
    item === null
      ? (externals.find((entry) => entry.id === selected) ?? null)
      : null;

  return (
    <>
      <ItemList
        picker={picker}
        data={data}
        name={name}
        externals={externals}
        filter={filter}
        onFilter={onFilter}
        selected={selected}
        changed={load.changed}
        refreshError={
          load.state === "error" ? (load.error?.message ?? null) : null
        }
        onSelect={onSelect}
      />
      {item ? (
        <ItemDetail
          key={item.id}
          item={item}
          projectName={name}
          loadDiff={(view) => loadDiff(item.id, view)}
          onBack={() => onSelect(null)}
        />
      ) : external ? (
        <ExternalDetail
          key={external.id}
          entry={external}
          project={project}
          projectName={name}
          displayPath={displayPath}
          onBack={() => onSelect(null)}
        />
      ) : (
        <ProjectOverview
          data={data}
          name={name}
          externals={externals}
          onBack={() => onSelect(null)}
        />
      )}
    </>
  );
}

function ItemList({
  picker,
  data,
  name,
  externals,
  filter,
  onFilter,
  selected,
  changed,
  refreshError,
  onSelect,
}: {
  picker: ComponentChildren;
  data: UiProjectStatus;
  name: string;
  externals: ExternalEntry[];
  filter: ListFilter;
  onFilter: (filter: ListFilter) => void;
  selected: string | null;
  changed: Set<string>;
  refreshError: string | null;
  onSelect: (itemId: string) => void;
}): preact.JSX.Element {
  const counts = projectCounts(data.items);
  const shown =
    filter === "attention"
      ? data.items.filter((entry) => entry.attention)
      : data.items;
  const groups = listGroups(shown);
  const warnings = data.notices.filter((notice) => notice.level === "warn");

  return (
    <section class="list" aria-label={`${name} items`}>
      {picker}
      <div class="list-head">
        <h1 class="list-title" title={data.project}>
          {name}
        </h1>
        <p class="list-sub">
          <span class="mono">{data.display}</span>
          <CopyButton
            text={data.cdCommand}
            label={`Copy ${data.cdCommand}`}
            compact
          />
          {refreshError ? (
            <span class="tone-attention">refresh failed: {refreshError}</span>
          ) : null}
        </p>
        <div class="seg" role="tablist" aria-label="Show">
          <button
            type="button"
            role="tab"
            class="seg-option"
            aria-selected={filter === "attention"}
            onClick={() => onFilter("attention")}
          >
            Needs attention{" "}
            <span class={`count${counts.attention > 0 ? " is-attention" : ""}`}>
              {counts.attention}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            class="seg-option"
            aria-selected={filter === "all"}
            onClick={() => onFilter("all")}
          >
            All <span class="count">{counts.items}</span>
          </button>
        </div>
      </div>

      {warnings.map((notice) => (
        <div key={notice.message} class="list-note">
          <Icon name="alert" />
          <span>{notice.message}</span>
        </div>
      ))}

      {data.items.length === 0 && externals.length === 0 ? (
        <p class="list-empty">
          No item is tracked here yet. <code>capshelf add</code> opens the shelf
          picker.
        </p>
      ) : groups.length === 0 && filter === "attention" ? (
        <p class="list-empty">
          Nothing needs attention.{" "}
          <button
            type="button"
            class="link-button"
            onClick={() => onFilter("all")}
          >
            Show all {counts.items} items
          </button>
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <h2 class="list-group-head">{group.label}</h2>
          <ul class="list-rows">
            {group.rows.map((entry) => (
              <ItemRow
                key={entry.id}
                item={entry}
                selected={selected === entry.id}
                changed={changed.has(entry.id)}
                showState={group.id !== "ok" || entry.attention}
                onSelect={() => onSelect(entry.id)}
              />
            ))}
          </ul>
        </section>
      ))}

      {filter === "all" && externals.length > 0 ? (
        <section aria-label="Not managed by Capshelf">
          <h2 class="list-group-head">Not managed by Capshelf</h2>
          <ul class="list-rows">
            {externals.map((entry) => {
              const text = externalRowText(entry);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    class="list-row tone-external"
                    aria-current={selected === entry.id ? "true" : undefined}
                    onClick={() => onSelect(entry.id)}
                    onKeyDown={onListKeyDown}
                  >
                    <Icon name={text.icon} label="Not managed by Capshelf" />
                    <span class="list-row-name">
                      {entry.name}
                      <span class="list-row-kind">{text.kind}</span>
                    </span>
                    <span class="list-row-state">{text.state}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/** The right pane when no item is selected: the project itself. */
function ProjectOverview({
  data,
  name,
  externals,
  onBack,
}: {
  data: UiProjectStatus;
  name: string;
  externals: ExternalEntry[];
  onBack: () => void;
}): preact.JSX.Element {
  const counts = projectCounts(data.items);
  const skillsSh = externals.filter((entry) => entry.type === "skills.sh");
  const plugins = externals.filter((entry) => entry.type === "plugin");
  const userSkills = externals.filter((entry) => entry.type === "user-skill");
  const alsoLoaded = [
    skillsSh.length > 0
      ? `${skillsSh.length} skills.sh ${skillsSh.length === 1 ? "skill" : "skills"}`
      : null,
    plugins.length > 0
      ? `${plugins.length} Claude ${plugins.length === 1 ? "plugin" : "plugins"}`
      : null,
    userSkills.length > 0
      ? `${userSkills.length} user-level ${userSkills.length === 1 ? "skill" : "skills"}`
      : null,
  ].filter((part) => part !== null);
  return (
    <article class="detail" aria-label={`${name} overview`}>
      <ActionBar
        icon="folder"
        tone="ok"
        name={name}
        where="this machine"
        primary={null}
      />
      <div class="detail-body">
        <DetailHead
          crumbs="Project"
          title={name}
          backLabel="Items"
          onBack={onBack}
        />
        {counts.items === 0 ? null : counts.attention === 0 ? (
          <p class="banner" role="status">
            <Icon name="check" />
            <span>
              All {counts.items} {counts.items === 1 ? "item is" : "items are"}{" "}
              up to date{counts.kept > 0 ? `, ${counts.kept} kept local` : ""}.
              Nothing to run.
            </span>
          </p>
        ) : (
          <p class="banner tone-attention" role="status">
            <Icon name="alert" />
            <span>
              {counts.attention} of {counts.items}{" "}
              {counts.attention === 1 ? "item needs" : "items need"} attention.
              Select one to see why and what to run.
            </span>
          </p>
        )}

        {data.notices.length > 0 ? (
          <section class="detail-section" aria-label="Notices">
            {data.notices.map((notice) => (
              <Notice key={notice.message} notice={notice} />
            ))}
          </section>
        ) : null}

        <section class="detail-section" aria-label="Project">
          <h3 class="section-label">Project</h3>
          <div class="card">
            <dl class="props">
              <dt>Path</dt>
              <dd class="mono">{data.display}</dd>
              <dt>Shelf</dt>
              <dd>
                {data.dataRepo !== null && data.dataRepoDisplay ? (
                  <a
                    class="mono"
                    href={`#/shelf/${encodeURIComponent(data.dataRepo)}`}
                  >
                    {data.dataRepoDisplay}
                  </a>
                ) : (
                  <span class="tone-attention">no data repo bound</span>
                )}
                {data.dataRepoUpstream ? (
                  <span class="muted">
                    {" "}
                    · <span class="mono">{data.dataRepoUpstream}</span>
                  </span>
                ) : null}
              </dd>
              <dt>Skills go to</dt>
              <dd>
                {data.installMode === "claude-only" ? (
                  <span class="mono">.claude/skills</span>
                ) : (
                  <>
                    <span class="mono">.agents/skills</span>, linked from{" "}
                    <span class="mono">.claude/skills</span>
                  </>
                )}
              </dd>
              <dt>Lock</dt>
              <dd>
                version {data.lockVersion}
                {data.localLockVersion !== data.lockVersion
                  ? ` (local lock version ${data.localLockVersion})`
                  : ""}
              </dd>
            </dl>
          </div>
        </section>

        <section class="detail-section" aria-label="Commands">
          <h3 class="section-label">Commands</h3>
          <ul class="alts">
            {[
              { command: data.cdCommand, purpose: "Go to the project" },
              {
                command: "capshelf add",
                purpose: "Add an item from the shelf",
              },
              { command: "capshelf status", purpose: "Check from a terminal" },
            ].map((action) => (
              <li key={action.command} class="alt-row">
                <span class="alt-row-purpose">{action.purpose}</span>
                <CommandText command={action.command} />
                <CopyButton
                  text={action.command}
                  label={`Copy ${action.command}`}
                  compact
                />
              </li>
            ))}
          </ul>
        </section>

        {alsoLoaded.length > 0 ? (
          <section class="detail-section" aria-label="Also loaded here">
            <h3 class="section-label">Also loaded here</h3>
            <p class="muted">
              {alsoLoaded.join(", ")}. Capshelf reports them and never edits
              them. They are listed under All.
            </p>
          </section>
        ) : null}
      </div>
    </article>
  );
}
