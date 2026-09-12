import { expect, test } from "bun:test";
import { z } from "zod";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Git measurement counts repeated batch requests separately from spawns", async () => {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-measure-"));
  try {
    const init = Bun.spawnSync(["git", "init", "-q", repo]);
    expect(init.exitCode).toBe(0);
    const blob = Bun.spawnSync(
      ["git", "-C", repo, "hash-object", "-w", "--stdin"],
      { stdin: Buffer.from("measurement") },
    );
    expect(blob.exitCode).toBe(0);
    const id = blob.stdout.toString().trim();
    const script = `import { catFileBlobs } from ${JSON.stringify(resolve("src/git.ts"))};
      await catFileBlobs(${JSON.stringify(repo)}, [${JSON.stringify(id)}, ${JSON.stringify(id)}]);
      await catFileBlobs(${JSON.stringify(repo)}, [${JSON.stringify(id)}]);
      await catFileBlobs(${JSON.stringify(repo)}, ["${"0".repeat(40)}"]).catch(() => {});`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, CAPSHELF_GIT_MEASURE: "1" },
    });
    expect(result.exitCode).toBe(0);
    const records = result.stderr
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.includes('"type":"git-summary"'));
    const summary = z
      .object({
        totalSpawns: z.number(),
        spawns: z.record(z.number()),
        operations: z.record(
          z.object({
            successful: z.number(),
            distinct: z.number(),
            failed: z.number(),
          }),
        ),
      })
      .parse(JSON.parse(records[0]!));
    expect(summary.totalSpawns).toBe(4);
    expect(summary.spawns["cat-file --batch"]).toBe(3);
    expect(summary.operations["batch-blob"]).toEqual({
      successful: 3,
      distinct: 1,
      failed: 1,
    });
    expect(result.stderr.toString()).not.toContain("measurement");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("Git measurement omits write and network arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capshelf-measure-private-"));
  try {
    const executable = join(dir, "git");
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.55.0"; fi\nexit 0\n',
    );
    await chmod(executable, 0o755);
    const script = `import { cloneRepository, sourceWrite, sourceRead } from ${JSON.stringify(resolve("src/git.ts"))};
      await cloneRepository(${JSON.stringify(dir)}, "https://user:private-token@example.invalid/repo", "destination");
      await sourceWrite(${JSON.stringify(dir)}, ["config", "http.extraHeader", "Authorization: private-header"]);
      await sourceRead(${JSON.stringify(dir)}, ["show", "${"a".repeat(40)}:canonical.json"]);`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, PATH: dir, CAPSHELF_GIT_MEASURE: "1" },
    });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).not.toContain("private-token");
    expect(stderr).not.toContain("private-header");
    expect(stderr).not.toContain("example.invalid");
    expect(stderr).toContain('"operation":"clone"');
    expect(stderr).toContain("canonical.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
