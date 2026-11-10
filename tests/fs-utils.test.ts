import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MutationScope } from "../src/path-safety";
import {
  atomicWriteFile,
  isErrno,
  lstatOrNull,
  rmTreeWithRetries,
} from "../src/fs-utils";

describe("isErrno", () => {
  test("narrows a Node errno error and matches its code", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isErrno(error)).toBe(true);
    expect(isErrno(error, "ENOENT")).toBe(true);
    expect(isErrno(error, "EACCES")).toBe(false);
  });

  test("rejects values that are not errno errors", () => {
    expect(isErrno(new Error("plain"))).toBe(false);
    expect(isErrno({ code: "ENOENT" })).toBe(false);
    expect(isErrno(null)).toBe(false);
    expect(isErrno("ENOENT")).toBe(false);
  });
});

describe("lstatOrNull", () => {
  test("returns stats for an existing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-utils-"));
    const file = join(dir, "f.txt");
    await writeFile(file, "hi");
    const stat = lstatOrNull(file);
    expect(stat?.isFile()).toBe(true);
  });

  test("returns null for a missing path", () => {
    expect(
      lstatOrNull(join(tmpdir(), "definitely-missing-xyz-123")),
    ).toBeNull();
  });
});

const TEST_SCOPE: MutationScope = { exempt: "test folder in the temp dir" };

describe("rmTreeWithRetries", () => {
  test("removes a populated tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-rmtree-"));
    const target = join(dir, "item");
    await mkdir(join(target, "nested"), { recursive: true });
    await writeFile(join(target, "nested", "f.txt"), "x");
    await rmTreeWithRetries(target, TEST_SCOPE);
    expect(existsSync(target)).toBe(false);
  });

  test("is a no-op for a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-rmtree-"));
    await rmTreeWithRetries(join(dir, "never-existed"), TEST_SCOPE);
  });

  test("succeeds when a denial clears during the retry window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-rmtree-"));
    const target = join(dir, "item");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "f.txt"), "x");
    await chmod(dir, 0o555);
    const unlock = (async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      await chmod(dir, 0o755);
    })();
    await rmTreeWithRetries(target, TEST_SCOPE);
    await unlock;
    expect(existsSync(target)).toBe(false);
  });

  test("throws the underlying error after retries are exhausted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-rmtree-"));
    const target = join(dir, "item");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "f.txt"), "x");
    await chmod(dir, 0o555);
    try {
      await expect(rmTreeWithRetries(target, TEST_SCOPE)).rejects.toMatchObject(
        {
          code: "EACCES",
        },
      );
      expect(existsSync(target)).toBe(true);
    } finally {
      await chmod(dir, 0o755);
    }
  });
});

describe("atomicWriteFile", () => {
  async function tmp(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "capshelf-atomic-"));
  }

  test("writes new content and leaves no temp file behind", async () => {
    const dir = await tmp();
    const target = join(dir, "lock.json");
    await atomicWriteFile(target, '{"ok":true}\n', TEST_SCOPE);
    expect(await readFile(target, "utf-8")).toBe('{"ok":true}\n');
    // The temp file is renamed into place, never left dangling.
    expect(await readdir(dir)).toEqual(["lock.json"]);
  });

  test("replaces existing content in place", async () => {
    const dir = await tmp();
    const target = join(dir, "manifest.json");
    await writeFile(target, "old");
    await atomicWriteFile(target, "new", TEST_SCOPE);
    expect(await readFile(target, "utf-8")).toBe("new");
    expect(await readdir(dir)).toEqual(["manifest.json"]);
  });

  test("writes byte content unchanged", async () => {
    const dir = await tmp();
    const target = join(dir, "blob.bin");
    const bytes = new Uint8Array([0, 1, 2, 200, 255]);
    await atomicWriteFile(target, bytes, TEST_SCOPE);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  test("a failed rename leaves no temp file behind", async () => {
    const dir = await tmp();
    const target = join(dir, "folder");
    await mkdir(target);
    await expect(atomicWriteFile(target, "x", TEST_SCOPE)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["folder"]);
  });

  /** A project root, a victim file outside it, and the planted temp names. */
  async function plantedWorld(count: number, pid = process.pid) {
    const project = await realpath(await tmp());
    const outside = await realpath(await tmp());
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "victim bytes\n");
    const target = join(project, "config.json");
    const planted: string[] = [];
    for (let index = 0; index < count; index++) {
      const name = `config.json.${pid}.${index}.tmp`;
      planted.push(name);
      await symlink(victim, join(project, name));
    }
    return { project, outside, victim, target, planted };
  }

  /** The victim keeps its bytes, every planted link stays, and nothing else. */
  async function expectConfined(
    w: Awaited<ReturnType<typeof plantedWorld>>,
    content: string,
  ) {
    expect(await readFile(w.victim, "utf-8")).toBe("victim bytes\n");
    expect(await readdir(w.outside)).toEqual(["victim.txt"]);
    expect((await lstat(w.target)).isFile()).toBe(true);
    expect(await readFile(w.target, "utf-8")).toBe(content);
    const names = (await readdir(w.project)).sort();
    expect(names).toEqual(["config.json", ...w.planted].sort());
    for (const name of w.planted) {
      const path = join(w.project, name);
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readlink(path)).toBe(w.victim);
    }
  }

  test("does not follow a symlink planted at the temp name", async () => {
    // The counter is module state. The range covers every value it can hold
    // in this test process, and the exclusive create refuses each one.
    const w = await plantedWorld(1024);
    await atomicWriteFile(w.target, "fresh\n", { root: w.project });
    await expectConfined(w, "fresh\n");
  });

  test("a fresh process does not follow a symlink at its first temp name", async () => {
    // The child starts with counter 0, so its first temp name is planted.
    const w = await plantedWorld(0);
    const count = 16;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "atomic-write-child.ts"),
        w.project,
        w.target,
        w.victim,
        String(count),
        "from child\n",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    for (let index = 0; index < count; index++) {
      w.planted.push(`config.json.${result.pid}.${index}.tmp`);
    }
    await expectConfined(w, "from child\n");
  });
});
