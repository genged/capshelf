import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findMasterItemByRef,
  lockKeyForRef,
  lockKeysForRef,
  parseItemRef,
} from "../src/item-ref";
import type { Lock } from "../src/lock";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-item-ref-"));
}

describe("parseItemRef", () => {
  test("accepts a bare item name", () => {
    expect(parseItemRef("hello")).toEqual({ name: "hello" });
  });

  test("accepts explicit kind/name refs", () => {
    expect(parseItemRef("skills/hello")).toEqual({
      kind: "skills",
      name: "hello",
    });
  });

  test("rejects unsupported kinds", () => {
    expect(() => parseItemRef("commands/deploy")).toThrow(
      /invalid item kind/,
    );
  });

  test("rejects lock-key-shaped refs", () => {
    expect(() => parseItemRef("data/skills/hello")).toThrow(
      /looks like a lock key/,
    );
  });

  test("rejects slashful names for now", () => {
    expect(() => parseItemRef("skills/foo/bar")).toThrow(/invalid item ref/);
  });

  test("rejects empty and missing names", () => {
    expect(() => parseItemRef("")).toThrow(/empty item ref/);
    expect(() => parseItemRef("skills/")).toThrow(/missing name/);
  });

  test("rejects dot path names", () => {
    expect(() => parseItemRef(".")).toThrow(/invalid item name/);
    expect(() => parseItemRef("skills/..")).toThrow(/invalid item name/);
  });
});

describe("findMasterItemByRef", () => {
  test("resolves explicit kind refs", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });

    const item = await findMasterItemByRef(dataRepo, {
      kind: "skills",
      name: "hello",
    });

    expect(item?.kind).toBe("skills");
    expect(item?.name).toBe("hello");
    expect(item?.repoRelPath).toBe("skills/hello");
  });

  test("rejects ambiguous bare names", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "skills", "auth"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "auth"), { recursive: true });

    await expect(
      findMasterItemByRef(dataRepo, { name: "auth" }),
    ).rejects.toThrow(/ambiguous item/);
  });

  test("returns null when no item matches", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });

    expect(await findMasterItemByRef(dataRepo, { name: "missing" })).toBeNull();
  });
});

describe("lockKeysForRef", () => {
  const lock: Lock = {
    version: 2,
    items: {
      "data/skills/hello": {
        source: "data",
        sha: "abc",
        sourceCommit: "def",
        appliedAt: "2026-04-30T00:00:00.000Z",
      },
      "system/skills/capshelf": {
        source: "system",
        sha: "123",
        cliVersion: "0.3.0",
        appliedAt: "2026-04-30T00:00:00.000Z",
      },
    },
  };

  test("matches bare names across sources", () => {
    expect(lockKeysForRef(lock, { name: "hello" })).toEqual([
      "data/skills/hello",
    ]);
  });

  test("matches explicit kind refs", () => {
    expect(lockKeysForRef(lock, { kind: "skills", name: "capshelf" })).toEqual(
      ["system/skills/capshelf"],
    );
  });

  test("does not match the wrong kind", () => {
    expect(lockKeysForRef(lock, { kind: "settings", name: "hello" })).toEqual(
      [],
    );
  });
});

describe("lockKeyForRef", () => {
  const lock: Lock = {
    version: 2,
    items: {
      "data/skills/shared": {
        source: "data",
        sha: "abc",
        sourceCommit: "def",
        appliedAt: "2026-04-30T00:00:00.000Z",
      },
      "system/skills/shared": {
        source: "system",
        sha: "123",
        cliVersion: "0.3.0",
        appliedAt: "2026-04-30T00:00:00.000Z",
      },
    },
  };

  test("uses source filtering to disambiguate lock keys", () => {
    expect(lockKeyForRef(lock, { kind: "skills", name: "shared" }, "data")).toBe(
      "data/skills/shared",
    );
    expect(
      lockKeyForRef(lock, { kind: "skills", name: "shared" }, "system"),
    ).toBe("system/skills/shared");
  });

  test("returns null when no lock key matches", () => {
    expect(lockKeyForRef(lock, { kind: "settings", name: "shared" })).toBeNull();
  });

  test("rejects ambiguous lock keys when source is not specified", () => {
    expect(() =>
      lockKeyForRef(lock, { kind: "skills", name: "shared" }),
    ).toThrow(/ambiguous item/);
  });
});
