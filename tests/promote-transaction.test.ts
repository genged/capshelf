import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
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
});
