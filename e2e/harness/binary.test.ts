import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BIN_ENV,
  resetResolvedBinary,
  resolveCapshelfBinary,
} from "../support/binary";
import { createWorld } from "../support/world";

const configured = process.env[BIN_ENV];

afterEach(() => {
  if (configured === undefined) delete process.env[BIN_ENV];
  else process.env[BIN_ENV] = configured;
  resetResolvedBinary();
});

async function expectRejection(value: string | undefined, needle: string) {
  resetResolvedBinary();
  if (value === undefined) delete process.env[BIN_ENV];
  else process.env[BIN_ENV] = value;
  await expect(resolveCapshelfBinary()).rejects.toThrow(needle);
}

test("an unset executable fails with the variable name", async () => {
  await expectRejection(undefined, BIN_ENV);
});

test("a relative executable path is refused", async () => {
  await expectRejection("dist/capshelf", "absolute path");
});

test("a source file is refused, so a run cannot mix packaged and source code", async () => {
  await expectRejection("/tmp/src/cli.ts", "compiled executable");
});

test("a missing executable is refused", async () => {
  await expectRejection("/tmp/capshelf-e2e-does-not-exist", "does not exist");
});

test("a non-executable file is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capshelf-e2e-bin-"));
  const path = join(dir, "capshelf");
  await writeFile(path, "not a binary");
  await chmod(path, 0o644);
  await expectRejection(path, "not executable");
});

test("a missing executable fails before any world exists", async () => {
  resetResolvedBinary();
  process.env[BIN_ENV] = "/tmp/capshelf-e2e-does-not-exist";
  await expect(createWorld("missing-binary")).rejects.toThrow("does not exist");
});
