import { describe, expect, spyOn, test } from "bun:test";
import { $, file } from "bun";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dataEntriesMatch,
  dataEntryOrThrow,
  expectedAdoptionPath,
  refDisplay,
} from "../src/promote-core";
import { dataKey } from "../src/lock";
import type { DataLockEntry, Lock, LockEntry } from "../src/lock";
import { lastTouchingCommit, lastTouchingContentCommit } from "../src/git";
import { shaOfGitVisibleItem } from "../src/master";
import { shaOfInstalled } from "../src/installed";
import {
  promoteFragmentSource,
  syncTrackedIntoDataRepo,
} from "../src/commands/promote";
import { adoptIntoDataRepo } from "../src/data-repo-adopt";
import {
  lastTouchingFragmentCommit,
  shaOfFragmentItem,
} from "../src/fragments";
import { emptyManifest } from "../src/manifest";
import { PreconditionError } from "../src/errors";
import { upstreamFactsForItem } from "../src/upstream-facts";

const dataEntry: DataLockEntry = {
  source: "data",
  sha: "sha1",
  sourceCommit: "commit1",
  appliedAt: "t",
};

describe("dataEntriesMatch", () => {
  test("true when source, sha, and sourceCommit all match", () => {
    expect(
      dataEntriesMatch(dataEntry, { ...dataEntry, appliedAt: "other" }),
    ).toBe(true);
  });

  test("false when sha differs", () => {
    expect(dataEntriesMatch(dataEntry, { ...dataEntry, sha: "sha2" })).toBe(
      false,
    );
  });

  test("false when sourceCommit differs", () => {
    expect(
      dataEntriesMatch(dataEntry, { ...dataEntry, sourceCommit: "commit2" }),
    ).toBe(false);
  });
});

describe("dataEntryOrThrow", () => {
  test("returns the entry when it is a data entry", () => {
    expect(dataEntryOrThrow(dataEntry, "k")).toBe(dataEntry);
  });

  test("throws for a missing entry", () => {
    expect(() => dataEntryOrThrow(undefined, "skills:x")).toThrow(
      /expected data lock entry for skills:x/,
    );
  });

  test("throws for a system entry", () => {
    const system: LockEntry = {
      source: "system",
      sha: "s",
      cliVersion: "1.0.0",
      appliedAt: "t",
    };
    expect(() => dataEntryOrThrow(system, "k")).toThrow(
      /expected data lock entry/,
    );
  });
});

describe("expectedAdoptionPath", () => {
  test("skills under codex-compatible offers both the codex and claude paths", () => {
    const path = expectedAdoptionPath("/p", "skills", "x", "codex-compatible");
    expect(path).toContain(" or ");
    expect(path).toContain("x");
  });

  test("skills under claude-only points at a single install path", () => {
    const path = expectedAdoptionPath("/p", "skills", "x", "claude-only");
    expect(path).not.toContain(" or ");
    expect(path).toContain("x");
  });

  test("non-skill kinds point at the fixed install path (no item name)", () => {
    expect(
      expectedAdoptionPath("/p", "mcp", "x", "codex-compatible"),
    ).toContain(".mcp.json");
  });
});

async function tempRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

function lockWith(entry: DataLockEntry): Lock {
  return { version: 2, items: { [dataKey("skills", "hello")]: entry } };
}

