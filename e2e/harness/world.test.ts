import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { rm, stat } from "node:fs/promises";
import {
  PATH_FLAVORS,
  createWorld,
  destroyWorld,
  withWorld,
} from "../support/world";

const originalKeep = process.env.KEEP_E2E_TMP;
const originalCapshelfHome = process.env.CAPSHELF_HOME;

afterEach(() => {
  if (originalKeep === undefined) delete process.env.KEEP_E2E_TMP;
  else process.env.KEEP_E2E_TMP = originalKeep;
  if (originalCapshelfHome === undefined) delete process.env.CAPSHELF_HOME;
  else process.env.CAPSHELF_HOME = originalCapshelfHome;
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("a child sees the world's home, not the developer's", async () => {
  await withWorld("isolated-home", async (world) => {
    const result = await world.run(world.stage, [
      "/bin/sh",
      "-c",
      "printf '%s\\n' \"$HOME\"",
    ]);
    expect(result.stdout.trim()).toBe(world.home);
    expect(result.stdout.trim()).not.toBe(process.env.HOME);
  });
});

test("product and runtime variables are not inherited", async () => {
  process.env.CAPSHELF_HOME = "/developer/shelf";
  await withWorld("no-ambient-inputs", async (world) => {
    const result = await world.run(world.stage, [
      "/bin/sh",
      "-c",
      'printf \'[%s][%s][%s]\\n\' "$CAPSHELF_HOME" "$CODEX_HOME" "$GIT_DIR"',
    ]);
    expect(result.stdout.trim()).toBe("[][][]");
    expect(world.env.CAPSHELF_HOME).toBeUndefined();
  });
});

test("a declared input reaches the child and nothing else does", async () => {
  await withWorld(
    "declared-input",
    async (world) => {
      const result = await world.run(world.stage, [
        "/bin/sh",
        "-c",
        "printf '%s\\n' \"$CAPSHELF_HOME\"",
      ]);
      expect(result.stdout.trim()).toBe("/declared/shelf");
    },
    { env: { CAPSHELF_HOME: "/declared/shelf" } },
  );
});

test("two worlds created at once use different paths", async () => {
  const [first, second] = await Promise.all([
    createWorld("parallel-a"),
    createWorld("parallel-b"),
  ]);
  try {
    expect(first.root).not.toBe(second.root);
    expect(await exists(first.root)).toBe(true);
    expect(await exists(second.root)).toBe(true);
  } finally {
    await destroyWorld(first);
    await destroyWorld(second);
  }
});

test("a successful world is removed", async () => {
  let root = "";
  await withWorld("cleanup", async (world) => {
    root = world.root;
    expect(await exists(root)).toBe(true);
  });
  expect(await exists(root)).toBe(false);
});

test("KEEP_E2E_TMP preserves a world for debugging", async () => {
  process.env.KEEP_E2E_TMP = "1";
  let root = "";
  await withWorld("preserved", async (world) => {
    root = world.root;
  });
  expect(await exists(root)).toBe(true);
  await rm(root, { recursive: true, force: true });
});

test("a failing world is described before it is removed", async () => {
  let root = "";
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    await expect(
      withWorld("described-failure", async (world) => {
        root = world.root;
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(written.join("")).toContain(root);
  expect(await exists(root)).toBe(false);
});

test("a path flavor puts the declared characters in the paths capshelf sees", async () => {
  await withWorld(
    "unicode-path",
    async (world) => {
      expect(world.stage.endsWith(PATH_FLAVORS.unicode)).toBe(true);
      const result = await world.run(world.stage, ["/bin/pwd"]);
      expect(result.stdout.trim()).toBe(world.stage);
    },
    { pathFlavor: "unicode" },
  );
});
