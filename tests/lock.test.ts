import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dataKey,
  emptyLock,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
  systemKey,
} from "../src/lock";
import { localLockPath, lockPath, rootLockPath } from "../src/paths";

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

    expect(JSON.parse(await readFile(lockPath(project), "utf-8"))).toEqual(
      lock,
    );
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

  test("loadLock falls back to a legacy root-level capshelf.lock.json", async () => {
    const project = await tempDir();
    const lock = {
      version: 2 as const,
      items: {
        [dataKey("skills", "hello")]: {
          source: "data" as const,
          sha: "abc123",
          sourceCommit: "deadbeef",
          appliedAt: "2026-05-08T00:00:00.000Z",
        },
      },
    };
    await writeFile(rootLockPath(project), JSON.stringify(lock));

    expect(await loadLock(project)).toEqual(lock);
  });

  test("loadLock prefers .capshelf/capshelf.lock.json over a root-level copy", async () => {
    const project = await tempDir();
    const entry = {
      source: "system" as const,
      sha: "abc123",
      cliVersion: "0.1.0",
      appliedAt: "2026-05-08T00:00:00.000Z",
    };
    const metadataLock = {
      version: 2 as const,
      items: { [systemKey("skills", "metadata-skill")]: entry },
    };
    const rootLock = {
      version: 2 as const,
      items: { [systemKey("skills", "root-skill")]: entry },
    };
    await writeFile(rootLockPath(project), JSON.stringify(rootLock));
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(lockPath(project), JSON.stringify(metadataLock));

    expect(await loadLock(project)).toEqual(metadataLock);
  });

  test("loadLock rejects malformed JSON instead of returning an empty lock", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(lockPath(project), "{ this is not json");

    // A corrupt lock must be a hard error: silently treating it as empty
    // would make capshelf think nothing is installed and re-apply everything.
    // The exact message is engine-specific JSON.parse output and does not
    // name the file, so only the error type is pinned here.
    await expect(loadLock(project)).rejects.toThrow(SyntaxError);
  });

  test("loadLock rejects data entries whose sourceCommit is not a hex object name", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      lockPath(project),
      JSON.stringify({
        version: 2,
        items: {
          // An option-like sourceCommit would otherwise reach the
          // `git show <rev>:<path>` argv, where `--output=...` writes an
          // attacker-chosen file. Reject it at load time.
          "data/mcp/x": {
            source: "data",
            sha: "abc123",
            sourceCommit: "--output=/tmp/pwned",
            appliedAt: "2026-05-08T00:00:00.000Z",
          },
        },
      }),
    );

    await expect(loadLock(project)).rejects.toThrow(/sourceCommit/);
  });

  test("loadLock rejects entries with an unknown source", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      lockPath(project),
      JSON.stringify({
        version: 2,
        items: {
          "data/skills/hello": {
            source: "registry",
            sha: "abc123",
            appliedAt: "2026-05-08T00:00:00.000Z",
          },
        },
      }),
    );

    // Zod's discriminated-union error names the offending entry path.
    await expect(loadLock(project)).rejects.toThrow(/data\/skills\/hello/);
    await expect(loadLock(project)).rejects.toThrow(/source/);
  });
});

describe("local lock", () => {
  test("loadLocalLock returns an empty lock when no local lock file exists", async () => {
    const project = await tempDir();

    expect(await loadLocalLock(project)).toEqual(emptyLock());
  });

  test("local lock round-trips via saveLocalLock without touching the shared lock", async () => {
    const project = await tempDir();
    const lock = {
      version: 2 as const,
      items: {
        [dataKey("skills", "hello")]: {
          source: "data" as const,
          sha: "abc123",
          sourceCommit: "deadbeef",
          appliedAt: "2026-05-08T00:00:00.000Z",
          local: true as const,
          localReason: "added with --local",
        },
      },
    };

    await saveLocalLock(project, lock);

    expect(await loadLocalLock(project)).toEqual(lock);
    expect(JSON.parse(await readFile(localLockPath(project), "utf-8"))).toEqual(
      lock,
    );
    // Local overrides live in their own file; the shared lock stays empty.
    expect(await loadLock(project)).toEqual(emptyLock());
  });

  test("loadLocalLock rejects a corrupt local lock instead of treating it as empty", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(localLockPath(project), "{ this is not json");

    // Only ENOENT maps to emptyLock(); a corrupt file must surface, otherwise
    // local overrides would silently desync.
    await expect(loadLocalLock(project)).rejects.toThrow(SyntaxError);
  });
});
