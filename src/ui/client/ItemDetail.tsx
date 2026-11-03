import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { capshelfCommand } from "../../command-text";
import type {
  DiffViewName,
  UiAction,
  UiDiffResponse,
  UiItem,
} from "../shared/api-types";
import { kindLabel } from "../shared/kind-label";
import { itemIcon } from "../shared/state-label";
import { shortCommit, shortDigest, stateSentence } from "../shared/view-model";
import { CommandText, CopyButton } from "./common";
import { copyText } from "./copy";
import { DiffView } from "./DiffView";
import { Icon, type IconName } from "./icons";

/**
 * The sticky bar at the top of the detail pane. Today its primary button
 * copies the recommended command. A later release puts the run action in
 * the same place, so the pane does not change shape when the UI can write.
 */
export function ActionBar({
  icon,
  tone,
  name,
  where,
  primary,
}: {
  icon: IconName;
  tone: string;
  name: string;
  where: string;
  primary: UiAction | null;
}): preact.JSX.Element {
  return (
    <div class="action-bar">
      <span class={`action-bar-who tone-${tone}`}>
        <Icon name={icon} />
        <b>{name}</b>
        <span>in {where}</span>
      </span>
      <span class="action-bar-note">
        {primary ? "Read-only. Run it in a terminal." : ""}
      </span>
      {primary ? <PrimaryCopy action={primary} /> : null}
    </div>
  );
}

/**
 * The pane's one primary button. The `c` key does the same while no field
 * has focus and no dialog is open.
 */
function PrimaryCopy({ action }: { action: UiAction }): preact.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  const copy = async (): Promise<void> => {
    const ok = await copyText(action.command);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  // The reset timer outlives renders. Only an unmount clears it, or the
  // render that "Copied" causes would cancel its own reset.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if (document.body.classList.contains("has-dialog")) return;
      event.preventDefault();
      void copy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <button
      type="button"
      class={`button is-primary${state === "copied" ? " is-copied" : ""}`}
      onClick={() => void copy()}
      title={`${action.command} (c)`}
      aria-keyshortcuts="c"
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span role="status">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed"
            : "Copy recommended command"}
      </span>
    </button>
  );
}

/** Crumbs, title, and the state sentence that every detail starts with. */
export function DetailHead({
  crumbs,
  title,
  backLabel,
  onBack,
  children,
}: {
  crumbs: ComponentChildren;
  title: string;
  backLabel: string;
  onBack: () => void;
  children?: ComponentChildren;
}): preact.JSX.Element {
  return (
    <header>
      <button type="button" class="link-button back-link" onClick={onBack}>
        <Icon name="chevron" />
        {backLabel}
      </button>
      <p class="detail-crumbs">{crumbs}</p>
      <h2 class="detail-title">{title}</h2>
      {children}
    </header>
  );
}

