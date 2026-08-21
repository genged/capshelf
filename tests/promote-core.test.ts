import { describe, expect, spyOn, test } from "bun:test";
import { $, file } from "bun";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dataEntriesMatch,
  dataEntryOrThrow,
  expectedAdoptionPath,
} from "../src/promote-core";
import { dataKey } from "../src/lock";
import type {
  DataLockEntry,
  DataLockEntryV4,
  Lock,
  LockEntry,
  LockV4,
} from "../src/lock";
import {
  headSha,
  lastTouchingCommit,
  lastTouchingContentCommit,
} from "../src/git";
import { currentPinDigest, installedPinDigestFor } from "./pin-fixtures";
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
  sourcePinDigest: "a".repeat(64),
  sourceCommit: "c".repeat(40),
  appliedAt: "t",
};

describe("dataEntriesMatch", () => {
  test("true when source, sha, and sourceCommit all match", () => {
    expect(
      dataEntriesMatch(dataEntry, { ...dataEntry, appliedAt: "other" }),
    ).toBe(true);
  });

  test("false when sha differs", () => {
    expect(
      dataEntriesMatch(dataEntry, {
        ...dataEntry,
        sourcePinDigest: "b".repeat(64),
      }),
    ).toBe(false);
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
    expect(expectedAdoptionPath("/p", "skills", "x", "codex-compatible")).toBe(
      "/p/.agents/skills/x or /p/.claude/skills/x",
    );
  });

  test("skills under claude-only points at a single install path", () => {
    expect(expectedAdoptionPath("/p", "skills", "x", "claude-only")).toBe(
      "/p/.claude/skills/x",
    );
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

function lockWith(entry: DataLockEntryV4): LockV4 {
  return { version: 4, items: { [dataKey("skills", "hello")]: entry } };
}

async function promotionSafetyFixture(prefix: string): Promise<{
  dataRepo: string;
  project: string;
  dataItem: string;
  installed: string;
  lock: LockV4;
  headBefore: string;
  indexBefore: Buffer;
  lockBefore: LockV4;
}> {
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const project = await tempRepo(`${prefix}-project-`);
  const dataItem = join(dataRepo, "skills", "hello");
  await mkdir(dataItem, { recursive: true });
  await writeFile(join(dataItem, "SKILL.md"), "canonical\n");
  await writeFile(join(dataItem, "guide.md"), "keep me\n");
  await writeFile(join(dataItem, ".capshelf.yml"), "tags: [safe]\n");
  await commitAll(dataRepo, "canonical skill");

  const installed = join(project, ".agents", "skills", "hello");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "local edit\n");
  await writeFile(join(installed, "guide.md"), "local guide\n");

  const lock = lockWith({
    source: "data",
    sourcePinDigest: await currentPinDigest(dataRepo, "skills", "hello"),
    sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
    appliedAt: "2026-08-01T00:00:00.000Z",
  });
  return {
    dataRepo,
    project,
    dataItem,
    installed,
    lock,
    headBefore: await headSha(dataRepo),
    indexBefore: await readFile(join(dataRepo, ".git", "index")),
    lockBefore: structuredClone(lock),
  };
}

async function expectCanonicalPromotionStateUnchanged(
  fixture: Awaited<ReturnType<typeof promotionSafetyFixture>>,
): Promise<void> {
  expect(await headSha(fixture.dataRepo)).toBe(fixture.headBefore);
  expect(
    (await readFile(join(fixture.dataRepo, ".git", "index"))).equals(
      fixture.indexBefore,
    ),
  ).toBe(true);
  expect(
    (
      await $`git -C ${fixture.dataRepo} status --porcelain`.quiet().text()
    ).trim(),
  ).toBe("");
  expect(await file(join(fixture.dataItem, "SKILL.md")).text()).toBe(
    "canonical\n",
  );
  expect(await file(join(fixture.dataItem, "guide.md")).text()).toBe(
    "keep me\n",
  );
  expect(await file(join(fixture.dataItem, ".capshelf.yml")).text()).toBe(
    "tags: [safe]\n",
  );
  expect(fixture.lock).toEqual(fixture.lockBefore);
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
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");

    const lock = lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
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
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
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
      sourcePinDigest: lockedSha,
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
      sourcePinDigest: "stale-sha-000",
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
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
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
      sourcePinDigest: lockedSha,
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
      await currentPinDigest(dataRepo, "skills", "hello"),
    );
    expect(
      await installedPinDigestFor(project, dataRepo, "skills", "hello"),
    ).toBe(result.sha);
    expect(
      dataEntryOrThrow(lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(result.sha);
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

describe("syncTrackedIntoDataRepo promotion safety", () => {
  test("rejects a non-regular required entrypoint without changing canonical state", async () => {
    const fixture = await promotionSafetyFixture("capshelf-promote-entrypoint");
    await rm(join(fixture.installed, "SKILL.md"));
    await mkdir(join(fixture.installed, "SKILL.md"));
    await writeFile(
      join(fixture.installed, "SKILL.md", "nested.md"),
      "not an entrypoint\n",
    );

    await expect(
      syncTrackedIntoDataRepo(
        fixture.project,
        fixture.dataRepo,
        "skills",
        "hello",
        fixture.lock,
        {},
      ),
    ).rejects.toThrow(/required SKILL\.md is missing or not a regular file/);

    await expectCanonicalPromotionStateUnchanged(fixture);
  });

  test("rejects snapshot races and rolls back canonical state", async () => {
    const scenarios = [
      {
        name: "after snapshot capture",
        hook: "afterSnapshotCaptured",
        error: /installed snapshot changed while it was being read/,
      },
      {
        // The refusal moved but did not weaken. This used to be caught by a
        // destination-side hash of the data repo worktree taken after the
        // copy; PIN-11 removed that check because it compared one working-tree
        // hash against another and a `pre-commit` hook could change both. The
        // race is now caught by the post-copy installed-snapshot comparison
        // before anything is committed, and by `A == B` after it.
        name: "before canonical copy",
        hook: "beforeCanonicalCopy",
        error: /installed snapshot changed during promotion/,
      },
      {
        name: "after canonical copy",
        hook: "afterCanonicalCopy",
        error: /installed snapshot changed during promotion/,
      },
    ] as const;

    for (const scenario of scenarios) {
      const fixture = await promotionSafetyFixture(
        `capshelf-promote-race-${scenario.hook}`,
      );
      const changedContent = `changed ${scenario.name}\n`;
      const mutateInstalled = async () => {
        await writeFile(join(fixture.installed, "SKILL.md"), changedContent);
      };
      const snapshotHooks =
        scenario.hook === "afterSnapshotCaptured"
          ? { afterSnapshotCaptured: mutateInstalled }
          : scenario.hook === "beforeCanonicalCopy"
            ? { beforeCanonicalCopy: mutateInstalled }
            : { afterCanonicalCopy: mutateInstalled };

      await expect(
        syncTrackedIntoDataRepo(
          fixture.project,
          fixture.dataRepo,
          "skills",
          "hello",
          fixture.lock,
          { snapshotHooks },
        ),
      ).rejects.toThrow(scenario.error);

      await expectCanonicalPromotionStateUnchanged(fixture);
      expect(await file(join(fixture.installed, "SKILL.md")).text()).toBe(
        changedContent,
      );
    }
  });

  test("an ignored installed skill cannot delete the canonical skill", async () => {
    const dataRepo = await tempRepo("capshelf-promote-ignored-data-");
    const project = await tempRepo("capshelf-promote-ignored-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "canonical\n");
    await writeFile(join(dataItem, "guide.md"), "keep me\n");
    await commitAll(dataRepo, "canonical skill");

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "ignored local edit\n");
    await writeFile(join(project, ".gitignore"), ".agents/skills/hello/\n");

    const lock = lockWith({
      source: "data",
      sourcePinDigest: await currentPinDigest(dataRepo, "skills", "hello"),
      sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
      appliedAt: "2026-08-01T00:00:00.000Z",
    });
    const headBefore = await headSha(dataRepo);
    const indexBefore = await readFile(join(dataRepo, ".git", "index"));
    const lockBefore = structuredClone(lock);

    await expect(
      syncTrackedIntoDataRepo(project, dataRepo, "skills", "hello", lock, {}),
    ).rejects.toThrow(/required SKILL\.md is not Git-visible/);

    expect(await headSha(dataRepo)).toBe(headBefore);
    expect(await readFile(join(dataRepo, ".git", "index"))).toEqual(
      indexBefore,
    );
    expect(
      (await $`git -C ${dataRepo} status --porcelain`.quiet().text()).trim(),
    ).toBe("");
    expect(await file(join(dataItem, "SKILL.md")).text()).toBe("canonical\n");
    expect(await file(join(dataItem, "guide.md")).text()).toBe("keep me\n");
    expect(lock).toEqual(lockBefore);
  });

  test("a rejected commit restores the canonical skill and index", async () => {
    const dataRepo = await tempRepo("capshelf-promote-hook-data-");
    const project = await tempRepo("capshelf-promote-hook-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "canonical\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [safe]\n");
    await commitAll(dataRepo, "canonical skill");

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local edit\n");

    const lock = lockWith({
      source: "data",
      sourcePinDigest: await currentPinDigest(dataRepo, "skills", "hello"),
      sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
      appliedAt: "2026-08-01T00:00:00.000Z",
    });
    const hook = join(dataRepo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const headBefore = await headSha(dataRepo);
    const indexBefore = await readFile(join(dataRepo, ".git", "index"));
    const lockBefore = structuredClone(lock);

    await expect(
      syncTrackedIntoDataRepo(project, dataRepo, "skills", "hello", lock, {}),
    ).rejects.toThrow();

    expect(await headSha(dataRepo)).toBe(headBefore);
    expect(await readFile(join(dataRepo, ".git", "index"))).toEqual(
      indexBefore,
    );
    expect(
      (await $`git -C ${dataRepo} status --porcelain`.quiet().text()).trim(),
    ).toBe("");
    expect(await file(join(dataItem, "SKILL.md")).text()).toBe("canonical\n");
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [safe]\n",
    );
    expect(lock).toEqual(lockBefore);
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

async function staleFixture(): Promise<{
  dataRepo: string;
  project: string;
  lock: LockV4;
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
  const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
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
  const upstreamSha = await currentPinDigest(dataRepo, "skills", "hello");

  // This project edited from the old base without updating first.
  const installed = join(project, ".agents", "skills", "hello");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "hello v2 local edit\n");

  const lock = lockWith({
    source: "data",
    sourcePinDigest: lockedSha,
    sourceCommit: lockedCommit,
    appliedAt: "2026-06-01T00:00:00.000Z",
    label: "v1",
  });
  return { dataRepo, project, lock, lockedSha, upstreamCommit, upstreamSha };
}

async function subsumedMergeFixture(): Promise<{
  dataRepo: string;
  project: string;
  lock: LockV4;
  installed: string;
  lockedCommit: string;
  upstreamCommit: string;
  upstreamSha: string;
}> {
  const dataRepo = await tempRepo("capshelf-subsumed-data-");
  const project = await tempRepo("capshelf-subsumed-project-");
  const dataItem = join(dataRepo, "skills", "hello");
  await mkdir(dataItem, { recursive: true });
  await writeFile(join(dataItem, "SKILL.md"), "base\n");
  await writeFile(join(dataItem, "local.txt"), "value=base\n");
  await writeFile(join(dataItem, "upstream.txt"), "value=base\n");
  await commitAll(dataRepo, "base");
  const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
  const lockedCommit = await lastTouchingContentCommit(
    dataRepo,
    "skills/hello",
  );
  await writeFile(join(dataItem, "local.txt"), "value=local\n");
  await writeFile(join(dataItem, "upstream.txt"), "value=upstream\n");
  await commitAll(dataRepo, "upstream subsumes local");
  const upstreamCommit = await lastTouchingContentCommit(
    dataRepo,
    "skills/hello",
  );
  const upstreamSha = await currentPinDigest(dataRepo, "skills", "hello");
  const installedDir = join(project, ".agents", "skills", "hello");
  const installed = join(installedDir, "local.txt");
  await mkdir(installedDir, {
    recursive: true,
  });
  await writeFile(join(installedDir, "SKILL.md"), "base\n");
  await writeFile(installed, "value=local\n");
  await writeFile(join(installedDir, "upstream.txt"), "value=base\n");
  return {
    dataRepo,
    project,
    lock: lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
      sourceCommit: lockedCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
      label: "v1",
    }),
    installed,
    lockedCommit,
    upstreamCommit,
    upstreamSha,
  };
}

async function disjointMergeFixture(prefix: string): Promise<{
  dataRepo: string;
  project: string;
  dataItem: string;
  installed: string;
  lock: LockV4;
  lockedCommit: string;
  upstreamHead: string;
}> {
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const project = await tempRepo(`${prefix}-project-`);
  const dataItem = join(dataRepo, "skills", "hello");
  await mkdir(dataItem, { recursive: true });
  await writeFile(join(dataItem, "SKILL.md"), "base\n");
  await commitAll(dataRepo, "base");
  const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
  const lockedCommit = await lastTouchingContentCommit(
    dataRepo,
    "skills/hello",
  );
  await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
  await commitAll(dataRepo, "upstream");
  const upstreamHead = await headSha(dataRepo);
  const installed = join(project, ".agents", "skills", "hello");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "base\n");
  await writeFile(join(installed, "local.txt"), "local\n");
  return {
    dataRepo,
    project,
    dataItem,
    installed,
    lock: lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
      sourceCommit: lockedCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    }),
    lockedCommit,
    upstreamHead,
  };
}

describe("stale-promote guard (copy items)", () => {
  test("--merge carries a tracked local deletion into data and installed trees", async () => {
    const dataRepo = await tempRepo("capshelf-merge-delete-data-");
    const project = await tempRepo("capshelf-merge-delete-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await writeFile(join(dataItem, "delete.txt"), "remove me\n");
    await commitAll(dataRepo, "base");
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
    const lockedCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );
    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream add");

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "base\n");
    await writeFile(join(installed, "delete.txt"), "remove me\n");
    await commitAll(project, "installed base");
    await rm(join(installed, "delete.txt"));
    const lock = lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
      sourceCommit: lockedCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });

    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      { merge: true },
    );

    expect(result.merged).toBe(true);
    expect(result.committed).toBe(true);
    expect(existsSync(join(dataItem, "delete.txt"))).toBe(false);
    expect(existsSync(join(installed, "delete.txt"))).toBe(false);
    expect(await file(join(dataItem, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
    expect(await file(join(installed, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
  });

  test("--merge combines disjoint local and upstream edits into one commit", async () => {
    const dataRepo = await tempRepo("capshelf-merge-data-");
    const project = await tempRepo("capshelf-merge-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [base]\n");
    await commitAll(dataRepo, "base");
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
    const lockedCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/hello",
    );
    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [upstream]\n");
    await commitAll(dataRepo, "upstream");
    const upstreamHead = await headSha(dataRepo);

    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "base\n");
    await writeFile(join(installed, "local.txt"), "local\n");
    await writeFile(join(installed, ".capshelf.yml"), "tags: [local]\n");
    await writeFile(join(project, ".gitignore"), ".venv/\n");
    await mkdir(join(installed, ".venv"));
    await writeFile(join(installed, ".venv", "generated.txt"), "generated\n");
    const lock = lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
      sourceCommit: lockedCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
      label: "v1",
    });
    const originalEntry = structuredClone(
      lock.items[dataKey("skills", "hello")]!,
    );

    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      { merge: true },
    );

    expect(result.merged).toBe(true);
    expect(result.mergeBase).toBe(lockedCommit);
    expect(result.mergedUpstreamCommit).toBe(upstreamHead);
    expect(result.committed).toBe(true);
    expect(result.staleOverride).toBeUndefined();
    expect(await file(join(dataItem, "local.txt")).text()).toBe("local\n");
    expect(await file(join(dataItem, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
    expect(await file(join(dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [local]\n",
    );
    expect(await file(join(installed, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
    expect(await file(join(installed, ".venv", "generated.txt")).text()).toBe(
      "generated\n",
    );
    expect(existsSync(join(dataItem, ".venv"))).toBe(false);
    expect((await $`git -C ${dataRepo} status --porcelain`.text()).trim()).toBe(
      "",
    );
    expect(
      (await $`git -C ${dataRepo} rev-list --parents -n 1 HEAD`.text())
        .trim()
        .split(" "),
    ).toHaveLength(2);
    expect(
      dataEntryOrThrow(lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(result.sha);

    const mergedHead = await headSha(dataRepo);
    lock.items[dataKey("skills", "hello")] = originalEntry;
    await rm(join(installed, "upstream.txt"));
    const retry = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      { merge: true, persistLock: async () => {} },
    );
    expect(retry.action).toBe("already-upstream");
    expect(retry.merged).toBe(true);
    expect(retry.committed).toBe(false);
    expect(await headSha(dataRepo)).toBe(mergedHead);
  });

  test("--merge preserves an upstream sidecar without copying it into the installed item", async () => {
    const f = await disjointMergeFixture("capshelf-merge-sidecar");
    await writeFile(join(f.dataItem, ".capshelf.yml"), "tags: [upstream]\n");
    await commitAll(f.dataRepo, "upstream metadata");

    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      { merge: true },
    );

    expect(result.merged).toBe(true);
    expect(await file(join(f.dataItem, ".capshelf.yml")).text()).toBe(
      "tags: [upstream]\n",
    );
    expect(existsSync(join(f.installed, ".capshelf.yml"))).toBe(false);
  });

  test("--merge conflicts leave the data repo, installed files, and lock untouched", async () => {
    const f = await staleFixture();
    const headBefore = await headSha(f.dataRepo);
    const lockBefore = structuredClone(f.lock);

    await expect(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        { merge: true },
      ),
    ).rejects.toThrow(/merge conflicts[\s\S]*SKILL\.md/);

    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(f.lock).toEqual(lockBefore);
    expect(
      await file(join(f.dataRepo, "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello v2 from teammate\n");
    expect(
      await file(
        join(f.project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe("hello v2 local edit\n");
  });

  test("--merge conflict guidance preserves local scope and recoverability warning", async () => {
    const f = await staleFixture();

    await expect(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        { scope: "local", merge: true },
      ),
    ).rejects.toThrow(
      /local-scope files are excluded[\s\S]*capshelf update skills\/hello --local[\s\S]*capshelf promote skills\/hello --local --stale-ok/,
    );
  });

  test("--merge pre-merge convergence keeps the existing no-merge result", async () => {
    const f = await staleFixture();
    await writeFile(
      join(f.project, ".agents", "skills", "hello", "SKILL.md"),
      "hello v2 from teammate\n",
    );
    const headBefore = await headSha(f.dataRepo);
    let persisted = 0;

    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      {
        merge: true,
        persistLock: async () => {
          persisted++;
        },
      },
    );

    expect(result.merged).toBeUndefined();
    expect(result.action).toBe("already-upstream");
    expect(result.committed).toBe(false);
    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(persisted).toBe(0);
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(f.upstreamSha);
  });

  test("--merge convergence reconciles and persists the lock without a commit", async () => {
    const f = await subsumedMergeFixture();
    const headBefore = await headSha(f.dataRepo);
    let persisted = 0;

    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      {
        merge: true,
        persistLock: async () => {
          persisted++;
        },
      },
    );

    expect(result.merged).toBe(true);
    expect(result.mergeBase).toBe(f.lockedCommit);
    expect(result.mergedUpstreamCommit).toBe(f.upstreamCommit);
    expect(result.action).toBe("already-upstream");
    expect(result.committed).toBe(false);
    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(persisted).toBe(1);
    expect(
      await file(
        join(f.project, ".agents", "skills", "hello", "upstream.txt"),
      ).text(),
    ).toBe("value=upstream\n");
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(f.upstreamSha);
  });

  test("--merge convergence rolls installed content and lock state back when persistence fails", async () => {
    const f = await subsumedMergeFixture();
    const lockBefore = structuredClone(f.lock);
    const headBefore = await headSha(f.dataRepo);

    await expect(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        {
          merge: true,
          persistLock: async () => {
            throw new Error("lock write failed");
          },
        },
      ),
    ).rejects.toThrow("lock write failed");

    expect(f.lock).toEqual(lockBefore);
    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(await file(f.installed).text()).toBe("value=local\n");
    expect(
      await file(
        join(f.project, ".agents", "skills", "hello", "upstream.txt"),
      ).text(),
    ).toBe("value=base\n");
  });

  test("--merge rejects inconsistent base provenance without writes", async () => {
    const f = await staleFixture();
    const entry = f.lock.items[dataKey("skills", "hello")];
    if (entry?.source !== "data") throw new Error("expected data entry");
    entry.sourceCommit = f.upstreamCommit;
    const headBefore = await headSha(f.dataRepo);
    const localBefore = await file(
      join(f.project, ".agents", "skills", "hello", "SKILL.md"),
    ).text();

    await expect(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        { merge: true },
      ),
    ).rejects.toThrow(/does not reproduce the locked item content/);

    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(
      await file(
        join(f.project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe(localBefore);
  });

  test("--merge rejects missing and non-ancestor base commits without writes", async () => {
    const missing = await staleFixture();
    const missingEntry = missing.lock.items[dataKey("skills", "hello")];
    if (missingEntry?.source !== "data") throw new Error("expected data entry");
    missingEntry.sourceCommit = "a".repeat(40);
    const missingHead = await headSha(missing.dataRepo);
    await expect(
      syncTrackedIntoDataRepo(
        missing.project,
        missing.dataRepo,
        "skills",
        "hello",
        missing.lock,
        { merge: true },
      ),
    ).rejects.toThrow(/locked source commit is not available/);
    expect(await headSha(missing.dataRepo)).toBe(missingHead);

    const nonAncestor = await staleFixture();
    const treeish = "HEAD^{tree}";
    const tree = (
      await $`git -C ${nonAncestor.dataRepo} rev-parse ${treeish}`.text()
    ).trim();
    const orphan = (
      await $`git -C ${nonAncestor.dataRepo} commit-tree ${tree} -m orphan`.text()
    ).trim();
    const nonAncestorEntry = nonAncestor.lock.items[dataKey("skills", "hello")];
    if (nonAncestorEntry?.source !== "data") {
      throw new Error("expected data entry");
    }
    nonAncestorEntry.sourceCommit = orphan;
    const nonAncestorHead = await headSha(nonAncestor.dataRepo);
    await expect(
      syncTrackedIntoDataRepo(
        nonAncestor.project,
        nonAncestor.dataRepo,
        "skills",
        "hello",
        nonAncestor.lock,
        { merge: true },
      ),
    ).rejects.toThrow(/not an ancestor/);
    expect(await headSha(nonAncestor.dataRepo)).toBe(nonAncestorHead);
  });

  test("--merge rejects an ancestor base that lacks the item directory", async () => {
    const dataRepo = await tempRepo("capshelf-missing-base-item-data-");
    const project = await tempRepo("capshelf-missing-base-item-project-");
    await writeFile(join(dataRepo, "README.md"), "before item\n");
    await commitAll(dataRepo, "before item");
    const missingItemCommit = await headSha(dataRepo);
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await commitAll(dataRepo, "item base");
    const lockedSha = await currentPinDigest(dataRepo, "skills", "hello");
    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local\n");
    const lock = lockWith({
      source: "data",
      sourcePinDigest: lockedSha,
      sourceCommit: missingItemCommit,
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    const headBefore = await headSha(dataRepo);

    await expect(
      syncTrackedIntoDataRepo(project, dataRepo, "skills", "hello", lock, {
        merge: true,
      }),
    ).rejects.toThrow(/does not contain the item directory/);

    expect(await headSha(dataRepo)).toBe(headBefore);
    expect(existsSync(join(dataItem, "local.txt"))).toBe(false);
  });

  test("--merge resolves an abbreviated locked commit to a full merge base", async () => {
    const f = await subsumedMergeFixture();
    const entry = f.lock.items[dataKey("skills", "hello")];
    if (entry?.source !== "data") throw new Error("expected data entry");
    entry.sourceCommit = f.lockedCommit.slice(0, 9);

    const result = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      { merge: true, persistLock: async () => {} },
    );

    expect(result.merged).toBe(true);
    expect(result.mergeBase).toBe(f.lockedCommit);
    expect(result.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  test("--merge revalidates the installed snapshot after planning", async () => {
    const f = await subsumedMergeFixture();
    const headBefore = await headSha(f.dataRepo);
    const lockBefore = structuredClone(f.lock);

    await expect(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        {
          merge: true,
          afterMergePlan: async () => {
            await writeFile(f.installed, "changed during planning\n");
          },
        },
      ),
    ).rejects.toThrow(/changed while preparing the merge/);

    expect(await headSha(f.dataRepo)).toBe(headBefore);
    expect(f.lock).toEqual(lockBefore);
    expect(await file(f.installed).text()).toBe("changed during planning\n");
  });

  test("--merge aborts when data HEAD or the installed sidecar changes during planning", async () => {
    const headChange = await disjointMergeFixture("capshelf-head-race");
    const lockBeforeHeadChange = structuredClone(headChange.lock);
    let externalHead = "";
    await expect(
      syncTrackedIntoDataRepo(
        headChange.project,
        headChange.dataRepo,
        "skills",
        "hello",
        headChange.lock,
        {
          merge: true,
          afterMergePlan: async () => {
            await writeFile(
              join(headChange.dataRepo, "README.md"),
              "external commit\n",
            );
            await commitAll(headChange.dataRepo, "external commit");
            externalHead = await headSha(headChange.dataRepo);
          },
        },
      ),
    ).rejects.toThrow(/changed while preparing the merge/);
    expect(await headSha(headChange.dataRepo)).toBe(externalHead);
    expect(headChange.lock).toEqual(lockBeforeHeadChange);
    expect(existsSync(join(headChange.dataItem, "local.txt"))).toBe(false);

    const sidecarChange = await disjointMergeFixture("capshelf-sidecar-race");
    const sidecarHead = await headSha(sidecarChange.dataRepo);
    const sidecarLock = structuredClone(sidecarChange.lock);
    await expect(
      syncTrackedIntoDataRepo(
        sidecarChange.project,
        sidecarChange.dataRepo,
        "skills",
        "hello",
        sidecarChange.lock,
        {
          merge: true,
          afterMergePlan: async () => {
            await writeFile(
              join(sidecarChange.installed, ".capshelf.yml"),
              "tags: [changed]\n",
            );
          },
        },
      ),
    ).rejects.toThrow(/changed while preparing the merge/);
    expect(await headSha(sidecarChange.dataRepo)).toBe(sidecarHead);
    expect(sidecarChange.lock).toEqual(sidecarLock);
    expect(existsSync(join(sidecarChange.dataItem, "local.txt"))).toBe(false);
  });

  // The injection points moved with the merge commit itself: they fire at the
  // end of `commitDataRepoMutation`'s `mutate`, immediately before staging and
  // commit, which is where `beforeHeadAdvance` sat under the retired
  // `commit-tree` transaction. The assertion set is unchanged.
  for (const phase of ["afterPathReplaced", "beforeHeadAdvance"] as const) {
    test(`--merge ${phase} failure restores path, index, HEAD, installed content, and lock`, async () => {
      const f = await disjointMergeFixture(`capshelf-merge-failure-${phase}`);
      const headBefore = await headSha(f.dataRepo);
      const lockBefore = structuredClone(f.lock);
      const installedBefore = await file(join(f.installed, "local.txt")).text();
      const indexPath = (
        await $`git -C ${f.dataRepo} rev-parse --git-path index`.text()
      ).trim();
      const indexBefore = await readFile(join(f.dataRepo, indexPath));

      await expect(
        syncTrackedIntoDataRepo(
          f.project,
          f.dataRepo,
          "skills",
          "hello",
          f.lock,
          {
            merge: true,
            transactionHooks: {
              [phase]: async () => {
                throw new Error("injected commit failure");
              },
            },
          },
        ),
      ).rejects.toThrow("injected commit failure");

      expect(await headSha(f.dataRepo)).toBe(headBefore);
      expect(await readFile(join(f.dataRepo, indexPath))).toEqual(indexBefore);
      expect(f.lock).toEqual(lockBefore);
      expect(await file(join(f.installed, "local.txt")).text()).toBe(
        installedBefore,
      );
      expect(existsSync(join(f.dataItem, "local.txt"))).toBe(false);
      // The item directory is replaced wholesale before the commit, so every
      // file it held has to come back, not just the ones the merge touched.
      expect(await file(join(f.dataItem, "SKILL.md")).text()).toBe("base\n");
      expect(await file(join(f.dataItem, "upstream.txt")).text()).toBe(
        "upstream\n",
      );
      expect(
        (await $`git -C ${f.dataRepo} status --porcelain`.text()).trim(),
      ).toBe("");
    });
  }

  test("--merge commits in a repository whose git dir is elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "capshelf-merge-separate-git-"));
    const dataRepo = join(root, "worktree");
    const gitDir = join(root, "separate-git");
    await mkdir(dataRepo);
    await $`git init -q --separate-git-dir=${gitDir} ${dataRepo}`.quiet();
    await $`git -C ${dataRepo} config user.email capshelf@example.invalid`.quiet();
    await $`git -C ${dataRepo} config user.name capshelf`.quiet();
    const project = await tempRepo("capshelf-merge-separate-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await commitAll(dataRepo, "base");
    const lock = lockWith({
      source: "data",
      sourcePinDigest: await currentPinDigest(dataRepo, "skills", "hello"),
      sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
      appliedAt: "2026-06-01T00:00:00.000Z",
    });
    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".agents", "skills", "hello");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "base\n");
    await writeFile(join(installed, "local.txt"), "local\n");

    const result = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "hello",
      lock,
      { merge: true },
    );

    expect(result.committed).toBe(true);
    expect(await file(join(dataItem, "local.txt")).text()).toBe("local\n");
    expect(await file(join(dataItem, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
    expect((await $`git -C ${dataRepo} status --porcelain`.text()).trim()).toBe(
      "",
    );
    expect(
      (await readdir(join(dataRepo, "skills"))).some((name) =>
        name.startsWith(".capshelf-"),
      ),
    ).toBe(false);
    expect(
      (await readdir(gitDir)).some((name) => name.startsWith(".capshelf-")),
    ).toBe(false);
  });

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
    expect((error as Error).message).toContain(
      "capshelf update skills/hello --merge",
    );
    // Nothing was written or committed.
    expect(
      await file(join(f.dataRepo, "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello v2 from teammate\n");
    expect(await $`git -C ${f.dataRepo} rev-parse HEAD`.quiet().text()).toBe(
      headBefore,
    );
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(f.lockedSha);
  });

  test("local-scope refusals preserve scope and warn that update replaces untracked edits", async () => {
    const f = await staleFixture();
    let error: unknown;
    try {
      await syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        { scope: "local" },
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PreconditionError);
    const message = (error as Error).message;
    expect(message).toContain("capshelf status skills/hello --local --diff");
    expect(message).toContain("capshelf update skills/hello --local");
    expect(message).toContain(
      'capshelf promote skills/hello --local --stale-ok -m "..."',
    );
    expect(message).toContain("capshelf update skills/hello --local --merge");
    expect(message).toContain(
      "local-scope files are excluded from this project's Git",
    );
    expect(message).not.toContain("stay recoverable");
  });

  test("the refusal names merge first, then update, then --stale-ok", async () => {
    const f = await disjointMergeFixture("capshelf-stale-merge-offer");
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
    const message = (error as Error).message;
    expect(message).toContain("capshelf update skills/hello --merge");
    // Merge keeps both sides, so it is the first choice (docs/cli.md:969-977).
    expect(message.indexOf("--merge")).toBeLessThan(
      message.indexOf("to take the upstream version"),
    );
    expect(message.indexOf("to take the upstream version")).toBeLessThan(
      message.indexOf("--stale-ok"),
    );

    // The offered command runs: it merges rather than refusing.
    const merged = await syncTrackedIntoDataRepo(
      f.project,
      f.dataRepo,
      "skills",
      "hello",
      f.lock,
      { merge: true },
    );
    expect(merged.merged).toBe(true);
    expect(merged.committed).toBe(true);
  });

  test("a local-scope Pi refusal offers update merge", async () => {
    const dataRepo = await tempRepo("capshelf-stale-local-pi-data-");
    const project = await tempRepo("capshelf-stale-local-pi-project-");
    const dataItem = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "index.ts"), "export const base = true;\n");
    await commitAll(dataRepo, "guard base");
    const lockedSha = await currentPinDigest(
      dataRepo,
      "pi-extensions",
      "guard",
    );
    const lockedCommit = await lastTouchingContentCommit(
      dataRepo,
      "pi/extensions/guard",
    );
    await writeFile(
      join(dataItem, "index.ts"),
      "export const upstream = true;\n",
    );
    await commitAll(dataRepo, "guard upstream");
    const installed = join(project, ".pi", "extensions", "guard");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "index.ts"),
      "export const local = true;\n",
    );
    const lock: LockV4 = {
      version: 4,
      items: {
        [dataKey("pi-extensions", "guard")]: {
          source: "data",
          sourcePinDigest: lockedSha,
          sourceCommit: lockedCommit,
          appliedAt: "2026-06-01T00:00:00.000Z",
        },
      },
    };

    let error: unknown;
    try {
      await syncTrackedIntoDataRepo(
        project,
        dataRepo,
        "pi-extensions",
        "guard",
        lock,
        { scope: "local" },
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PreconditionError);
    const message = (error as Error).message;
    expect(message).toContain(
      "changed in the data repo since this project last updated",
    );
    expect(message).toContain("capshelf update pi-extensions/guard --local");
    expect(message).toContain(
      "capshelf update pi-extensions/guard --local --merge",
    );
    await expect(
      syncTrackedIntoDataRepo(
        project,
        dataRepo,
        "pi-extensions",
        "guard",
        lock,
        { scope: "local", merge: true },
      ),
    ).rejects.toThrow(/supported only in project scope/);
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
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("skills", "hello")], "test")
        .sourcePinDigest,
    ).toBe(result.sha);
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
      sourcePinDigest: await currentPinDigest(dataRepo, "skills", "hello"),
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

  test("a dirty data-repo item path blocks plain, overwrite, and merge promotion", async () => {
    const f = await staleFixture();
    await writeFile(
      join(f.dataRepo, "skills", "hello", "SKILL.md"),
      "uncommitted upstream edit\n",
    );
    for (const options of [{}, { staleOk: true }, { merge: true }]) {
      let error: unknown;
      try {
        await syncTrackedIntoDataRepo(
          f.project,
          f.dataRepo,
          "skills",
          "hello",
          f.lock,
          options,
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
      sourcePinDigest: f.upstreamSha,
      sourceCommit: f.upstreamCommit,
      appliedAt: expect.any(String),
      label: "v1",
      needs: { network: [], env: [], bin: [] },
      needsSourceCommit: f.upstreamCommit,
    });
    expect(entry?.appliedAt).not.toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("stale-promote guard (fragments)", () => {
  async function fragmentStaleFixture(): Promise<{
    dataRepo: string;
    project: string;
    lock: LockV4;
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
    const lockedSha = await currentPinDigest(dataRepo, "settings", "theme");
    const lockedCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const lock: Lock = {
      version: 4,
      items: {
        [dataKey("settings", "theme")]: {
          source: "data",
          sourcePinDigest: lockedSha,
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
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("settings", "theme")], "test")
        .sourcePinDigest,
    ).toBe(f.lockedSha);

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

  test("the refusal omits merge, which fragments cannot use", async () => {
    const f = await fragmentStaleFixture();
    const source = join(f.dataRepo, "settings", "theme", "settings.json");
    await writeFile(source, JSON.stringify({ theme: "v2-upstream" }));
    await commitAll(f.dataRepo, "theme v2 upstream");
    await writeFile(source, JSON.stringify({ theme: "v3-dirty" }));

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
    const message = (error as Error).message;
    expect(message).toContain("capshelf update settings/theme");
    expect(message).toContain("--stale-ok");
    // promote --merge refuses a fragment, so the refusal must not offer it;
    // that refusal is covered in tests/promote-merge-cli.test.ts.
    expect(message).not.toContain("--merge");
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

    const clean = {
      upstreamSha: await currentPinDigest(dataRepo, "skills", "hello"),
      upstreamDirty: false,
      sourceCommit: await lastTouchingContentCommit(dataRepo, "skills/hello"),
    };
    expect(
      await upstreamFactsForItem(dataRepo, "skills", "hello", "tree"),
    ).toEqual(clean);

    // Under tree identity a dirty working copy no longer suppresses the
    // answer: the identity comes from the commit, so what consumers would
    // receive is unchanged and the divergence is advisory. The legacy
    // `worktree` model still nulls it out, because there the working copy
    // *was* the identity.
    await writeFile(join(dataItem, "SKILL.md"), "dirty\n");
    expect(
      await upstreamFactsForItem(dataRepo, "skills", "hello", "tree"),
    ).toEqual({ ...clean, upstreamDirty: true });
    expect(await upstreamFactsForItem(dataRepo, "skills", "hello")).toEqual({
      upstreamSha: null,
      upstreamDirty: true,
      sourceCommit: null,
    });

    expect(await upstreamFactsForItem(dataRepo, "skills", "absent")).toEqual({
      upstreamSha: null,
      upstreamDirty: false,
      sourceCommit: null,
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
      sourceCommit: await lastTouchingFragmentCommit(
        dataRepo,
        "settings",
        "theme",
      ),
    });

    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ theme: "light" }),
    );
    expect(await upstreamFactsForItem(dataRepo, "settings", "theme")).toEqual({
      upstreamSha: null,
      upstreamDirty: true,
      sourceCommit: null,
    });
  });
});
