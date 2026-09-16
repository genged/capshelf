import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  emptyRemotesLock,
  loadRemotesLock,
  parseRemoteKey,
  remoteKey,
  saveRemotesLock,
  serializeRemotesLock,
} from "../src/remotes-lock";
import { tempDir } from "./cli-fixtures";

const ENTRY = {
  upstream: "https://github.com/obra/superpowers",
  ref: "main",
  subpath: "skills/brainstorming",
  sourceCommit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
  sourcePinDigest: "a".repeat(64),
  appliedAt: "2026-09-13T00:00:00.000Z",
};

test("a saved remotes lock round-trips and is gitignored", async () => {
  const project = await tempDir("capshelf-remotes-");
  const lock = emptyRemotesLock();
  lock.items[remoteKey("brainstorming")] = { ...ENTRY };
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
    '{"version":2,"items":{}}\n',
  );
  await expect(loadRemotesLock(project)).rejects.toThrow(/version 2 is newer/);
});

test("the key grammar is remote/skills/<name>", () => {
  expect(remoteKey("pdf")).toBe("remote/skills/pdf");
  expect(parseRemoteKey("remote/skills/pdf")).toEqual({
    kind: "skills",
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
  lock.items[remoteKey("pdf")] = { ...ENTRY, sourcePinDigest: "zz" };
  expect(() => serializeRemotesLock(lock)).toThrow();
});
