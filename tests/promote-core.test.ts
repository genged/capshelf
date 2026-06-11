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
import { syncTrackedIntoDataRepo } from "../src/commands/promote";
import { adoptIntoDataRepo } from "../src/data-repo-adopt";

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

  test("the not-dirty re-pin ignores a sidecar-only upstream commit", async () => {
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
    // a stale sha, so promote replaces (a no-op) and re-pins.
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

    expect(result.action).toBe("promoted");
    expect(result.committed).toBe(false);
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
