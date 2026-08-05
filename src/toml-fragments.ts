import {
  isPlainConfigObject,
  stableSortConfig,
  type ConfigObject,
  type ConfigValue,
} from "./config-values";
import {
  parse as parseToml,
  stringify as stringifyToml,
  TomlDate,
} from "smol-toml";

export function parseTomlConfigObject(
  raw: string,
  label: string,
): ConfigObject {
  const parsed = parseToml(raw) as unknown;
  if (!isPlainConfigObject(parsed)) {
    throw new Error(`${label} must contain a TOML table`);
  }
  return validateTomlRoundTrippable(parsed, label);
}

export function stringifyTomlConfig(value: ConfigObject): string {
  const sorted = stableSortConfig(value);
  if (!isPlainConfigObject(sorted)) {
    throw new Error("TOML output must be a table");
  }
  const text = stringifyToml(sorted);
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function tomlTextHasComments(raw: string): boolean {
  let state:
    | "normal"
    | "basic"
    | "literal"
    | "multiline-basic"
    | "multiline-literal" = "normal";

  for (let index = 0; index < raw.length; index += 1) {
    const rest = raw.slice(index);
    const character = raw[index]!;
    if (state === "normal") {
      if (character === "#") return true;
      if (rest.startsWith('"""')) {
        state = "multiline-basic";
        index += 2;
      } else if (rest.startsWith("'''")) {
        state = "multiline-literal";
        index += 2;
      } else if (character === '"') {
        state = "basic";
      } else if (character === "'") {
        state = "literal";
      }
      continue;
    }

    if (state === "basic") {
      if (character === "\\") index += 1;
      else if (character === '"') state = "normal";
      continue;
    }
    if (state === "literal") {
      if (character === "'") state = "normal";
      continue;
    }

    const quote = state === "multiline-basic" ? '"' : "'";
    if (state === "multiline-basic" && character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) {
      let runLength = 1;
      while (raw[index + runLength] === quote) runLength += 1;
      if (runLength >= 3) state = "normal";
      index += runLength - 1;
    }
  }
  return false;
}

export function validateCodexMcpFragment(
  value: ConfigObject,
  label: string,
): ConfigObject {
  const fragment = validateTomlRoundTrippable(value, label);
  const servers = fragment.mcp_servers;
  if (servers !== undefined) {
    if (!isPlainConfigObject(servers)) {
      throw new Error(`${label}.mcp_servers must be a TOML table`);
    }
    for (const [name, server] of Object.entries(servers)) {
      if (!isPlainConfigObject(server)) {
        throw new Error(`${label}.mcp_servers.${name} must be a TOML table`);
      }
    }
  }
  return fragment;
}

export function validateCodexConfigFragment(
  value: ConfigObject,
  label: string,
): ConfigObject {
  return validateTomlRoundTrippable(value, label);
}

function validateTomlRoundTrippable(
  value: ConfigValue,
  label: string,
): ConfigObject {
  validateTomlValue(value, label);
  if (!isPlainConfigObject(value)) {
    throw new Error(`${label} must contain a TOML table`);
  }
  return value;
}

function validateTomlValue(value: ConfigValue, label: string): void {
  if (value === null) {
    throw new Error(`${label} contains null, which is not valid TOML`);
  }
  // TOML date/time values are rejected rather than supported: the shared
  // ConfigValue pipeline hashes and merges via JSON, where a date collapses
  // into its ISO string (silently changing the TOML type on re-emit), and
  // structuredClone strips the TomlDate subclass that smol-toml needs to
  // distinguish local dates/times from offset date-times. Until the value
  // model carries dates first-class, rejecting is the only round-trip-safe
  // behavior.
  if (value instanceof TomlDate) {
    throw new Error(
      `${label} contains a TOML date, which capshelf does not support in TOML fragments`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(
      `${label} contains a non-finite number, which capshelf does not support in TOML fragments`,
    );
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateTomlValue(entry, `${label}[${index}]`);
    }
    return;
  }
  if (isPlainConfigObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      validateTomlValue(entry, `${label}.${key}`);
    }
    return;
  }
  if (
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    throw new Error(`${label} contains unsupported TOML value ${typeof value}`);
  }
}
