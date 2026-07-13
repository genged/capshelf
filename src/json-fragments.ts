import {
  isPlainConfigObject,
  stableSortConfig,
  type ConfigObject,
  type ConfigValue,
} from "./config-values";

const CLAUDE_SETTINGS_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

export function parseJsonConfigObject(
  raw: string,
  label: string,
): ConfigObject {
  // An empty file is equivalent to a missing one, matching TOML where empty
  // input parses to an empty table.
  if (raw.trim() === "") return {};
  let parsed: ConfigValue;
  try {
    parsed = parseJsonc(raw) as ConfigValue;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${reason}`);
  }
  if (!isPlainConfigObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

/**
 * Parse JSONC (JSON with // and block comments and trailing commas) into an
 * unknown value. Claude Code's settings.json / .mcp.json are JSONC, so tolerate
 * them on read everywhere capshelf inspects those files — otherwise a
 * legitimately-commented file the target tool accepts makes capshelf throw.
 */
export function parseJsonc(raw: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
}

/** True if the JSONC text contains // or block comments (outside strings). */
export function jsonTextHasComments(raw: string): boolean {
  return stripJsonComments(raw) !== raw;
}

/**
 * Remove // line and block comments, leaving string literals untouched. A
 * string-aware scan (not a regex) so comment tokens inside string values are
 * preserved. Whitespace/newlines are otherwise left in place.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const s = text[i];
        if (s === "\\") {
          out += s;
          i++;
          if (i < n) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += s;
        i++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop commas immediately before a closing } or ], string-aware. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const s = text[i];
        if (s === "\\") {
          out += s;
          i++;
          if (i < n) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += s;
        i++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (j < n && (text[j] === "}" || text[j] === "]")) {
        i++; // drop the trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export function stringifyJsonConfig(value: ConfigObject): string {
  return `${JSON.stringify(stableSortConfig(value), null, 2)}\n`;
}

export function normalizeClaudeSettingsOutput(
  value: ConfigObject,
): ConfigObject {
  const nonSchemaKeys = Object.keys(value).filter((key) => key !== "$schema");
  if (nonSchemaKeys.length === 0) return {};
  if ("$schema" in value) return value;
  return { $schema: CLAUDE_SETTINGS_SCHEMA, ...value };
}

export function isSyntheticOnlyClaudeSettings(value: ConfigObject): boolean {
  return Object.keys(value).every((key) => key === "$schema");
}

export function validateClaudeSettingsFragment(
  value: ConfigObject,
  _label: string,
): ConfigObject {
  return value;
}

export function validateClaudeMcpFragment(
  value: ConfigObject,
  label: string,
): ConfigObject {
  const servers = value.mcpServers;
  if (servers !== undefined) {
    if (!isPlainConfigObject(servers)) {
      throw new Error(`${label}.mcpServers must be a JSON object`);
    }
    for (const [name, server] of Object.entries(servers)) {
      if (!isPlainConfigObject(server)) {
        throw new Error(`${label}.mcpServers.${name} must be a JSON object`);
      }
    }
  }
  return value;
}
