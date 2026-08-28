import { describe, expect, test } from "bun:test";
import {
  configShapeLabel,
  dedupeAncestorPaths,
  walkConfigPaths,
} from "../src/config-paths";

describe("configShapeLabel", () => {
  test("summarizes shape and never the value", () => {
    expect(configShapeLabel({ a: 1, b: 2 })).toBe("2 keys");
    expect(configShapeLabel({ a: 1 })).toBe("1 key");
    expect(configShapeLabel(["x", "y", "z"])).toBe("3 entries");
    expect(configShapeLabel(["x"])).toBe("1 entry");
    expect(configShapeLabel("hunter2")).toBe("string");
    expect(configShapeLabel(42)).toBe("number");
    expect(configShapeLabel(true)).toBe("boolean");
    expect(configShapeLabel(null)).toBe("null");
  });
});

describe("walkConfigPaths", () => {
  test("walks every node, parents before children, in document order", () => {
    const rows = walkConfigPaths({
      permissions: { allow: ["a", "b", "c"], deny: ["x"] },
      env: { FOO: "bar" },
    });
    expect(rows.map((row) => [row.path, row.shape])).toEqual([
      ["permissions", "2 keys"],
      ["permissions.allow", "3 entries"],
      ["permissions.deny", "1 entry"],
      ["env", "1 key"],
      ["env.FOO", "string"],
    ]);
  });

  test("skips a key holding a terminal control byte, with its subtree", () => {
    // The path becomes a row label and a printed --pick argument, and
    // `shellArg` preserves bytes, so a raw ESC would reach the live terminal.
    const rows = walkConfigPaths({
      "evil\u001b[2Jkey": { inner: 1 },
      "bell\u0007": 2,
      plain: 3,
    });
    expect(rows.map((row) => row.path)).toEqual(["plain"]);
  });

  test("carries each node's value for fingerprinting", () => {
    const rows = walkConfigPaths({ env: { FOO: "bar" } });
    expect(rows.find((row) => row.path === "env.FOO")?.value).toBe("bar");
    expect(rows.find((row) => row.path === "env")?.value).toEqual({
      FOO: "bar",
    });
  });

  test("skips a key --pick cannot name, with its subtree", () => {
    // Pick paths split on dots, so `a.b` as one key and an empty key have no
    // pick syntax. Their nearest offerable ancestor still covers them.
    const rows = walkConfigPaths({
      "a.b": { inner: 1 },
      "": 2,
      wrapper: { "x.y": { deep: 3 }, plain: 4 },
    });
    expect(rows.map((row) => row.path)).toEqual(["wrapper", "wrapper.plain"]);
  });
});

describe("dedupeAncestorPaths", () => {
  test("drops a marked descendant when its ancestor is marked", () => {
    expect(
      dedupeAncestorPaths([
        "permissions",
        "permissions.allow",
        "env.FOO",
        "permissions.allow.nested",
      ]),
    ).toEqual(["permissions", "env.FOO"]);
  });

  test("keeps siblings and repeated marks collapse to one", () => {
    expect(
      dedupeAncestorPaths([
        "permissions.allow",
        "permissions.deny",
        "permissions.allow",
      ]),
    ).toEqual(["permissions.allow", "permissions.deny"]);
  });

  test("a shared name prefix is not an ancestor", () => {
    // `env` is not an ancestor of `environment`: ancestry is by segment, not
    // by string prefix.
    expect(dedupeAncestorPaths(["env", "environment.FOO"])).toEqual([
      "env",
      "environment.FOO",
    ]);
  });
});
