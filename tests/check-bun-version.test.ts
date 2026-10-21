import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./cli-fixtures";

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-bun-version.ts");

async function run(packageManager: string, anyBun?: string) {
  const dir = await tempDir("capshelf-bun-version-");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", packageManager }),
  );
  // The developer's own CAPSHELF_ANY_BUN must not leak into a case.
  const { CAPSHELF_ANY_BUN: _inherited, ...inherited } = process.env;
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT],
    cwd: dir,
    env:
      anyBun === undefined
        ? inherited
        : { ...inherited, CAPSHELF_ANY_BUN: anyBun },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("check-bun-version", () => {
  test("passes silently on the declared Bun", async () => {
    const result = await run(`bun@${Bun.version}`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("stops on another Bun and names both versions and the fix", async () => {
    const result = await run("bun@0.0.1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `this is Bun ${Bun.version}, and package.json declares Bun 0.0.1.`,
    );
    expect(result.stderr).toContain("npx -y bun@0.0.1 run <script>");
    expect(result.stderr).toContain('bash -s "bun-v0.0.1"');
    expect(result.stderr).toContain("CAPSHELF_ANY_BUN=1");
  });

  test("lets another Bun through when CAPSHELF_ANY_BUN=1", async () => {
    const result = await run("bun@0.0.1", "1");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("continuing because CAPSHELF_ANY_BUN=1");
  });

  test("treats any other CAPSHELF_ANY_BUN value as unset", async () => {
    const result = await run("bun@0.0.1", "");
    expect(result.exitCode).toBe(1);
  });

  test("stops on a packageManager that does not declare a Bun version", async () => {
    const result = await run("pnpm@9.0.0");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot read the declared Bun");
    expect(result.stderr).toContain("packageManager");
  });
});
