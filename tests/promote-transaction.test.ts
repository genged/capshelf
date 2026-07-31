import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { headSha } from "../src/git";
import type { NamedFile } from "../src/merge-tree";
import {
  beginInstalledReconciliation,
  commitNamedFilesTransaction,
  promoteTransactionLocations,
} from "../src/promote-transaction";

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-promote-txn-"));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await mkdir(join(repo, "skills", "hello"), { recursive: true });
  await writeFile(join(repo, "skills", "hello", "old.txt"), "old\n");
  await writeFile(
    join(repo, "skills", "hello", ".capshelf.yml"),
    "tags: [old]\n",
  );
  await writeFile(join(repo, "unrelated.txt"), "unchanged\n");
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm baseline`.quiet();
  return repo;
}

function mergedFiles(): NamedFile[] {
  return [
    {
      path: "new.txt",
      content: Buffer.from("new\n"),
      mode: "100755",
    },
  ];
}

describe("commitNamedFilesTransaction", () => {
  test("keeps rename artifacts on the worktree and real-index filesystems", async () => {
    const root = await mkdtemp(join(tmpdir(), "capshelf-separate-git-"));
    const repo = join(root, "worktree");
    const gitDir = join(root, "separate-git");
    await mkdir(repo);
    await $`git init -q --separate-git-dir=${gitDir} ${repo}`.quiet();
    await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
    await $`git -C ${repo} config user.name capshelf`.quiet();
    await mkdir(join(repo, "skills", "hello"), { recursive: true });
    await writeFile(join(repo, "skills", "hello", "old.txt"), "old\n");
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -qm baseline`.quiet();

    const locations = await promoteTransactionLocations(repo, "skills/hello");
    expect(locations.itemBackupParent).toBe(join(repo, "skills"));
    expect(locations.indexReplacementParent).toBe(await realpath(gitDir));

    await commitNamedFilesTransaction({
      repo,
      repoRelPath: "skills/hello",
      files: mergedFiles(),
      sidecar: null,
      expectedHead: await headSha(repo),
      message: "merged",
    });

    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
    expect(
      (await readdir(join(repo, "skills"))).some((name) =>
        name.startsWith(".capshelf-promote-item-"),
      ),
    ).toBe(false);
    expect(
      (await readdir(gitDir)).some((name) =>
        name.startsWith(".capshelf-promote-index-"),
      ),
    ).toBe(false);
  });

  test("advances one parent, replaces only the item, and leaves a clean index", async () => {
    const repo = await tempRepo();
    const before = await headSha(repo);

    const commit = await commitNamedFilesTransaction({
      repo,
      repoRelPath: "skills/hello",
      files: mergedFiles(),
      sidecar: Buffer.from("tags: [new]\n"),
      expectedHead: before,
      message: "merged",
    });

    expect(commit).toBe(await headSha(repo));
    expect(
      (await $`git -C ${repo} rev-list --parents -n 1 HEAD`.text())
        .trim()
        .split(" "),
    ).toEqual([commit, before]);
    expect(await file(join(repo, "skills", "hello", "old.txt")).exists()).toBe(
      false,
    );
    expect(await file(join(repo, "skills", "hello", "new.txt")).text()).toBe(
      "new\n",
    );
    expect(
      (await stat(join(repo, "skills", "hello", "new.txt"))).mode & 0o111,
    ).not.toBe(0);
    expect(
      await file(join(repo, "skills", "hello", ".capshelf.yml")).text(),
    ).toBe("tags: [new]\n");
    expect(await file(join(repo, "unrelated.txt")).text()).toBe("unchanged\n");
    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
  });

  test("restores HEAD, index bytes, and the exact item path on pre-commit failure", async () => {
    const repo = await tempRepo();
    const before = await headSha(repo);
    const indexPath = (
      await $`git -C ${repo} rev-parse --git-path index`.text()
    ).trim();
    const indexBefore = await readFile(join(repo, indexPath));

    await expect(
      commitNamedFilesTransaction({
        repo,
        repoRelPath: "skills/hello",
        files: mergedFiles(),
        sidecar: null,
        expectedHead: before,
        message: "merged",
        hooks: {
          afterPathReplaced: async () => {
            throw new Error("injected failure");
          },
        },
      }),
    ).rejects.toThrow("injected failure");

    expect(await headSha(repo)).toBe(before);
    expect(await readFile(join(repo, indexPath))).toEqual(indexBefore);
    expect(await file(join(repo, "skills", "hello", "old.txt")).text()).toBe(
      "old\n",
    );
    expect(
      await file(join(repo, "skills", "hello", ".capshelf.yml")).text(),
    ).toBe("tags: [old]\n");
    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
  });

  test("rolls back failures both before replacement and immediately before HEAD advance", async () => {
    for (const phase of ["afterPrepared", "beforeHeadAdvance"] as const) {
      const repo = await tempRepo();
      const before = await headSha(repo);
      const hook = async () => {
        throw new Error(`injected ${phase}`);
      };

      await expect(
        commitNamedFilesTransaction({
          repo,
          repoRelPath: "skills/hello",
          files: mergedFiles(),
          sidecar: null,
          expectedHead: before,
          message: "merged",
          hooks: { [phase]: hook },
        }),
      ).rejects.toThrow(`injected ${phase}`);

      expect(await headSha(repo)).toBe(before);
      expect(await file(join(repo, "skills", "hello", "old.txt")).text()).toBe(
        "old\n",
      );
      expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe(
        "",
      );
    }
  });
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
