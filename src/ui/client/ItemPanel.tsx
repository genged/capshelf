import { useEffect, useRef, useState } from "preact/hooks";
import type { DiffViewName, UiDiffResponse, UiItem } from "../shared/api-types";
import { itemIcon } from "../shared/state-label";
import { shortCommit, shortDigest, shortenDigests } from "../shared/view-model";
import { CommandRow, StateBadge } from "./common";
import { copyText } from "./copy";
import { DiffView } from "./DiffView";
import { Icon } from "./icons";

export function ItemPanel({
  item,
  expanded,
  changed,
  onToggle,
  loadDiff,
  domId,
}: {
  item: UiItem;
  expanded: boolean;
  changed: boolean;
  onToggle: () => void;
  loadDiff: (view: DiffViewName) => Promise<UiDiffResponse>;
  domId: string;
}): preact.JSX.Element {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed" | "none">(
    "idle",
  );
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const { row } = item;
  const showShelf =
    row.upstreamSha !== null &&
    row.upstreamSha !== row.lockedSha &&
    (row.state === "update_available" || row.state === "drifted_and_update");
  const bodyId = `${domId}-body`;

  const onKeyDown = async (event: KeyboardEvent): Promise<void> => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const current = event.currentTarget as HTMLElement;
      const toggles = Array.from(
        current
          .closest(".panels")
          ?.querySelectorAll<HTMLElement>(".panel-toggle") ?? [],
      );
      const index = toggles.indexOf(current);
      if (index === -1) return;
      event.preventDefault();
      toggles[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      return;
    }
    if (event.key !== "c") return;
    event.preventDefault();
    const first = item.actions[0];
    const result = first ? await copyText(first.command) : null;
    setCopied(result === null ? "none" : result ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied("idle"), 1600);
  };

  return (
    <section
      id={domId}
      class={`panel tone-${item.attention ? "attention" : item.tone}${expanded ? " is-open" : ""}${changed ? " is-changed" : ""}`}
    >
      <h3 class="panel-head">
        <button
          type="button"
          class="panel-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(event) => void onKeyDown(event)}
        >
          <Icon name="chevron" />
          <span class="panel-ref">
            <span class="panel-ref-kind">{item.kind}/</span>
            {item.name}
          </span>
          {item.scope === "local" ? (
            <span class="chip chip-scope">local</span>
          ) : null}
          {item.source === "system" ? (
            <span class="chip chip-system">system</span>
          ) : null}
          <span class="panel-pins mono">
            <span class="muted">pinned </span>
            {shortDigest(row.lockedSha)}
            {showShelf ? (
              <>
                <span class="muted"> → shelf </span>
                {shortDigest(row.upstreamSha)}
              </>
            ) : null}
          </span>
          <StateBadge
            icon={itemIcon(row.state, item.attention)}
            tone={item.attention ? "attention" : item.tone}
            label={item.stateLabel}
          />
          {copied !== "idle" ? (
            <span class="panel-copied" role="status">
              {copied === "copied"
                ? "Copied the first command"
                : copied === "failed"
                  ? "Copy failed"
                  : "No command for this item"}
            </span>
          ) : null}
        </button>
      </h3>
      {expanded ? (
        <div id={bodyId} class="panel-body">
          {item.actions.length > 0 ? (
            <section class="panel-resolve" aria-labelledby={`${domId}-resolve`}>
              <h4 id={`${domId}-resolve`} class="panel-resolve-title">
                {item.attention ? "Resolve" : "Commands"}
              </h4>
              <ul class="command-list">
                {item.actions.map((action) => (
                  <CommandRow key={action.command} action={action} />
                ))}
              </ul>
            </section>
          ) : null}
          <Facts item={item} />
          {item.diffViews.length > 0 ? (
            <DiffView item={item} loadDiff={loadDiff} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Facts({ item }: { item: UiItem }): preact.JSX.Element {
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
    <dl class="facts">
      <div class="fact">
        <dt>State</dt>
        <dd>{shortenDigests(item.stateDetail)}</dd>
      </div>
      <div class="fact">
        <dt>Pin</dt>
        <dd class="mono">
          {shortDigest(row.lockedSha)}
          {row.sourceCommit ? ` · commit ${shortCommit(row.sourceCommit)}` : ""}
          {row.cliVersion ? ` · capshelf ${row.cliVersion}` : ""}
          {row.label ? ` · ${row.label}` : ""}
        </dd>
      </div>
      <div class="fact">
        <dt>Installed</dt>
        <dd class="mono">
          {row.currentSha === null ? "missing" : shortDigest(row.currentSha)}
          {item.installedPath ? ` · ${item.installedPath}` : ""}
          {row.modeDrifted ? " · executable bit differs" : ""}
        </dd>
      </div>
      <div class="fact">
        <dt>Shelf</dt>
        <dd class="mono">
          {row.upstreamSha === null
            ? item.source === "system"
              ? "not bundled"
              : "gone"
            : shortDigest(row.upstreamSha)}
          {row.upstreamDirty ? " · uncommitted changes in the data repo" : ""}
        </dd>
      </div>
      {row.local ? (
        <div class="fact">
          <dt>Kept local</dt>
          <dd>{row.localReason ?? "no reason recorded"}</dd>
        </div>
      ) : null}
      {needsText !== null ? (
        <div class="fact">
          <dt>Needs</dt>
          <dd>
            {needsText}
            {row.needsState === "update_available"
              ? " · the shelf declares different requirements"
              : row.needsState === "unavailable"
                ? " · freshness unavailable"
                : ""}
          </dd>
        </div>
      ) : null}
      {row.targetCoverage && row.targetCoverage.length > 0 ? (
        <div class="fact">
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
                        · once it is committed there: capshelf update {item.ref}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ) : null}
      {row.targets && row.targets.length > 0 ? (
        <div class="fact">
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
        </div>
      ) : null}
      {row.installDifferences && row.installDifferences.length > 0 ? (
        <div class="fact">
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
        </div>
      ) : null}
      {row.filteredPaths && row.filteredPaths.length > 0 ? (
        <div class="fact">
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
        </div>
      ) : null}
      {row.runtimeWarnings && row.runtimeWarnings.length > 0 ? (
        <div class="fact">
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
        </div>
      ) : null}
    </dl>
  );
}
