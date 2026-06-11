import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitignoreVisibleFiles } from "../src/gitignore";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("gitignoreVisibleFiles", () => {
  test("applies nested gitignore files only to their directory scope", async () => {
    const root = await tempDir("capshelf-gitignore-");

    await writeFile(join(root, ".gitignore"), "*.tmp\n!keep.tmp\n");
    await writeFile(join(root, "SKILL.md"), "skill\n");
    await writeFile(join(root, "discard.tmp"), "discard\n");
    await writeFile(join(root, "keep.tmp"), "keep\n");

    await mkdir(join(root, "scripts", ".venv"), { recursive: true });
    await writeFile(join(root, "scripts", ".gitignore"), ".venv/\n*.log\n");
    await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\n");
    await writeFile(join(root, "scripts", "debug.log"), "log\n");
    await writeFile(join(root, "scripts", ".venv", "pyvenv.cfg"), "venv\n");

    await mkdir(join(root, "other", ".venv"), { recursive: true });
    await writeFile(join(root, "other", ".venv", "pyvenv.cfg"), "venv\n");

    expect(await gitignoreVisibleFiles(root)).toEqual([
      ".gitignore",
      "SKILL.md",
      "keep.tmp",
      "other/.venv/pyvenv.cfg",
      "scripts/.gitignore",
      "scripts/run.sh",
    ]);
  });

  test("child gitignore can re-include a file ignored by a parent scope", async () => {
    const root = await tempDir("capshelf-gitignore-");

    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, "main.ts"), "export {};\n");
    await writeFile(join(root, "root.log"), "root\n");

    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", ".gitignore"), "!important.log\n");
    await writeFile(join(root, "logs", "important.log"), "keep\n");
    await writeFile(join(root, "logs", "debug.log"), "drop\n");

    expect(await gitignoreVisibleFiles(root)).toEqual([
      ".gitignore",
      "logs/.gitignore",
      "logs/important.log",
      "main.ts",
    ]);
  });
});
