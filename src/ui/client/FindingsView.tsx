import type { ComponentChildren } from "preact";
import type {
  DiffViewName,
  UiDiffResponse,
  UiProjectStatus,
} from "../shared/api-types";
import { findingsAcrossProjects, sharedFindings } from "../shared/view-model";
import { ItemDetail } from "./ItemDetail";
import { ItemRow } from "./ItemRow";
import { Icon } from "./icons";

/**
 * Every finding on the machine in one list, grouped by project. The terminal
 * shows one project at a time; this view is the reason the UI exists. With
 * nothing selected, the first finding opens.
 */
export function FindingsView({
  statuses,
  pending,
  unread,
  discovering,
  project,
  item,
  onSelect,
  loadDiff,
  picker,
  dataOverride,
}: {
  statuses: UiProjectStatus[];
  /** Projects still loading, so an empty list is not called all clear. */
  pending: number;
  /**
   * Registered projects with no current status: a missing manifest, a failed
   * read, or a failed refresh. Their findings are unknown, so the view is
   * never all clear while one exists.
   */
  unread: string[];
  /** The overview has not arrived, so the project count is unknown. */
  discovering: boolean;
  /** The session's --data override, repeated on every printed command. */
  dataOverride: string | undefined;
  project: string | null;
  item: string | null;
  onSelect: (project: string, item: string | null) => void;
  loadDiff: (
    project: string,
    item: string,
    view: DiffViewName,
  ) => Promise<UiDiffResponse>;
  picker: ComponentChildren;
}): preact.JSX.Element {
  const groups = findingsAcrossProjects(statuses);
  const shared = sharedFindings(groups);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const selectedGroup =
    groups.find((group) => group.project === project) ?? groups[0] ?? null;
  const selected =
    selectedGroup?.rows.find((row) => row.id === item) ??
    (project === null ? (selectedGroup?.rows[0] ?? null) : null);

  return (
    <>
      <section class="list" aria-label="All findings">
        {picker}
        <div class="list-head">
          <h1 class="list-title">All findings</h1>
          <p class="list-sub">
            {discovering
              ? "Reading every project…"
              : total === 0
                ? pending > 0
                  ? `Reading ${pending} more ${pending === 1 ? "project" : "projects"}…`
                  : `Nothing needs attention in the ${statuses.length} ${statuses.length === 1 ? "project" : "projects"} read.`
                : `${total} ${total === 1 ? "item" : "items"} in ${groups.length} of the ${statuses.length} ${statuses.length === 1 ? "project" : "projects"} read.`}
          </p>
        </div>
        {unread.length > 0 ? (
          <p class="list-note" role="status">
            <Icon name="alert" />
            <span>
              {unread.length === 1
                ? "1 project has no current status"
                : `${unread.length} projects have no current status`}
              : {unread.join(", ")}. Their findings are not in this list.
            </span>
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.project} aria-label={group.name}>
            <h2 class="list-group-head">
              {group.name}
              <span class="count is-attention">{group.rows.length}</span>
              <a href={`#/status/${encodeURIComponent(group.project)}`}>
                Open project
              </a>
            </h2>
            <ul class="list-rows">
              {group.rows.map((row) => (
                <ItemRow
                  key={row.id}
                  item={row}
                  selected={
                    selectedGroup?.project === group.project &&
                    selected?.id === row.id
                  }
                  changed={false}
                  showState
                  onSelect={() => onSelect(group.project, row.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        {shared.length > 0 ? (
          <section aria-label="Same change in more than one project">
            <h2 class="list-group-head">
              Same change in more than one project
            </h2>
            {shared.map((entry) => (
              <p key={entry.ref} class="list-note">
                <Icon name="refresh" />
                <span>
                  <b class="mono">{entry.ref}</b> is behind the shelf in{" "}
                  {entry.projects.join(", ")}. Each project takes the update on
                  its own.
                </span>
              </p>
            ))}
          </section>
        ) : null}
      </section>
      {selected && selectedGroup ? (
        <ItemDetail
          key={`${selectedGroup.project}:${selected.id}`}
          item={selected}
          projectName={selectedGroup.name}
          dataOverride={dataOverride}
          loadDiff={(view) =>
            loadDiff(selectedGroup.project, selected.id, view)
          }
          onBack={() => onSelect(selectedGroup.project, null)}
        />
      ) : (
        <section class="detail detail-empty">
          {!discovering &&
          total === 0 &&
          pending === 0 &&
          unread.length === 0 ? (
            <p class="banner" role="status">
              <Icon name="check" />
              <span>Every project is up to date. Nothing to run.</span>
            </p>
          ) : (
            <p>Select a finding to see why and what to run.</p>
          )}
        </section>
      )}
    </>
  );
}
