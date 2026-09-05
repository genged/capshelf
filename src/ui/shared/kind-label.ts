/**
 * Display names and the display order of the item kinds, for the web UI's
 * group headings. The order is the order `ITEM_KINDS` declares in
 * `src/master.ts`, which `ls` prints. A unit test holds the two lists equal,
 * because this file cannot import that module into the browser bundle.
 */
import type { ItemKind } from "../../master";

export const KIND_ORDER: readonly ItemKind[] = [
  "skills",
  "pi-extensions",
  "subagents",
  "settings",
  "mcp",
  "codex-config",
];

export function isKind(value: string): value is ItemKind {
  return (KIND_ORDER as readonly string[]).includes(value);
}

export function kindLabel(kind: ItemKind): string {
  switch (kind) {
    case "skills":
      return "Skills";
    case "pi-extensions":
      return "Pi extensions";
    case "subagents":
      return "Subagents";
    case "settings":
      return "Settings";
    case "mcp":
      return "MCP servers";
    case "codex-config":
      return "Codex config";
  }
}
