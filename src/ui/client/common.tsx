import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { UiAction, UiNotice } from "../shared/api-types";
import type { StateIconName } from "../shared/state-label";
import type { KindChip } from "../shared/view-model";
import { copyText } from "./copy";
import { Icon } from "./icons";

export function CopyButton({
  text,
  label,
  compact,
}: {
  text: string;
  label: string;
  compact?: boolean;
}): preact.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async (): Promise<void> => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      type="button"
      class={`copy-button${compact ? " is-compact" : ""}${state !== "idle" ? ` is-${state}` : ""}`}
      onClick={onClick}
      aria-label={
        state === "idle" ? label : state === "copied" ? "Copied" : "Copy failed"
      }
      title={label}
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span class="copy-button-text">
        {state === "idle"
          ? compact
            ? ""
            : "Copy"
          : state === "copied"
            ? "Copied"
            : "Failed"}
      </span>
    </button>
  );
}

/**
 * A command wraps only at its spaces. An item name such as
 * `write-migration` must never break at its hyphen, because a reader
 * copies what they see and a broken name is a different command.
 */
export function CommandText({
  command,
}: {
  command: string;
}): preact.JSX.Element {
  return (
    <code class="command-text">
      {command.split(" ").map((token, index) => (
        <span key={`${index}-${token}`}>
          {index > 0 ? " " : null}
          <span class="command-token">{token}</span>
        </span>
      ))}
    </code>
  );
}

export function CommandRow({
  action,
}: {
  action: UiAction;
}): preact.JSX.Element {
  return (
    <li class="command-row">
      <div class="command-row-body">
        <CommandText command={action.command} />
        <p class="command-purpose">{action.purpose}</p>
      </div>
      <CopyButton
        text={action.command}
        label={`Copy ${action.command}`}
        compact
      />
    </li>
  );
}

export function Notice({ notice }: { notice: UiNotice }): preact.JSX.Element {
  return (
    <div
      class={`notice notice-${notice.level}`}
      role={notice.level === "warn" ? "alert" : "status"}
    >
      <Icon name={notice.level === "warn" ? "alert" : "bang"} />
      <div class="notice-body">
        <p>{notice.message}</p>
        {notice.actions && notice.actions.length > 0 ? (
          <ul class="command-list">
            {notice.actions.map((action) => (
              <CommandRow key={action.command} action={action} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function StateBadge({
  icon,
  tone,
  label,
}: {
  icon: StateIconName;
  tone: "ok" | "attention" | "kept" | "external";
  label: string;
}): preact.JSX.Element {
  return (
    <span class={`state-badge tone-${tone}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </span>
  );
}

/**
 * One toggle per kind a list holds. The active chip clears on a second click.
 * A chip with no row is disabled, so a click cannot lead to an empty list.
 * Fewer than two kinds render nothing, because there is nothing to choose.
 */
export function KindChips<Id extends string>({
  label,
  chips,
  selected,
  onSelect,
}: {
  label: string;
  chips: KindChip<Id>[];
  selected: Id | null;
  onSelect: (id: Id | null) => void;
}): preact.JSX.Element | null {
  if (chips.length < 2) return null;
  return (
    <fieldset class="kind-chips">
      <legend class="visually-hidden">{label}</legend>
      {chips.map((chip) => {
        const active = chip.id === selected;
        return (
          <button
            key={chip.id}
            type="button"
            class={`kind-chip${active ? " is-active" : ""}${chip.count === 0 ? " is-empty" : ""}`}
            aria-pressed={active}
            disabled={chip.count === 0 && !active}
            onClick={() => onSelect(active ? null : chip.id)}
          >
            <span>{chip.label}</span>
            <span class="kind-chip-count">{chip.count}</span>
            {active ? <Icon name="close" /> : null}
          </button>
        );
      })}
    </fieldset>
  );
}

export function Skeleton({
  lines,
  label,
}: {
  lines: number;
  label: string;
}): preact.JSX.Element {
  return (
    <div class="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} class="skeleton-line" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ComponentChildren;
}): preact.JSX.Element {
  return (
    <div class="empty-state">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDay(iso: string): string {
  if (iso.length >= 10) return iso.slice(0, 10);
  return iso;
}

export function useRelativeTime(date: Date | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (date === null) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export function KeyHelp({
  onClose,
}: {
  onClose: () => void;
}): preact.JSX.Element {
  const rows: Array<[string, string]> = [
    ["↑ ↓", "Move between projects in the tree, or between item panels"],
    ["Enter or Space", "Open or close the focused panel"],
    ["→ / ←", "Expand or collapse a project in the tree"],
    ["c", "Copy the first command of the focused panel"],
    ["/", "Focus the filter"],
    ["r", "Refresh every project"],
    ["Esc", "Close this help, the diff dialog, or the tree drawer"],
  ];
  return (
    <div class="key-help" role="dialog" aria-label="Keyboard shortcuts">
      <div class="key-help-head">
        <h2>Keyboard</h2>
        <button
          type="button"
          class="icon-button"
          onClick={onClose}
          aria-label="Close keyboard help"
        >
          <Icon name="close" />
        </button>
      </div>
      <dl>
        {rows.map(([keys, what]) => (
          <div key={keys} class="key-help-row">
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
