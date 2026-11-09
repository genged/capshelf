import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { PreconditionError } from "../src/errors";
import {
  assertNoSymlinkAncestors,
  assertNoSymlinkAncestorsSync,
  assertRealPathOutsideRoot,
} from "../src/path-safety";
import { rejection, tempDir } from "./cli-fixtures";

type Guard = (root: string, relPath: string) => Promise<void>;

const guards: [string, Guard][] = [
  ["async", assertNoSymlinkAncestors],
  [
    "sync",
    async (root, relPath) => {
      assertNoSymlinkAncestorsSync(root, relPath);
    },
  ],
];

const unsafePaths = ["../x", "/etc/passwd", "a\\b", "./a", "a/../../x"];

describe.each(guards)("%s symlink-ancestor guard", (_name, guard) => {
  test.each(unsafePaths)("refuses unsafe path %p", async (relPath) => {
    const root = await tempDir("capshelf-path-safety-unsafe-");
    const error = await rejection(guard(root, relPath), PreconditionError);
    expect(error.message).toContain("unsafe repository path");
  });

  test("refuses a symlink ancestor", async () => {
    const root = await tempDir("capshelf-path-safety-link-root-");
    const outside = await tempDir("capshelf-path-safety-link-outside-");
    await symlink(outside, join(root, "link"));
    const error = await rejection(guard(root, "link/x"), PreconditionError);
    expect(error.message).toContain('symlink component "link"');
  });

  test("accepts the root path", async () => {
    const root = await tempDir("capshelf-path-safety-dot-");
    await guard(root, ".");
  });

  test("accepts a missing path", async () => {
    const root = await tempDir("capshelf-path-safety-missing-");
    await guard(root, "a/b/c");
  });

  test("accepts an existing plain path", async () => {
    const root = await tempDir("capshelf-path-safety-plain-");
    await mkdir(join(root, "a/b"), { recursive: true });
    await guard(root, "a/b");
  });
});

describe("assertRealPathOutsideRoot", () => {
  const message = "inside root";

  test("refuses the root itself", async () => {
    const root = await tempDir("capshelf-path-safety-out-root-");
    await expect(
      assertRealPathOutsideRoot(root, root, message),
    ).rejects.toThrow(message);
  });

  test("refuses a path inside the root", async () => {
    const root = await tempDir("capshelf-path-safety-out-inside-");
    await mkdir(join(root, "sub"));
    await expect(
      assertRealPathOutsideRoot(root, join(root, "sub"), message),
    ).rejects.toBeInstanceOf(PreconditionError);
  });

  test("refuses a missing tail inside the root", async () => {
    const root = await tempDir("capshelf-path-safety-out-missing-");
    await expect(
      assertRealPathOutsideRoot(root, join(root, "missing/deep"), message),
    ).rejects.toBeInstanceOf(PreconditionError);
  });

  test("accepts a sibling directory", async () => {
    const parent = await tempDir("capshelf-path-safety-out-sibling-");
    const root = join(parent, "root");
    const sibling = join(parent, "sibling");
    await mkdir(root);
    await mkdir(sibling);
    await assertRealPathOutsideRoot(root, sibling, message);
  });

  test("refuses an outside symlink that resolves into the root", async () => {
    const root = await tempDir("capshelf-path-safety-out-root-link-");
    const outside = await tempDir("capshelf-path-safety-out-link-");
    await mkdir(join(root, "sub"));
    const link = join(outside, "link");
    await symlink(join(root, "sub"), link);
    await expect(
      assertRealPathOutsideRoot(root, link, message),
    ).rejects.toBeInstanceOf(PreconditionError);
  });
});
