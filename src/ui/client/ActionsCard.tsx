import type { UiProjectStatus, UiShelfFacts } from "../shared/api-types";
import { sortItems } from "../shared/view-model";
import { CommandRow, CopyButton, Skeleton, formatDay } from "./common";

export function ActionsLoading(): preact.JSX.Element {
  return (
    <section class="card">
      <h2>Actions</h2>
      <Skeleton lines={3} label="Loading commands" />
    </section>
  );
}

export function ActionsCard({
  status,
}: {
  status: UiProjectStatus;
}): preact.JSX.Element {
  const withActions = sortItems(status.items).filter(
    (item) => item.actions.length > 0,
  );
  return (
    <section class="card actions-card" aria-labelledby="actions-title">
      <h2 id="actions-title">Actions</h2>
      <p class="card-lead">
        In <span class="mono">{status.display}</span> run
        <CopyButton
          text={status.cdCommand}
          label={`Copy ${status.cdCommand}`}
          compact
        />
      </p>
      {withActions.length === 0 ? (
        <p class="muted">Nothing to run. Every item is up to date.</p>
      ) : (
        withActions.map((item) => (
          <div key={item.id} class="actions-item">
            <h3 class="mono">
              {item.ref}
              {item.scope === "local" ? (
                <span class="chip chip-scope">local</span>
              ) : null}
            </h3>
            <ul class="command-list">
              {item.actions.map((action) => (
                <CommandRow key={action.command} action={action} />
              ))}
            </ul>
          </div>
        ))
      )}
      <p class="card-foot muted">
        Read-only. Every command runs as printed from the project root.
      </p>
    </section>
  );
}

export function RevisionsCard({
  shelf,
}: {
  shelf: UiShelfFacts | null;
}): preact.JSX.Element {
  return (
    <section class="card revisions-card" aria-labelledby="revisions-title">
      <h2 id="revisions-title">Shelf revisions</h2>
      {shelf === null ? (
        <p class="muted">No data repo is bound to this project.</p>
      ) : (
        <>
          <p class="card-lead">
            <span class="mono">{shelf.display}</span>
            {shelf.branch ? (
              <span class="muted">
                {" "}
                · {shelf.branch}
                {shelf.clean ? "" : " · uncommitted changes"}
              </span>
            ) : null}
          </p>
          {shelf.revisions.length === 0 ? (
            <p class="muted">The data repo has no commits yet.</p>
          ) : (
            <ol class="revisions">
              {shelf.revisions.map((revision) => (
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
        </>
      )}
    </section>
  );
}
