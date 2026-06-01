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
  if (value instanceof TomlDate) {
    throw new Error(
      `${label} contains a TOML date, which capshelf does not round-trip in M5`,
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
