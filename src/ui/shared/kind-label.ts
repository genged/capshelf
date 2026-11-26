/**
 * Order must match ITEM_KINDS in src/master.ts; a unit test enforces it because
 * the browser bundle cannot import that module.
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
