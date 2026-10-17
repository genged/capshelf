import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  emptyRemotesLock,
  loadRemotesLock,
  parseRemoteKey,
  parseRemotesLock,
  remoteKey,
  remoteKeysForRef,
  saveRemotesLock,
  serializeRemotesLock,
} from "../src/remotes-lock";
import type { ConfigObject } from "../src/config-values";
import { tempDir } from "./cli-fixtures";

const ENTRY = {
  upstream: "https://github.com/obra/superpowers",
  ref: "main",
  subpath: "skills/brainstorming",
  sourceCommit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
  sourcePinDigest: "a".repeat(64),
  appliedAt: "2026-09-13T00:00:00.000Z",
};

/**
 * A valid remote lock entry, as a `ConfigObject` — the shape
 * `parseRemotesLock` reads — for a test that only cares about the key.
 */
function row(): ConfigObject {
  return { ...ENTRY };
}

test("a saved remotes lock round-trips and is gitignored", async () => {
  const project = await tempDir("capshelf-remotes-");
  const lock = emptyRemotesLock();
  lock.items[remoteKey("skills", "brainstorming")] = { ...ENTRY };
  await saveRemotesLock(project, lock);

  const loaded = await loadRemotesLock(project);
  expect(loaded).toEqual(lock);

  const ignore = await readFile(
    join(project, ".capshelf", ".gitignore"),
    "utf-8",
  );
  expect(ignore.split("\n")).toContain("remotes.lock.json");
});

test("an absent remotes lock loads as empty", async () => {
  const project = await tempDir("capshelf-remotes-absent-");
  expect(await loadRemotesLock(project)).toEqual({ version: 1, items: {} });
});

test("a newer schema version is refused by version, not by field", async () => {
  const project = await tempDir("capshelf-remotes-future-");
  await saveRemotesLock(project, emptyRemotesLock());
  await Bun.write(
    join(project, ".capshelf", "remotes.lock.json"),
    '{"version":3,"items":{}}\n',
  );
  await expect(loadRemotesLock(project)).rejects.toThrow(/version 3 is newer/);
});

test("the key grammar is remote/<kind>/<name>", () => {
  expect(remoteKey("skills", "pdf")).toBe("remote/skills/pdf");
  expect(remoteKey("plugins", "pdf")).toBe("remote/plugins/pdf");
  expect(parseRemoteKey("remote/skills/pdf")).toEqual({
    kind: "skills",
    name: "pdf",
  });
  expect(parseRemoteKey("remote/plugins/pdf")).toEqual({
    kind: "plugins",
    name: "pdf",
  });
  expect(() => parseRemoteKey("data/skills/pdf")).toThrow(/invalid remote key/);
  expect(() => parseRemoteKey("remote/settings/base")).toThrow(/only skills/);
  expect(() => parseRemoteKey("remote/skills/../evil")).toThrow(
    /invalid item name/,
  );
});

test("serialization strict-parses its own output", () => {
  const lock = emptyRemotesLock();
  lock.items[remoteKey("skills", "pdf")] = { ...ENTRY, sourcePinDigest: "zz" };
  expect(() => serializeRemotesLock(lock)).toThrow();
});

test("a plugins row is accepted and written as version 2", () => {
  const lock = parseRemotesLock({
    version: 2,
    items: { "remote/plugins/gh-cli": row() },
  });
  expect(JSON.parse(serializeRemotesLock(lock)).version).toBe(2);
});

test("a skills-only lock is written as version 1", () => {
  const lock = parseRemotesLock({
    version: 2,
    items: { "remote/skills/a": row() },
  });
  expect(JSON.parse(serializeRemotesLock(lock)).version).toBe(1);
});

test("a version 1 lock with a plugins row is refused", () => {
  expect(() =>
    parseRemotesLock({ version: 1, items: { "remote/plugins/x": row() } }),
  ).toThrow(/plugins rows need remotes lock version 2/);
});

test("version 3 asks for an upgrade", () => {
  expect(() => parseRemotesLock({ version: 3, items: {} })).toThrow(
    /upgrade capshelf/,
  );
});

test("remoteKeysForRef picks the kind from the ref", () => {
  const lock = parseRemotesLock({
    version: 2,
    items: { "remote/plugins/x": row(), "remote/skills/x": row() },
  });
  expect(remoteKeysForRef(lock, { kind: "plugins", name: "x" })).toEqual([
    "remote/plugins/x",
  ]);
  expect(remoteKeysForRef(lock, { name: "x" }).sort()).toEqual([
    "remote/plugins/x",
    "remote/skills/x",
  ]);
});
