import {
  cloneConfig,
  configPathLabel,
  isPlainConfigObject,
  mergeConfigObject,
  removeManagedValue,
  type ConfigObject,
  type ConfigValue,
} from "./config-values";
import { PreconditionError } from "./errors";
import type {
  FragmentSource,
  FragmentSourceTarget,
  FragmentValue,
} from "./fragments";

export function pickPathSegments(
  source: FragmentSource,
  pick: string,
): string[] {
  const segments = pick.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new PreconditionError(`invalid --pick path "${pick}"`);
  }
  if (source.kind === "mcp") {
    const container = mcpServerContainerKey(source.sourceTarget);
    if (segments[0] !== container) return [container, ...segments];
  }
  return segments;
}

export function mcpServerContainerKey(
  sourceTarget: FragmentSourceTarget | undefined,
): string {
  return sourceTarget === "codex" ? "mcp_servers" : "mcpServers";
}

export function unmanagedRemainder(
  current: ConfigObject,
  managed: ConfigObject,
): ConfigObject {
  const baseValue = removeManagedValue(current, managed) ?? {};
  return isPlainConfigObject(baseValue) ? baseValue : {};
}

/**
 * Only unmanaged values are extracted because they have a single owner, the
 * project, so extraction is deterministic; decomposing managed values is
 * ambiguous.
 */
export function extractPickedFragment(opts: {
  source: FragmentSource;
  picks: string[];
  current: ConfigObject;
  managed: ConfigObject;
  managedFragments: FragmentValue[];
  outputLabel: string;
}): ConfigObject {
  const base = unmanagedRemainder(opts.current, opts.managed);
  let extracted: ConfigObject = {};
  for (const pick of opts.picks) {
    const segments = pickPathSegments(opts.source, pick);
    const value = valueAtPath(base, segments);
    if (value === undefined) {
      throw pickNotFoundError(opts, segments);
    }
    extracted = mergeConfigObject(extracted, nestAtPath(segments, value));
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
  const leaf = segments.at(-1);
  if (leaf === undefined) {
    throw new Error("a pick path needs at least one segment");
  }
  let out: ConfigObject = { [leaf]: cloneConfig(value) };
  for (const segment of segments.slice(0, -1).reverse()) {
    out = { [segment]: out };
  }
  return out;
}
