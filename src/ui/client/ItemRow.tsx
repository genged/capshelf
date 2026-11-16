import type { UiItem } from "../shared/api-types";
import { kindNoun } from "../shared/kind-label";
import { itemIcon } from "../shared/state-label";
import { Icon } from "./icons";

export function onListKeyDown(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const current = event.currentTarget;
  if (!(current instanceof HTMLElement)) return;
  const rows = Array.from(
    current.closest(".list")?.querySelectorAll<HTMLElement>(".list-row") ?? [],
  );
  const next =
    rows[rows.indexOf(current) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
}

export function ItemRow({
  item,
  selected,
  changed,
  showState,
  onSelect,
}: {
  item: UiItem;
  selected: boolean;
  changed: boolean;
  showState: boolean;
  onSelect: () => void;
}): preact.JSX.Element {
  const tone = item.attention ? "attention" : item.tone;
  return (
    <li>
      <button
        type="button"
        class={`list-row tone-${tone}${changed ? " is-changed" : ""}`}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onKeyDown={onListKeyDown}
        title={`${item.ref} · ${item.stateLabel}`}
      >
        <Icon
          name={itemIcon(item.row.state, item.attention)}
          label={item.stateLabel}
        />
        <span class="list-row-name">
          {item.name}
          <span class="list-row-kind">
            {item.source === "system" ? "system " : ""}
            {kindNoun(item.kind)}
            {item.scope === "local" ? ", local" : ""}
          </span>
        </span>
        <span class="list-row-state">{showState ? item.stateLabel : ""}</span>
      </button>
    </li>
  );
}
