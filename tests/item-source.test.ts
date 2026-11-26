import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "../src/pin";
import {
  contentSourceFor,
  gitTreeSource,
  ownershipFor,
} from "../src/item-source";
import type { LockEntry } from "../src/lock";
import { commitAll, tempRepo } from "./cli-fixtures";

test("R1: a data item pins at its canonical repository path", async () => {
  const repo = await tempRepo("capshelf-source-r1-");
  await mkdir(join(repo, "skills", "review"), { recursive: true });
  await writeFile(join(repo, "skills", "review", "SKILL.md"), "canonical\n");
  await mkdir(join(repo, "skills", "review", "references"), {
    recursive: true,
  });
  await writeFile(
    join(repo, "skills", "review", "references", "notes.md"),
    "notes\n",
  );
  await commitAll(repo, "one item");

  const entries = await itemTreeEntriesAtCommit(
    gitTreeSource({ repo, kind: "skills", name: "review", commit: "HEAD" }),
    "skills",
  );

  expect(entries.map((entry) => entry.repoRelPath)).toEqual([
    "skills/review/SKILL.md",
    "skills/review/references/notes.md",
  ]);
  expect(entries.map((entry) => entry.path)).toEqual([
    "SKILL.md",
    "references/notes.md",
  ]);
  expect(sourcePinDigest(entries)).toMatch(/^[0-9a-f]{64}$/);
});

test("R1: a pi-extension pins at its own canonical path, not under skills", async () => {
  const repo = await tempRepo("capshelf-source-r1-pi-");
  await mkdir(join(repo, "pi", "extensions", "linter"), { recursive: true });
  await writeFile(
    join(repo, "pi", "extensions", "linter", "index.ts"),
    "export default {};\n",
  );
  await commitAll(repo, "one extension");

  const entries = await itemTreeEntriesAtCommit(
    gitTreeSource({
      repo,
      kind: "pi-extensions",
      name: "linter",
      commit: "HEAD",
    }),
    "pi-extensions",
  );
  expect(entries.map((entry) => entry.repoRelPath)).toEqual([
    "pi/extensions/linter/index.ts",
  ]);
});

test("R2: a system entry needs no repository to resolve its content", () => {
  const source = contentSourceFor({
    entry: {
      source: "system",
      sha: "bb98bfd98e63",
      cliVersion: "0.12.0",
      appliedAt: "2026-09-14T00:00:00.000Z",
    },
    kind: "skills",
    name: "capshelf",
  });

  expect(source.kind).toBe("bundled");
});

test("R2: a data entry without a repository is a programmer error", () => {
  expect(() =>
    contentSourceFor({
      entry: {
        source: "data",
        sourcePinDigest: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        needs: null,
        needsSourceCommit: null,
        appliedAt: "2026-09-14T00:00:00.000Z",
      },
      kind: "skills",
      name: "review",
    }),
  ).toThrow(/repository/i);
});

test("ownership is derived from the record, not from the content", () => {
  const shelfEntry: LockEntry = {
    source: "data",
    sourcePinDigest: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    needs: null,
    needsSourceCommit: null,
    appliedAt: "2026-09-14T00:00:00.000Z",
  };
  const systemEntry: LockEntry = {
    source: "system",
    sha: "bb98bfd98e63",
    cliVersion: "0.12.0",
    appliedAt: "2026-09-14T00:00:00.000Z",
  };
  expect(ownershipFor(shelfEntry)).toBe("shelf");
  expect(ownershipFor(systemEntry)).toBe("system");
});
