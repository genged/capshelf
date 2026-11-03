import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { UiAction, UiNotice } from "../shared/api-types";
import type { StateIconName } from "../shared/state-label";
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

/** The width under which the panes stack; frame.css uses the same. */
const NARROW = "(max-width: 800px)";

function focusQuiet(element: HTMLElement): void {
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus();
}

/**
 * On a phone, a selection hides the list and shows the detail, and going
 * back does the reverse. Focus would stay on a hidden element. This moves it
 * to the detail's title on the way in and back to the row that opened it on
 * the way out, or to the list's title when that row is gone.
 */
export function usePaneFocus(selection: string | null): void {
  const opener = useRef<HTMLElement | null>(null);
  // Starts empty, so a view that mounts with a selection, as a direct link
  // does, still moves focus into its detail.
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    if (before === selection) return;
    previous.current = selection;
    if (!window.matchMedia(NARROW).matches) return;
    // The row that opened the first detail is where focus returns. Moving
    // from one detail to another keeps that row.
    if (selection !== null && before === null) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    const frame = window.requestAnimationFrame(() => {
      const target =
        selection !== null
          ? document.querySelector<HTMLElement>(".frame .detail .detail-title")
          : opener.current?.isConnected
            ? opener.current
            : document.querySelector<HTMLElement>(".frame .list .list-title");
      if (target) focusQuiet(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selection]);
}

/**
 * `usePaneFocus` as an element, for views that know the selection only after
 * an early return, where a hook cannot be called. `selection` names the open
 * entry, or is null when the list shows.
 */
export function PaneFocus({ selection }: { selection: string | null }): null {
  usePaneFocus(selection);
  return null;
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
    ["↑ ↓", "Move between projects in the rail, or between items in the list"],
    ["c", "Copy the recommended command of the open item"],
    ["/", "Jump to a finding, project, item, or shelf item"],
    ["Ctrl Enter", "In Jump: copy the recommended command of a finding"],
    ["r", "Refresh every project"],
    ["Esc", "Close this help, Jump, or the diff dialog"],
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
