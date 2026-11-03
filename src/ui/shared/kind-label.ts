/**
 * Display names and the display order of the item kinds, for the web UI's
 * group headings. The order is the order `ITEM_KINDS` declares in
 * `src/master.ts`, which `ls` prints. A unit test holds the two lists equal,
 * because this file cannot import that module into the browser bundle.
 */
import type { ItemKind } from "../../master";

export const KIND_ORDER: readonly ItemKind[] = [
  "skills",
  "plugins",
  "pi-extensions",
  "subagents",
  "settings",
  "mcp",
  "codex-config",
];

export function isKind(value: string): value is ItemKind {
  return KIND_ORDER.some((kind) => kind === value);
}

export function kindLabel(kind: ItemKind): string {
  switch (kind) {
    case "skills":
      return "Skills";
    case "plugins":
      return "Plugins";
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

/** The word for one item of a kind, set quietly beside its name in a list. */
export function kindNoun(kind: ItemKind): string {
  switch (kind) {
    case "skills":
      return "skill";
    case "plugins":
      return "plugin";
    case "pi-extensions":
      return "Pi extension";
    case "subagents":
      return "subagent";
    case "settings":
      return "settings";
    case "mcp":
      return "MCP server";
    case "codex-config":
      return "Codex config";
  }
}
