import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLock, saveLock, systemKey } from "../src/lock";
import { lockPath } from "../src/paths";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-lock-"));
}

describe("lock schema", () => {
  test("saveLock writes the canonical lock path and loadLock reads it", async () => {
    const project = await tempDir();
    const lock = {
      version: 2 as const,
      items: {
        [systemKey("skills", "capshelf")]: {
          source: "system" as const,
          sha: "abc123",
          cliVersion: "0.1.0",
          appliedAt: "2026-05-08T00:00:00.000Z",
        },
      },
    };

    await saveLock(project, lock);

    expect(JSON.parse(await readFile(lockPath(project), "utf-8"))).toEqual(lock);
    expect(await loadLock(project)).toEqual(lock);
  });

  test("loadLock rejects legacy v1 locks", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      lockPath(project),
      JSON.stringify({
        version: 1,
        items: {
          "skills/hello": {
            sha: "abc123",
            appliedAt: "2026-05-08T00:00:00.000Z",
          },
        },
      }),
    );

    await expect(loadLock(project)).rejects.toThrow(/version/);
  });
});