export function ItemDetail({
  item,
  projectName,
  dataOverride,
  loadDiff,
  onBack,
}: {
  item: UiItem;
  projectName: string;
  /** The session's --data override, repeated on every printed command. */
  dataOverride: string | undefined;
  loadDiff: (view: DiffViewName) => Promise<UiDiffResponse>;
  onBack: () => void;
}): preact.JSX.Element {
  const updateCommand = capshelfCommand(dataOverride, [
    "update",
    item.ref,
    ...(item.scope === "local" ? ["--local"] : []),
  ]);
  const tone = item.attention ? "attention" : item.tone;
  const icon = itemIcon(item.row.state, item.attention);
  const [recommended, ...others] = item.actions;
  return (
    <article class="detail" aria-label={item.ref}>
      <ActionBar
        icon={icon}
        tone={tone}
        name={item.name}
        where={projectName}
        primary={item.attention ? (recommended ?? null) : null}
      />
      <div class="detail-body">
        <DetailHead
          crumbs={
            <>
              {projectName} / {kindLabel(item.kind)}
              {item.scope === "local" ? " · local" : ""}
              {item.source === "system" ? " · system" : ""}
              {item.source === "remote" ? " · remote" : ""}
            </>
          }
          title={item.name}
          backLabel={projectName}
          onBack={onBack}
        >
          <p class={`detail-state tone-${tone}`}>
            <Icon name={icon} />
            <span>
              <b>{item.stateLabel}.</b>{" "}
              <span class="muted">
                {stateSentence(item.stateLabel, item.stateDetail)}
              </span>
            </span>
          </p>
        </DetailHead>

        {item.attention && recommended ? (
          <section class="detail-section" aria-label="Recommended">
            <h3 class="section-label">Recommended</h3>
            <div class="recommended">
              <CommandText command={recommended.command} />
              <CopyButton
                text={recommended.command}
                label={`Copy ${recommended.command}`}
              />
            </div>
            <p class="section-note">{recommended.purpose}</p>
          </section>
        ) : null}

        {(item.attention ? others : item.actions).length > 0 ? (
          <section class="detail-section" aria-label="Other commands">
            <h3 class="section-label">
              {item.attention ? "Other ways to resolve" : "Commands"}
            </h3>
            <ul class="alts">
              {(item.attention ? others : item.actions).map((action) => (
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
        ) : null}

        {item.diffViews.length > 0 ? (
          <section class="detail-section" aria-label="What changed">
            <h3 class="section-label">What changed</h3>
            <DiffView key={item.id} item={item} loadDiff={loadDiff} />
          </section>
        ) : null}

        {item.attention ? (
          <details class="disclosure">
            <summary>
              <Icon name="chevron" />
              Pin, installed copy, and shelf
            </summary>
            <div class="card">
              <Facts item={item} updateCommand={updateCommand} />
            </div>
          </details>
        ) : (
          <section class="detail-section" aria-label="Facts">
            <div class="card">
              <Facts item={item} updateCommand={updateCommand} />
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

function Facts({
  item,
  updateCommand,
}: {
  item: UiItem;
  updateCommand: string;
}): preact.JSX.Element {
  const { row } = item;
  const needs = row.lockedNeeds;
  const needsText =
    needs === null
      ? "snapshot unknown"
      : needs === undefined
        ? null
        : [
            needs.network.length > 0
              ? `network ${needs.network.join(", ")}`
              : null,
            needs.env.length > 0 ? `env ${needs.env.join(", ")}` : null,
            needs.bin.length > 0 ? `bin ${needs.bin.join(", ")}` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ") || "none";
  return (
    <dl class="props">
      {item.installedPath ? (
        <>
          <dt>Installed at</dt>
          <dd class="mono">{item.installedPath}</dd>
        </>
      ) : null}
      <dt>Pin</dt>
      <dd>
        <span class="mono">{shortDigest(row.lockedSha)}</span>
        {row.sourceCommit ? (
          <span class="muted">
            {" "}
            · commit <span class="mono">{shortCommit(row.sourceCommit)}</span>
          </span>
        ) : null}
        {row.cliVersion ? (
          <span class="muted"> · capshelf {row.cliVersion}</span>
        ) : null}
        {row.label ? <span class="muted"> · {row.label}</span> : null}
      </dd>
      <dt>Installed</dt>
      <dd>
        <span class="mono">
          {row.currentSha === null ? "missing" : shortDigest(row.currentSha)}
        </span>
        {row.modeDrifted ? (
          <span class="tone-attention"> · executable bit differs</span>
        ) : null}
      </dd>
      <dt>{item.source === "remote" ? "Upstream" : "Shelf"}</dt>
      <dd>
        <span class="mono">
          {row.upstreamSha === null
            ? item.source === "system"
              ? "not bundled"
              : "gone"
            : shortDigest(row.upstreamSha)}
        </span>
        {row.remote ? (
          <span class="muted">
            {" "}
            · <span class="mono">{row.remote.upstream}</span> {row.remote.ref}
          </span>
        ) : null}
        {row.upstreamDirty ? (
          <span class="tone-attention">
            {" "}
            · uncommitted changes in the data repo
          </span>
        ) : null}
      </dd>
      {row.local ? (
        <>
          <dt>Kept local</dt>
          <dd>{row.localReason ?? "no reason recorded"}</dd>
        </>
      ) : null}
      {needsText !== null ? (
        <>
          <dt>Needs</dt>
          <dd>
            {needsText}
            {row.needsState === "update_available"
              ? " · the shelf declares different requirements"
              : row.needsState === "unavailable"
                ? " · freshness unavailable"
                : ""}
          </dd>
        </>
      ) : null}
      {row.targetCoverage && row.targetCoverage.length > 0 ? (
        <>
          <dt>Targets</dt>
          <dd>
            {row.coverageState === "unknown" ? (
              `unknown (${row.coverageReason ?? "not readable"})`
            ) : (
              <ul class="fact-list">
                {row.targetCoverage.map((target) => (
                  <li key={target.target}>
                    {target.target === "claude" ? "Claude" : "Codex"}{" "}
                    {target.present === true
                      ? "present"
                      : target.present === false
                        ? "absent"
                        : "unknown"}
                    <span class="muted mono"> · {target.sourcePath}</span>
                    {target.present === false ? (
                      <span class="muted">
                        {" "}
                        · once it is committed there:{" "}
                        <span class="mono">{updateCommand}</span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </>
      ) : null}
      {row.targets && row.targets.length > 0 ? (
        <>
          <dt>Outputs</dt>
          <dd>
            <ul class="fact-list">
              {row.targets.map((target) => (
                <li key={target.target}>
                  {target.target} {target.state}
                  <span class="muted mono"> · {target.outputPath}</span>
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {row.installDifferences && row.installDifferences.length > 0 ? (
        <>
          <dt>Differences</dt>
          <dd>
            <ul class="fact-list">
              {row.installDifferences.map((difference) => (
                <li key={difference.path}>
                  <span class="mono">{difference.path}</span>
                  <span class="muted"> · {difference.kind}</span>
                  {difference.modeChanged ? (
                    <span class="muted"> · executable bit differs</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {row.filteredPaths && row.filteredPaths.length > 0 ? (
        <>
          <dt>Filtered</dt>
          <dd>
            <ul class="fact-list">
              {row.filteredPaths.map((filtered) => (
                <li key={filtered.path}>
                  <span class="mono">{filtered.path}</span>
                  <span class="muted"> · {filtered.filter}</span>
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {row.runtimeWarnings && row.runtimeWarnings.length > 0 ? (
        <>
          <dt>Warnings</dt>
          <dd>
            <ul class="fact-list">
              {row.runtimeWarnings.map((warning) => (
                <li key={`${warning.type}:${warning.path}`}>
                  <Icon name="alert" label="Warning" /> {warning.message}
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </dl>
  );
}
