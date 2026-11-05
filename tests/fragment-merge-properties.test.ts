import { describe, expect, test } from "bun:test";
import {
  defineConfigProperty,
  isConfigObject,
  mergeConfigObjects,
  stableStringifyConfig,
  type ConfigObject,
  type ConfigValue,
} from "../src/config-values";
import { reconcileFragmentValues, type FragmentValue } from "../src/fragments";

// Property tests for the value rules of fragment reconciliation. Each property
// runs on many generated outputs and fragment sets. The expected results come
// from `facts`, a model that is independent of the merge code: an output is the
// list of its leaf facts, and a fact is a path with one scalar or one array
// element. Empty objects and arrays hold no facts, because removal prunes them.

/** Deterministic choices, so a failure names a reproducible case. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// A small alphabet, so generated values overlap often. `__proto__` checks
// that special keys stay own data properties.
const KEYS = ["a", "b", "c", "__proto__"];
const SCALARS: ConfigValue[] = [1, 2, "m", "l", true, null];

function choose<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function genElement(next: () => number): ConfigValue {
  return next() < 0.8 ? choose(next, SCALARS) : { a: choose(next, SCALARS) };
}

function genValue(next: () => number, depth: number): ConfigValue {
  const roll = next();
  if (roll < 0.4 || depth === 0) return choose(next, SCALARS);
  if (roll < 0.7) {
    return Array.from({ length: Math.floor(next() * 4) }, () =>
      genElement(next),
    );
  }
  return genObject(next, depth - 1);
}

function genObject(next: () => number, depth: number): ConfigObject {
  const out: ConfigObject = {};
  const count = Math.floor(next() * 4);
  for (let i = 0; i < count; i++) {
    defineConfigProperty(out, choose(next, KEYS), genValue(next, depth));
  }
  return out;
}

function genFragments(next: () => number): FragmentValue[] {
  return Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => ({
    source: {
      kind: "settings",
      name: `f${index}`,
      target: "claude-settings",
      format: "json",
      relPath: `settings/f${index}/settings.json`,
    },
    value: genObject(next, 2),
  }));
}

function facts(value: ConfigValue, path: string[] = []): string[] {
  const at = JSON.stringify(path);
  if (Array.isArray(value)) {
    return value.map(
      (element) => `${at} has ${stableStringifyConfig(element)}`,
    );
  }
  if (isConfigObject(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      facts(child, [...path, key]),
    );
  }
  return [`${at} = ${stableStringifyConfig(value)}`];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function uniqueSorted(values: string[]): string[] {
  return sorted([...new Set(values)]);
}

/** The output with every array sorted, so array order does not count. */
function orderFree(value: ConfigValue): string {
  const canonical = (v: ConfigValue): ConfigValue => {
    if (Array.isArray(v)) {
      return v
        .map(canonical)
        .sort((x, y) =>
          stableStringifyConfig(x).localeCompare(stableStringifyConfig(y)),
        );
    }
    if (isConfigObject(v)) {
      const out: ConfigObject = {};
      for (const [key, child] of Object.entries(v))
        defineConfigProperty(out, key, canonical(child));
      return out;
    }
    return v;
  };
  return stableStringifyConfig(canonical(value));
}

function reconcile(
  current: ConfigObject,
  oldManaged: ConfigObject,
  nextFragments: FragmentValue[],
): ConfigObject | null {
  try {
    return reconcileFragmentValues({
      outputPath: ".claude/settings.json",
      current,
      oldManaged,
      nextFragments,
      isSyntheticOnly: () => false,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("cannot reconcile"))
      return null;
    throw error;
  }
}

function managedOf(fragments: FragmentValue[]): ConfigObject {
  return mergeConfigObjects(fragments.map((fragment) => fragment.value));
}

const ROUNDS = 3000;

/** Fail when too few cases got past the conflict checks to prove anything. */
function expectEnoughCases(accepted: number): void {
  expect(accepted).toBeGreaterThan(ROUNDS / 4);
}

describe("fragment reconciliation properties", () => {
  test("a second apply with an unchanged lock writes nothing", () => {
    const next = random(101);
    let accepted = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const current = genObject(next, 3);
      const oldManaged = genObject(next, 2);
      const fragments = genFragments(next);
      const first = reconcile(current, oldManaged, fragments);
      if (first === null) continue;
      accepted++;
      const second = reconcile(first, managedOf(fragments), fragments);
      expect({
        round,
        output: second && stableStringifyConfig(second),
      }).toEqual({ round, output: stableStringifyConfig(first) });
    }
    expectEnoughCases(accepted);
  });

  test("apply keeps every local fact and adds every managed fact, and nothing else", () => {
    const next = random(202);
    let accepted = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const local = genObject(next, 3);
      const fragments = genFragments(next);
      const output = reconcile(local, {}, fragments);
      if (output === null) continue;
      accepted++;
      expect({ round, facts: uniqueSorted(facts(output)) }).toEqual({
        round,
        facts: uniqueSorted([...facts(local), ...facts(managedOf(fragments))]),
      });
    }
    expectEnoughCases(accepted);
  });

  test("rm after add keeps exactly the local facts that no fragment also set", () => {
    const next = random(303);
    let accepted = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const local = genObject(next, 3);
      const fragments = genFragments(next);
      const added = reconcile(local, {}, fragments);
      if (added === null) continue;
      accepted++;
      const removed = reconcile(added, managedOf(fragments), []);
      const managedFacts = new Set(facts(managedOf(fragments)));
      // Duplicates count: an rm must not collapse local repeated elements.
      expect({ round, facts: removed && sorted(facts(removed)) }).toEqual({
        round,
        facts: sorted(facts(local).filter((fact) => !managedFacts.has(fact))),
      });
    }
    expectEnoughCases(accepted);
  });

  test("fragment order changes array order only", () => {
    const next = random(404);
    let accepted = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const current = genObject(next, 3);
      const oldManaged = genObject(next, 2);
      const fragments = genFragments(next);
      const forward = reconcile(current, oldManaged, fragments);
      const reversed = reconcile(current, oldManaged, [...fragments].reverse());
      expect({ round, refused: reversed === null }).toEqual({
        round,
        refused: forward === null,
      });
      if (forward === null || reversed === null) continue;
      accepted++;
      expect({ round, output: orderFree(reversed) }).toEqual({
        round,
        output: orderFree(forward),
      });
    }
    expectEnoughCases(accepted);
  });

  test("the documented cases", () => {
    const fragment = (value: ConfigObject): FragmentValue[] => [
      {
        source: {
          kind: "settings",
          name: "f",
          target: "claude-settings",
          format: "json",
          relPath: "settings/f/settings.json",
        },
        value,
      },
    ];
    // Local-only elements come first, managed elements follow. The order is
    // the same on the first apply and on every later one.
    const first = reconcile({ x: ["m", "l"] }, {}, fragment({ x: ["m"] }));
    expect(first).toEqual({ x: ["l", "m"] });
    expect(reconcile(first!, { x: ["m"] }, fragment({ x: ["m"] }))).toEqual({
      x: ["l", "m"],
    });
    // A local value equal to a managed value cannot be told apart from it,
    // so rm removes it.
    expect(reconcile({ y: 1 }, { y: 1 }, [])).toEqual({});
    // Local duplicates survive add and rm.
    const added = reconcile({ x: ["l", "l"] }, {}, fragment({ x: ["m"] }));
    expect(added).toEqual({ x: ["l", "l", "m"] });
    expect(reconcile(added!, { x: ["m"] }, [])).toEqual({ x: ["l", "l"] });
  });
});
