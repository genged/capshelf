import {
  isPlainConfigObject,
  stableSortConfig,
  type ConfigObject,
  type ConfigValue,
} from "./config-values";

const CLAUDE_SETTINGS_SCHEMA =
  "https://json.schemastore.org/claude-code-settings.json";

export function parseJsonConfigObject(raw: string, label: string): ConfigObject {
  const parsed = JSON.parse(raw) as ConfigValue;
  if (!isPlainConfigObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

export function stringifyJsonConfig(value: ConfigObject): string {
  return JSON.stringify(stableSortConfig(value), null, 2) + "\n";
}

export function normalizeClaudeSettingsOutput(value: ConfigObject): ConfigObject {
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
