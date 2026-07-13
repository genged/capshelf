import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFile, isErrno, lstatOrNull } from "../src/fs-utils";

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

describe("atomicWriteFile", () => {
  async function tmp(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "capshelf-atomic-"));
  }

  test("writes new content and leaves no temp file behind", async () => {
    const dir = await tmp();
    const target = join(dir, "lock.json");
    await atomicWriteFile(target, '{"ok":true}\n');
    expect(await readFile(target, "utf-8")).toBe('{"ok":true}\n');
    // The temp file is renamed into place, never left dangling.
    expect(await readdir(dir)).toEqual(["lock.json"]);
  });

  test("replaces existing content in place", async () => {
    const dir = await tmp();
    const target = join(dir, "manifest.json");
    await writeFile(target, "old");
    await atomicWriteFile(target, "new");
    expect(await readFile(target, "utf-8")).toBe("new");
    expect(await readdir(dir)).toEqual(["manifest.json"]);
  });

  test("writes byte content unchanged", async () => {
    const dir = await tmp();
    const target = join(dir, "blob.bin");
    const bytes = new Uint8Array([0, 1, 2, 200, 255]);
    await atomicWriteFile(target, bytes);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });
});
