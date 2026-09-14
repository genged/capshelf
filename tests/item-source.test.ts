/**
 * The two invariants the source and ownership refactor must not move.
 *
 * R1 fixes the default: an item with no explicit root pins at the canonical
 * layout `itemRepoRelPath` derives. Every item does that today, and the
 * refactor turns the derivation into a field with this as its default. A change
 * here is the refactor repointing every item in the product.
 *
 * R2 fixes the boundary: a system entry resolves with no repository at all.
 * Today that is an ambient `dataRepo` argument plus a runtime throw at a
 * distance (`src/materialize.ts:187`, `:773`). After the refactor the
 * repository lives inside the content source, so the disagreement those throws
 * guard against cannot be expressed.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "../src/pin";
import { commitAll, tempRepo } from "./cli-fixtures";

test("R1: a data item pins at its canonical repository path", async () => {
  const repo = await tempRepo("capshelf-source-r1-");
  await mkdir(join(repo, "skills", "review"), { recursive: true });
  await writeFile(join(repo, "skills", "review", "SKILL.md"), "canonical\n");
  await mkdir(join(repo, "skills", "review", "references"), { recursive: true });
  await writeFile(
    join(repo, "skills", "review", "references", "notes.md"),
    "notes\n",
  );
  await commitAll(repo, "one item");

  const entries = await itemTreeEntriesAtCommit(repo, "skills", "review", "HEAD");

  // Repository-relative paths name the canonical layout.
  expect(entries.map((entry) => entry.repoRelPath)).toEqual([
    "skills/review/SKILL.md",
    "skills/review/references/notes.md",
  ]);
  // Item-relative paths are rooted at the item, not at the repository.
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
    repo,
    "pi-extensions",
    "linter",
    "HEAD",
  );
  expect(entries.map((entry) => entry.repoRelPath)).toEqual([
    "pi/extensions/linter/index.ts",
  ]);
});

test("R2: a system entry needs no repository to resolve its content", async () => {
  // Replace this dynamic import with a top-level one in Phase 1. The module
  // does not exist at Phase 0, which is this test's recorded RED, and this
  // repository forbids inline imports in shipped code.
  const { contentSourceFor } = await import("../src/item-source");

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
  // No repository was supplied, and none was required. Under the shape this
  // refactor replaces, the caller passed `dataRepo` separately and a mismatch
  // was caught at runtime rather than being unrepresentable.
});

test("R2: a data entry without a repository is a programmer error", async () => {
  const { contentSourceFor } = await import("../src/item-source");

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
