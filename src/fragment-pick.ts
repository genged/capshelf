import {
  cloneConfig,
  configPathLabel,
  isPlainConfigObject,
  mergeConfigValues,
  removeManagedValue,
  type ConfigObject,
  type ConfigValue,
} from "./config-values";
import { PreconditionError } from "./errors";
import type { FragmentSource, FragmentValue } from "./fragments";

/**
 * Resolve a --pick argument to output config path segments. Paths split on
 * dots (`permissions.allow`). For mcp fragments a pick that does not start
 * with the server container key is sugar for a server name, so
 * `--pick github` means `mcpServers.github` (claude) or
 * `mcp_servers.github` (codex).
 */
export function pickPathSegments(
  source: FragmentSource,
  pick: string,
): string[] {
  const segments = pick.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new PreconditionError(`invalid --pick path "${pick}"`);
  }
  if (source.kind === "mcp") {
    const container =
      source.sourceTarget === "codex" ? "mcp_servers" : "mcpServers";
    if (segments[0] !== container) return [container, ...segments];
  }
  return segments;
}

/**
 * Extract the picked paths from the generated output's unmanaged remainder
 * (current output minus every locked fragment's contribution). Decomposing
 * *managed* values back into a fragment is ambiguous, but unmanaged values
 * have exactly one owner — the project — so extracting them into a new
 * fragment is deterministic and leaves the output semantically unchanged.
 */
export function extractPickedFragment(opts: {
  source: FragmentSource;
  picks: string[];
  current: ConfigObject;
  managed: ConfigObject;
  managedFragments: FragmentValue[];
  outputLabel: string;
}): ConfigObject {
  const baseValue = removeManagedValue(opts.current, opts.managed) ?? {};
  const base = isPlainConfigObject(baseValue) ? baseValue : {};
  let extracted: ConfigObject = {};
  for (const pick of opts.picks) {
    const segments = pickPathSegments(opts.source, pick);
    const value = valueAtPath(base, segments);
    if (value === undefined) {
      throw pickNotFoundError(opts, segments);
    }
    extracted = mergeConfigValues(
      extracted,
      nestAtPath(segments, value),
    ) as ConfigObject;
  }
  return extracted;
}

function pickNotFoundError(
  opts: {
    managedFragments: FragmentValue[];
    outputLabel: string;
  },
  segments: string[],
): PreconditionError {
  const label = configPathLabel(segments);
  const owners = opts.managedFragments
    .filter((fragment) => valueAtPath(fragment.value, segments) !== undefined)
    .map((fragment) => `${fragment.source.kind}/${fragment.source.name}`);
  if (owners.length > 0) {
    return new PreconditionError(
      `${opts.outputLabel} value at ${label} is already managed by ${owners.join(", ")}; edit that fragment's source and promote instead`,
    );
  }
  return new PreconditionError(
    `${opts.outputLabel} has no unmanaged value at ${label}`,
  );
}

function valueAtPath(
  value: ConfigValue | undefined,
  segments: string[],
): ConfigValue | undefined {
  let current = value;
  for (const segment of segments) {
    if (!isPlainConfigObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function nestAtPath(segments: string[], value: ConfigValue): ConfigObject {
  let out: ConfigValue = cloneConfig(value);
  for (let index = segments.length - 1; index >= 0; index--) {
    out = { [segments[index] as string]: out };
  }
  return out as ConfigObject;
}