describe("syncTrackedIntoDataRepo sidecar preservation", () => {
  test("preserves the data-repo sidecar when the project copy lacks one", async () => {
    const dataRepo = await tempRepo("capshelf-promote-sidecar-data-");
    const project = await tempRepo("capshelf-promote-sidecar-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [upstream]\n");
    await commitAll(dataRepo, "hello v1");
    const lockedSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");

    const lock = lockWith({
      source: "data",
      sha: lockedSha,
      sourceCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      {},
    );

    expect(result.action).toBe("promoted");
    expect(result.committed).toBe(true);
    expect(await file(join(dataItem, "SKILL.md")).text()).toBe(
      "hello v2 local edit\n",
    );
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [upstream]\n",
    );
    // The restored sidecar is byte-identical to HEAD, so the promote commit
    // did not touch it.
    const committedFiles =
      await $`git -C ${dataRepo} diff-tree --no-commit-id --name-only -r HEAD`
        .quiet()
        .text();
    expect(committedFiles).toContain("skills/hello/SKILL.md");
    expect(committedFiles).not.toContain(".capshelf.yml");
  });

  test("the project copy's sidecar wins when present", async () => {
    const dataRepo = await tempRepo("capshelf-promote-sidecar-data-");
    const project = await tempRepo("capshelf-promote-sidecar-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [upstream]\n");
    await commitAll(dataRepo, "hello v1");
    const lockedSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");
    await writeFile(join(installed, ".capshelf.yml"), "tags: [project]\n");

    const lock = lockWith({
      source: "data",
      sha: lockedSha,
      sourceCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      {},
    );

    expect(result.action).toBe("promoted");
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [project]\n",
    );
  });

  test("a sidecar-only upstream commit converges to already-upstream with the content pin", async () => {
    const dataRepo = await tempRepo("capshelf-promote-repin-data-");
    const project = await tempRepo("capshelf-promote-repin-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");
    const contentCommit = await lastTouchingCommit(dataRepo, "skills/hello");

    // A metadata-only commit moves the naive lastTouchingCommit.
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [a]\n");
    await commitAll(dataRepo, "sidecar only");
    expect(await lastTouchingCommit(dataRepo, "skills/hello")).not.toBe(
      contentCommit,
    );

    // The installed copy already matches upstream content, but the lock holds
    // a stale sha; promote converges (metadata-only lock repin, no commit)
    // and stays sidecar-blind: the recorded pin is the content commit.
    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2\n");

    const lock = lockWith({
      source: "data",
      sha: "stale-sha-000",
      sourceCommit: contentCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      {},
    );

    expect(result.action).toBe("already-upstream");
    expect(result.committed).toBe(false);
    expect(result.staleOverride).toBeUndefined();
    expect(result.sourceCommit).toBe(contentCommit);
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [a]\n",
    );
  });

  test("the filesystem snapshot sha ignores a project-authored sidecar (non-git project)", async () => {
    const dataRepo = await tempRepo("capshelf-promote-fs-sidecar-data-");
    // A non-git project forces installedSnapshot down the filesystem branch.
    const project = await mkdtemp(
      join(tmpdir(), "capshelf-promote-fs-sidecar-project-"),
    );
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const lockedSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");
    await writeFile(join(installed, ".capshelf.yml"), "tags: [authored]\n");

    const lock = lockWith({
      source: "data",
      sha: lockedSha,
      sourceCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      {},
    );

    expect(result.action).toBe("promoted");
    // The recorded lock sha is the sidecar-less sha: it equals both the
    // post-promote upstream sha and the installed-copy sha, so status stays
    // ok instead of reporting permanent drift.
    expect(result.sha).toBe(
      await shaOfGitVisibleItem(dataRepo, "skills/hello"),
    );
    expect(await shaOfInstalled(project, "skills", "hello")).toBe(result.sha);
    expect(lock.items[dataKey("skills", "hello")]?.sha).toBe(result.sha);
    // The authored sidecar still traveled up (the files list is unfiltered).
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [authored]\n",
    );
    // Re-promoting converges instead of looping on a tainted sha.
    const again = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      {},
    );
    expect(again.action).toBe("already-current");
  });
});

