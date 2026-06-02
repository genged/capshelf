import { describe, expect, test } from "bun:test";
import {
  dataEntriesMatch,
  dataEntryOrThrow,
  expectedAdoptionPath,
  refDisplay,
} from "../src/promote-core";
import type { DataLockEntry, LockEntry } from "../src/lock";

const dataEntry: DataLockEntry = {
  source: "data",
  sha: "sha1",
  sourceCommit: "commit1",
  appliedAt: "t",
};

describe("dataEntriesMatch", () => {
  test("true when source, sha, and sourceCommit all match", () => {
    expect(
      dataEntriesMatch(dataEntry, { ...dataEntry, appliedAt: "other" }),
    ).toBe(true);
  });

  test("false when sha differs", () => {
    expect(dataEntriesMatch(dataEntry, { ...dataEntry, sha: "sha2" })).toBe(
      false,
    );
  });

  test("false when sourceCommit differs", () => {
    expect(
      dataEntriesMatch(dataEntry, { ...dataEntry, sourceCommit: "commit2" }),
    ).toBe(false);
  });
});

describe("dataEntryOrThrow", () => {
  test("returns the entry when it is a data entry", () => {
    expect(dataEntryOrThrow(dataEntry, "k")).toBe(dataEntry);
  });

  test("throws for a missing entry", () => {
    expect(() => dataEntryOrThrow(undefined, "skills:x")).toThrow(
      /expected data lock entry for skills:x/,
    );
  });

  test("throws for a system entry", () => {
    const system: LockEntry = {
      source: "system",
      sha: "s",
      cliVersion: "1.0.0",
      appliedAt: "t",
    };
    expect(() => dataEntryOrThrow(system, "k")).toThrow(
      /expected data lock entry/,
    );
  });
});

describe("expectedAdoptionPath", () => {
  test("skills under codex-compatible offers both the codex and claude paths", () => {
    const path = expectedAdoptionPath("/p", "skills", "x", "codex-compatible");
    expect(path).toContain(" or ");
    expect(path).toContain("x");
  });

  test("skills under claude-only points at a single install path", () => {
    const path = expectedAdoptionPath("/p", "skills", "x", "claude-only");
    expect(path).not.toContain(" or ");
    expect(path).toContain("x");
  });

  test("non-skill kinds point at the fixed install path (no item name)", () => {
    expect(
      expectedAdoptionPath("/p", "mcp", "x", "codex-compatible"),
    ).toContain(".mcp.json");
  });
});

describe("refDisplay", () => {
  test("includes the kind when present", () => {
    expect(refDisplay({ kind: "skills", name: "x" })).toBe("skills/x");
  });

  test("omits the kind when absent", () => {
    expect(refDisplay({ name: "x" })).toBe("x");
  });
});
