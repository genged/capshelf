import { file } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  beginDirectoryReplacement,
  beginInstalledReconciliation,
} from "../src/promote-transaction";
import type { MutationScope } from "../src/path-safety";

const TEST_SCOPE: MutationScope = { exempt: "test folder in the temp dir" };

describe("beginDirectoryReplacement", () => {
  test("retries transaction cleanup after a transient denial", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-materialize-txn-"));
    const target = join(parent, "hello");
    await mkdir(target);
    await writeFile(join(target, "SKILL.md"), "old\n");
    const transaction = await beginDirectoryReplacement(
      target,
      TEST_SCOPE,
      async (replacement) => {
        await mkdir(replacement);
        await writeFile(join(replacement, "SKILL.md"), "new\n");
        return [];
      },
    );

    let transactionDirs: string[] = [];
    let installedContent = "";
    await chmod(parent, 0o555);
    const unlock = (async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      await chmod(parent, 0o755);
    })();
    try {
      await transaction.commit();
      await transaction.commit();
      await unlock;
      installedContent = await file(join(target, "SKILL.md")).text();
      transactionDirs = (await readdir(parent)).filter((name) =>
        name.startsWith(".capshelf-materialize-"),
      );
    } finally {
      await chmod(parent, 0o755);
      await unlock;
      await rm(parent, { recursive: true, force: true });
    }

    expect(transactionDirs).toEqual([]);
    expect(installedContent).toBe("new\n");
  });
});

const runningAsRoot = process.getuid?.() === 0;

/** A target with a managed file and a read-only ignored folder `cache`. */
async function targetWithReadOnlyUnit(prefix: string) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const target = join(parent, "hello");
  await mkdir(join(target, "cache", "inner"), { recursive: true });
  await writeFile(join(target, "SKILL.md"), "old\n");
  await writeFile(join(target, "cache", "inner", "a.bin"), "kept\n");
  await chmod(join(target, "cache"), 0o555);
  const cleanup = async () => {
    await chmod(join(target, "cache"), 0o755).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  };
  return { parent, target, cleanup };
}

describe("read-only units", () => {
  for (const finish of ["commit", "rollback"] as const) {
    test.skipIf(runningAsRoot)(
      `beginDirectoryReplacement holds a read-only unit in place (${finish})`,
      async () => {
        const { parent, target, cleanup } = await targetWithReadOnlyUnit(
          "capshelf-held-unit-",
        );
        try {
          const transaction = await beginDirectoryReplacement(
            target,
            TEST_SCOPE,
            async (replacement) => {
              await mkdir(replacement);
              await writeFile(join(replacement, "SKILL.md"), "new\n");
              return ["cache"];
            },
          );
          await transaction[finish]();
          expect(await file(join(target, "SKILL.md")).text()).toBe(
            finish === "commit" ? "new\n" : "old\n",
          );
          expect(
            await file(join(target, "cache", "inner", "a.bin")).text(),
          ).toBe("kept\n");
          expect((await stat(join(target, "cache"))).mode & 0o777).toBe(0o555);
          expect(
            (await readdir(parent)).filter((name) =>
              name.startsWith(".capshelf-"),
            ),
          ).toEqual([]);
        } finally {
          await cleanup();
        }
      },
    );

    test.skipIf(runningAsRoot)(
      `beginInstalledReconciliation holds a read-only unit in place (${finish})`,
      async () => {
        const { target, cleanup } = await targetWithReadOnlyUnit(
          "capshelf-held-reconcile-",
        );
        try {
          const transaction = await beginInstalledReconciliation(
            target,
            [
              {
                path: "SKILL.md",
                content: Buffer.from("old\n"),
                mode: "100644",
              },
            ],
            [
              {
                path: "SKILL.md",
                content: Buffer.from("new\n"),
                mode: "100644",
              },
            ],
            TEST_SCOPE,
          );
          await transaction[finish]();
          expect(await file(join(target, "SKILL.md")).text()).toBe(
            finish === "commit" ? "new\n" : "old\n",
          );
          expect(
            await file(join(target, "cache", "inner", "a.bin")).text(),
          ).toBe("kept\n");
        } finally {
          await cleanup();
        }
      },
    );
  }

  test.skipIf(runningAsRoot)(
    "a scratch folder that cannot be deleted after a commit is a warning",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "capshelf-commit-warn-"));
      const target = join(parent, "hello");
      await mkdir(target);
      await writeFile(join(target, "SKILL.md"), "old\n");
      const transaction = await beginDirectoryReplacement(
        target,
        TEST_SCOPE,
        async (replacement) => {
          await mkdir(replacement);
          await writeFile(join(replacement, "SKILL.md"), "new\n");
          return [];
        },
      );
      const written: string[] = [];
      const stderr = spyOn(process.stderr, "write").mockImplementation(
        (chunk) => {
          written.push(String(chunk));
          return true;
        },
      );
      // The scratch folder is in `parent`, so a read-only parent keeps it.
      await chmod(parent, 0o555);
      try {
        await transaction.commit();
      } finally {
        stderr.mockRestore();
        await chmod(parent, 0o755);
      }
      try {
        expect(await file(join(target, "SKILL.md")).text()).toBe("new\n");
        expect(written.join("")).toContain(
          "could not delete the scratch folder",
        );
        expect(written.join("")).toContain("The new files are in place.");
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});

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
      TEST_SCOPE,
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
      TEST_SCOPE,
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
        TEST_SCOPE,
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
      TEST_SCOPE,
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
        TEST_SCOPE,
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
      TEST_SCOPE,
    );
    await transaction.commit();

    expect(await file(sentinel).text()).toBe("outside\n");
    expect(await file(join(installed, "generated.txt")).text()).toBe(
      "upstream\n",
    );
  });
});