describe("adoptIntoDataRepo sidecar handling", () => {
  test("copies an authored project sidecar up and warns loudly", async () => {
    const dataRepo = await tempRepo("capshelf-adopt-sidecar-data-");
    const project = await tempRepo("capshelf-adopt-sidecar-project-");
    const installed = join(project, ".agents", "skills", "newskill");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "new skill\n");
    await writeFile(join(installed, ".capshelf.yml"), "tags: [authored]\n");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await adoptIntoDataRepo(
        project,
        dataRepo,
        "skills",
        "newskill",
        { installMode: "codex-compatible" },
      );
      expect(result.action).toBe("created");
      expect(
        await file(
          join(dataRepo, "skills", "newskill", ".capshelf.yml"),
        ).text(),
      ).toBe("tags: [authored]\n");
      const committedFiles =
        await $`git -C ${dataRepo} ls-tree -r --name-only HEAD`.quiet().text();
      expect(committedFiles).toContain("skills/newskill/.capshelf.yml");
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            "project copy contains .capshelf.yml — committed to data repo",
          ),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a malformed adopted sidecar warns and the adoption still succeeds", async () => {
    const dataRepo = await tempRepo("capshelf-adopt-malformed-data-");
    const project = await tempRepo("capshelf-adopt-malformed-project-");
    const installed = join(project, ".agents", "skills", "newskill");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "new skill\n");
    await writeFile(join(installed, ".capshelf.yml"), "tags: [unclosed\n");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await adoptIntoDataRepo(
        project,
        dataRepo,
        "skills",
        "newskill",
        { installMode: "codex-compatible" },
      );
      expect(result.action).toBe("created");
      expect(
        existsSync(join(dataRepo, "skills", "newskill", ".capshelf.yml")),
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes("invalid .capshelf.yml"),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("adoption without a sidecar prints no sidecar warning", async () => {
    const dataRepo = await tempRepo("capshelf-adopt-plain-data-");
    const project = await tempRepo("capshelf-adopt-plain-project-");
    const installed = join(project, ".agents", "skills", "newskill");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "new skill\n");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await adoptIntoDataRepo(
        project,
        dataRepo,
        "skills",
        "newskill",
        { installMode: "codex-compatible" },
      );
      expect(result.action).toBe("created");
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes(".capshelf.yml"),
        ),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("refDisplay", () => {
  test("includes the kind when present", () => {
    expect(refDisplay({ kind: "skills", name: "x" })).toBe("skills/x");
  });

  test("omits the kind when absent", () => {
    expect(refDisplay({ name: "x" })).toBe("x");
  });
});

async function staleFixture(): Promise<{
  dataRepo: string;
  project: string;
  lock: Lock;
  lockedSha: string;
  upstreamCommit: string;
  upstreamSha: string;
}> {
  const dataRepo = await tempRepo("capshelf-stale-data-");
  const project = await tempRepo("capshelf-stale-project-");
  const dataItem = join(dataRepo, "skills", "hello");
  await mkdir(dataItem, { recursive: true });
  await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
  await commitAll(dataRepo, "hello v1");
  const lockedSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");
  const lockedCommit = await lastTouchingContentCommit(
    dataRepo,
    "skills/hello",
  );

  // Upstream advances past the lock (teammate promoted + pushed).
  await writeFile(join(dataItem, "SKILL.md"), "hello v2 from teammate\n");
  await commitAll(dataRepo, "hello v2 upstream");
  const upstreamCommit = await lastTouchingContentCommit(
    dataRepo,
    "skills/hello",
  );
  const upstreamSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");

  // This project edited from the old base without updating first.
  const installed = join(project, ".agents", "skills", "hello");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");

  const lock = lockWith({
    source: "data",
    sha: lockedSha,
    sourceCommit: lockedCommit,
    appliedAt: "2026-06-01T00:00:00.000Z",
    label: "v1",
  });
  return { dataRepo, project, lock, lockedSha, upstreamCommit, upstreamSha };
}

describe("stale-promote guard (copy items)", () => {
  test("blocks when upstream is clean and advanced past the lock", async () => {
    const f = await staleFixture();
    const headBefore = await $`git -C ${f.dataRepo} rev-parse HEAD`
      .quiet()
      .text();
    let error: unknown;
    try {
      await syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        {},
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain(
      "changed in the data repo since this project last updated",
    );
    expect((error as Error).message).toContain("--stale-ok");
    expect((error as Error).message).toContain("capshelf update skills/hello");
    expect((error as Error).message).toContain("status skills/hello --diff");
    // Nothing was written or committed.
    expect(
      await file(join(f.dataRepo, "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello v2 from teammate\n");
    expect(await $`git -C ${f.dataRepo} rev-parse HEAD`.quiet().text()).toBe(
      headBefore,
    );
    expect(f.lock.items[dataKey("skills", "hello")]?.sha).toBe(f.lockedSha);
  });

  test("--stale-ok bypasses the committed-advance case and records the override", async () => {
    const f = await staleFixture();
    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      { staleOk: true },
    );
    expect(result.action).toBe("promoted");
    expect(result.committed).toBe(true);
    expect(result.staleOverride).toBe(true);
    expect(
      await file(join(f.dataRepo, "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello v2 local edit\n");
    expect(f.lock.items[dataKey("skills", "hello")]?.sha).toBe(result.sha);
  });

  test("staleOverride is absent when --stale-ok is passed but nothing is stale", async () => {
    const dataRepo = await tempRepo("capshelf-not-stale-data-");
    const project = await tempRepo("capshelf-not-stale-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");
    const lock = lockWith({
      source: "data",
      sha: await shaOfGitVisibleItem(dataRepo, "skills/hello"),
      sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
      appliedAt: "2026-06-01T00:00:00.000Z",
    });

    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      { staleOk: true },
    );
    expect(result.action).toBe("promoted");
    expect(result.staleOverride).toBeUndefined();
  });

  test("a dirty data-repo item path blocks even with --stale-ok and survives", async () => {
    const f = await staleFixture();
    await writeFile(
      join(f.dataRepo, "skills", "hello", "SKILL.md"),
      "uncommitted upstream edit\n",
    );
    for (const staleOk of [false, true]) {
      let error: unknown;
      try {
        await syncTrackedIntoDataRepo(
          f.project,
          f.dataRepo,
          "skills",
          "hello",
          f.lock,
          { staleOk },
        );
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(PreconditionError);
      expect((error as Error).message).toContain("uncommitted changes");
      expect((error as Error).message).toContain(
        "status --short -- skills/hello",
      );
    }
    // The uncommitted data-repo edit survives untouched.
    expect(
      await file(join(f.dataRepo, "skills", "hello", "SKILL.md")).text(),
    ).toBe("uncommitted upstream edit\n");
  });

  test("convergence: byte-identical content re-pins without a commit", async () => {
    const f = await staleFixture();
    // The project's edit happens to match what upstream already has.
    await writeFile(
      join(f.project, ".agents", "skills", "hello", "SKILL.md"),
      "hello v2 from teammate\n",
    );
    const headBefore = await $`git -C ${f.dataRepo} rev-parse HEAD`
      .quiet()
      .text();

    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      {},
    );

    expect(result.action).toBe("already-upstream");
    expect(result.committed).toBe(false);
    expect(result.staleOverride).toBeUndefined();
    expect(result.sha).toBe(f.upstreamSha);
    expect(result.sourceCommit).toBe(f.upstreamCommit);
    // No commit was created and the data repo content is untouched.
    expect(await $`git -C ${f.dataRepo} rev-parse HEAD`.quiet().text()).toBe(
      headBefore,
    );
    // The repin writes a complete DataLockEntry: fresh appliedAt, kept label.
    const entry = f.lock.items[dataKey("skills", "hello")];
    expect(entry).toEqual({
      source: "data",
      sha: f.upstreamSha,
      sourceCommit: f.upstreamCommit,
      appliedAt: expect.any(String),
      label: "v1",
    });
    expect(entry?.appliedAt).not.toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("stale-promote guard (fragments)", () => {
  async function fragmentStaleFixture(): Promise<{
    dataRepo: string;
    project: string;
    lock: Lock;
    lockedSha: string;
  }> {
    const dataRepo = await tempRepo("capshelf-frag-stale-data-");
    const project = await tempRepo("capshelf-frag-stale-project-");
    const source = join(dataRepo, "settings", "theme");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ theme: "v1" }),
    );
    await commitAll(dataRepo, "theme v1");
    const lockedSha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    const lockedCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const lock: Lock = {
      version: 2,
      items: {
        [dataKey("settings", "theme")]: {
          source: "data",
          sha: lockedSha,
          sourceCommit: lockedCommit,
          appliedAt: "2026-06-01T00:00:00.000Z",
        },
      },
    };
    return { dataRepo, project, lock, lockedSha };
  }

  test("the dirty branch blocks when HEAD advanced past the lock", async () => {
    const f = await fragmentStaleFixture();
    const source = join(f.dataRepo, "settings", "theme", "settings.json");
    // Upstream advance committed past the lock...
    await writeFile(source, JSON.stringify({ theme: "v2-upstream" }));
    await commitAll(f.dataRepo, "theme v2 upstream");
    // ...plus dirty local edits in the canonical source.
    await writeFile(source, JSON.stringify({ theme: "v3-dirty" }));

    const headBefore = await $`git -C ${f.dataRepo} rev-parse HEAD`
      .quiet()
      .text();
    let error: unknown;
    try {
      await promoteFragmentSource(
        f.project,
        f.dataRepo,
        { ...emptyManifest(), settings: ["theme"] },
        f.lock,
        "settings",
        "theme",
        {},
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain(
      "changed in the data repo since this project last updated",
    );
    expect(await $`git -C ${f.dataRepo} rev-parse HEAD`.quiet().text()).toBe(
      headBefore,
    );
    expect(f.lock.items[dataKey("settings", "theme")]?.sha).toBe(f.lockedSha);

    // --stale-ok bypasses it and records the override.
    const result = await promoteFragmentSource(
      f.project,
      f.dataRepo,
      { ...emptyManifest(), settings: ["theme"] },
      f.lock,
      "settings",
      "theme",
      { staleOk: true },
    );
    expect(result.action).toBe("promoted");
    expect(result.committed).toBe(true);
    expect(result.staleOverride).toBe(true);
  });

  test("a dirty promote with HEAD still at the lock stays clean of overrides", async () => {
    const f = await fragmentStaleFixture();
    await writeFile(
      join(f.dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "v2-local" }),
    );
    const result = await promoteFragmentSource(
      f.project,
      f.dataRepo,
      { ...emptyManifest(), settings: ["theme"] },
      f.lock,
      "settings",
      "theme",
      {},
    );
    expect(result.action).toBe("promoted");
    expect(result.staleOverride).toBeUndefined();
  });

  test("the clean-path committed-changes check is not bypassable by --stale-ok", async () => {
    const f = await fragmentStaleFixture();
    await writeFile(
      join(f.dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "v2-upstream" }),
    );
    await commitAll(f.dataRepo, "theme v2 upstream");

    await expect(
      promoteFragmentSource(
        f.project,
        f.dataRepo,
        { ...emptyManifest(), settings: ["theme"] },
        f.lock,
        "settings",
        "theme",
        { staleOk: true },
      ),
    ).rejects.toThrow(/run capshelf update settings\/theme/);
  });
});

describe("upstreamFactsForItem", () => {
  test("returns the clean sha, the dirty flag, and missing-item nulls", async () => {
    const dataRepo = await tempRepo("capshelf-upstream-facts-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");

    expect(await upstreamFactsForItem(dataRepo, "skills", "hello")).toEqual({
      upstreamSha: await shaOfGitVisibleItem(dataRepo, "skills/hello"),
      upstreamDirty: false,
    });

    await writeFile(join(dataItem, "SKILL.md"), "dirty\n");
    expect(await upstreamFactsForItem(dataRepo, "skills", "hello")).toEqual({
      upstreamSha: null,
      upstreamDirty: true,
    });

    expect(await upstreamFactsForItem(dataRepo, "skills", "absent")).toEqual({
      upstreamSha: null,
      upstreamDirty: false,
    });
  });

  test("fragments: dirty canonical sources flag dirty, clean ones hash", async () => {
    const dataRepo = await tempRepo("capshelf-upstream-facts-frag-");
    const source = join(dataRepo, "settings", "theme");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme");

    expect(await upstreamFactsForItem(dataRepo, "settings", "theme")).toEqual({
      upstreamSha: await shaOfFragmentItem(dataRepo, "settings", "theme"),
      upstreamDirty: false,
    });

    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ theme: "light" }),
    );
    expect(await upstreamFactsForItem(dataRepo, "settings", "theme")).toEqual({
      upstreamSha: null,
      upstreamDirty: true,
    });
  });
});
