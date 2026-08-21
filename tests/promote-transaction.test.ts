import { file } from "bun";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginInstalledReconciliation } from "../src/promote-transaction";

describe("beginInstalledReconciliation", () => {
  test("replaces the managed snapshot while preserving generated files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-installed-txn-"));
    const installed = join(parent, "hello");
    await mkdir(join(installed, "nested"), { recursive: true });
    await writeFile(join(installed, "managed.txt"), "local\n");
    await writeFile(join(installed, "nested", "generated.log"), "generated\n");

    const transaction = await beginInstalledReconciliation(
      installed,
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100644",
        },
      ],
      [
        {
          path: "merged.txt",
          content: Buffer.from("merged\n"),
          mode: "100755",
        },
      ],
    );
    await transaction.commit();

    expect(await file(join(installed, "managed.txt")).exists()).toBe(false);
    expect(await file(join(installed, "merged.txt")).text()).toBe("merged\n");
    expect(await file(join(installed, "nested", "generated.log")).text()).toBe(
      "generated\n",
    );
  });

  test("rolls back the installed directory exactly", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "capshelf-installed-rollback-"),
    );
    const installed = join(parent, "hello");
    await mkdir(installed);
    await writeFile(join(installed, "managed.txt"), "local\n");
    await chmod(join(installed, "managed.txt"), 0o755);

    const transaction = await beginInstalledReconciliation(
      installed,
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100755",
        },
      ],
      [
        {
          path: "managed.txt",
          content: Buffer.from("merged\n"),
          mode: "100644",
        },
      ],
    );
    await transaction.rollback();

    expect(await file(join(installed, "managed.txt")).text()).toBe("local\n");
    expect((await stat(join(installed, "managed.txt"))).mode & 0o111).not.toBe(
      0,
    );
  });

  test("refuses a merged path below a frozen preserved symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-installed-symlink-"));
    const installed = join(parent, "hello");
    const outside = join(parent, "outside");
    const sentinel = join(outside, "file.md");
    await mkdir(installed);
    await mkdir(outside);
    await writeFile(join(installed, "managed.txt"), "local\n");
    await writeFile(sentinel, "outside\n");
    await symlink(outside, join(installed, "generated"));

    await expect(
      beginInstalledReconciliation(
        installed,
        [
          {
            path: "managed.txt",
            content: Buffer.from("local\n"),
            mode: "100644",
          },
        ],
        [
          {
            path: "generated/file.md",
            content: Buffer.from("merged\n"),
            mode: "100644",
          },
        ],
      ),
    ).rejects.toThrow(
      "preserved local path generated collides with reconciled managed path generated/file.md",
    );
    expect(await file(sentinel).text()).toBe("outside\n");
    expect(await file(join(installed, "managed.txt")).text()).toBe("local\n");
  });

  test("replaces a regular file at a newly managed path", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "capshelf-installed-new-path-"),
    );
    const installed = join(parent, "hello");
    await mkdir(installed);
    await writeFile(join(installed, "managed.txt"), "local\n");
    await writeFile(join(installed, "generated.txt"), "ignored local\n");

    const transaction = await beginInstalledReconciliation(
      installed,
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100644",
        },
      ],
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100644",
        },
        {
          path: "generated.txt",
          content: Buffer.from("upstream\n"),
          mode: "100644",
        },
      ],
    );
    await transaction.commit();

    expect(await file(join(installed, "generated.txt")).text()).toBe(
      "upstream\n",
    );
  });

  test("refuses to remove a managed path through a frozen symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-installed-delete-"));
    const installed = join(parent, "hello");
    const outside = join(parent, "outside");
    const sentinel = join(outside, "file.md");
    await mkdir(installed);
    await mkdir(outside);
    await writeFile(sentinel, "outside\n");
    await symlink(outside, join(installed, "managed"));

    await expect(
      beginInstalledReconciliation(
        installed,
        [
          {
            path: "managed/file.md",
            content: Buffer.from("local\n"),
            mode: "100644",
          },
        ],
        [],
      ),
    ).rejects.toThrow(
      "preserved local path managed collides with reconciled managed path managed/file.md",
    );
    expect(await file(sentinel).text()).toBe("outside\n");
  });

  test("replaces a symlink at an exact newly managed path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-installed-link-"));
    const installed = join(parent, "hello");
    const sentinel = join(parent, "outside.txt");
    await mkdir(installed);
    await writeFile(join(installed, "managed.txt"), "local\n");
    await writeFile(sentinel, "outside\n");
    await symlink(sentinel, join(installed, "generated.txt"));

    const transaction = await beginInstalledReconciliation(
      installed,
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100644",
        },
      ],
      [
        {
          path: "managed.txt",
          content: Buffer.from("local\n"),
          mode: "100644",
        },
        {
          path: "generated.txt",
          content: Buffer.from("upstream\n"),
          mode: "100644",
        },
      ],
    );
    await transaction.commit();

    expect(await file(sentinel).text()).toBe("outside\n");
    expect(await file(join(installed, "generated.txt")).text()).toBe(
      "upstream\n",
    );
  });
});
