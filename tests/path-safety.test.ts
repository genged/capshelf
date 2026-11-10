import { describe, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PreconditionError } from "../src/errors";
import {
  assertConfined,
  assertConfinedSync,
  assertRealPathOutsideRoot,
  type ConfinementPolicy,
} from "../src/path-safety";
import { rejection, tempDir } from "./cli-fixtures";

type Guard = (
  root: string,
  target: string,
  policy?: ConfinementPolicy,
) => Promise<void>;

const guards: [string, Guard][] = [
  [
    "async",
    async (root, target, policy) => {
      await assertConfined(root, target, policy);
    },
  ],
  [
    "sync",
    async (root, target, policy) => {
      assertConfinedSync(root, target, policy);
    },
  ],
];

const unsafePaths = [
  "",
  ".",
  "../x",
  "/etc/passwd",
  "a\\b",
  "./a",
  "a/./b",
  "a/../../x",
];

describe.each(guards)("%s confinement primitive", (_name, guard) => {
  test.each(unsafePaths)("refuses unsafe path %p", async (relPath) => {
    const root = await tempDir("capshelf-path-safety-unsafe-");
    const error = await rejection(guard(root, relPath), PreconditionError);
    expect(error.message).toMatch(/unsafe repository path|outside project/);
  });

  test("refuses an absolute path outside the root", async () => {
    const root = await tempDir("capshelf-path-safety-abs-root-");
    const other = await tempDir("capshelf-path-safety-abs-other-");
    const error = await rejection(guard(root, other), PreconditionError);
    expect(error.message).toContain("outside project");
  });

  test("refuses a parent link that leaves the root and names both paths", async () => {
    const root = await tempDir("capshelf-path-safety-parent-root-");
    const outside = await tempDir("capshelf-path-safety-parent-outside-");
    await symlink(outside, join(root, "link"));
    const error = await rejection(guard(root, "link/x"), PreconditionError);
    expect(error.message).toContain("link/x");
    expect(error.message).toContain(await realpath(outside));
  });

  test("refuses a leaf link that leaves the root", async () => {
    const root = await tempDir("capshelf-path-safety-leaf-root-");
    const outside = await tempDir("capshelf-path-safety-leaf-outside-");
    await writeFile(join(outside, "file"), "x");
    await symlink(join(outside, "file"), join(root, "leaf"));
    const error = await rejection(guard(root, "leaf"), PreconditionError);
    expect(error.message).toContain(await realpath(outside));
  });

  test("refuses an absolute target below a parent link that leaves the root", async () => {
    const root = await tempDir("capshelf-path-safety-abs-link-root-");
    const outside = await tempDir("capshelf-path-safety-abs-link-outside-");
    await symlink(outside, join(root, "link"));
    await rejection(guard(root, join(root, "link", "x")), PreconditionError);
  });

  test("refuses a dangling link", async () => {
    const root = await tempDir("capshelf-path-safety-dangling-root-");
    await symlink(join(root, "missing"), join(root, "dangling"));
    const error = await rejection(guard(root, "dangling/x"), PreconditionError);
    expect(error.message).toContain("dangling");
  });

  test("allows a link that stays inside the root", async () => {
    const root = await tempDir("capshelf-path-safety-inside-root-");
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    await guard(root, "alias/x");
    await guard(root, "alias");
  });

  test("allows a relative link that stays inside the root", async () => {
    const root = await tempDir("capshelf-path-safety-relative-root-");
    await mkdir(join(root, "a/skills/x"), { recursive: true });
    await mkdir(join(root, "b/skills"), { recursive: true });
    await symlink("../../a/skills/x", join(root, "b/skills/x"));
    await guard(root, "b/skills/x");
  });

  test("refuses an inside link whose next link leaves the root", async () => {
    const root = await tempDir("capshelf-path-safety-chain-root-");
    const outside = await tempDir("capshelf-path-safety-chain-outside-");
    await mkdir(join(root, "real"));
    await symlink(outside, join(root, "real", "out"));
    await symlink(join(root, "real"), join(root, "alias"));
    await rejection(guard(root, "alias/out/x"), PreconditionError);
  });

  test("refuses any link under the deny policy", async () => {
    const root = await tempDir("capshelf-path-safety-deny-root-");
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const error = await rejection(
      guard(root, "alias/x", "deny"),
      PreconditionError,
    );
    expect(error.message).toContain('symlink component "alias"');
  });

  test("allows a root that is reached through a symlink", async () => {
    const parent = await tempDir("capshelf-path-safety-rootlink-");
    await mkdir(join(parent, "real/sub"), { recursive: true });
    await symlink(join(parent, "real"), join(parent, "alias"));
    await guard(join(parent, "alias"), "sub/x");
    await guard(join(parent, "alias"), join(parent, "alias", "sub", "x"));
    await guard(join(parent, "alias"), "sub/x", "deny");
  });

  test("accepts the root as an absolute path", async () => {
    const root = await tempDir("capshelf-path-safety-dot-");
    await guard(root, root);
  });

  test("allows an in-project link to a name that starts with two dots", async () => {
    const root = await tempDir("capshelf-path-safety-dotdot-name-");
    await mkdir(join(root, "..cache"));
    await symlink("..cache", join(root, "link"));
    await guard(root, "link/x");
  });

  test("refuses a missing root that is a dangling symlink", async () => {
    const parent = await tempDir("capshelf-path-safety-deadroot-");
    await symlink(join(parent, "nowhere"), join(parent, "root"));
    const error = await rejection(
      guard(join(parent, "root"), "a/b"),
      PreconditionError,
    );
    expect(error.message).toContain("dangling");
  });

  test("accepts a root that does not exist", async () => {
    const parent = await tempDir("capshelf-path-safety-noroot-");
    await guard(join(parent, "missing"), "a/b");
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
