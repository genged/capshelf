import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isErrno, lstatOrNull } from "../src/fs-utils";

describe("isErrno", () => {
  test("matches a Node errno by code", () => {
    expect(isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(isErrno({ code: "EACCES" }, "ENOENT")).toBe(false);
  });

  test("matches any errno when no code is given", () => {
    expect(isErrno({ code: "EPERM" })).toBe(true);
  });

  test("rejects non-errno values", () => {
    expect(isErrno(null, "ENOENT")).toBe(false);
    expect(isErrno("ENOENT", "ENOENT")).toBe(false);
    expect(isErrno(new Error("plain"), "ENOENT")).toBe(false);
    expect(isErrno({}, "ENOENT")).toBe(false);
  });
});

describe("lstatOrNull", () => {
  test("returns stats for an existing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-"));
    const file = join(dir, "f.txt");
    await writeFile(file, "hi");
    const stat = lstatOrNull(file);
    expect(stat?.isFile()).toBe(true);
  });

  test("returns null for a missing path", () => {
    expect(
      lstatOrNull(join(tmpdir(), "definitely-missing-xyz-123")),
    ).toBeNull();
  });
});
