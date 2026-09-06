import { describe, expect, spyOn, test } from "bun:test";
import { $, file } from "bun";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
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
import { rejection } from "./cli-fixtures";
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

describe("stale-promote guard (copy items)", () => {
  test("blocks when upstream is clean and advanced past the lock", async () => {
    const f = await staleFixture();
    const headBefore = await $`git -C ${f.dataRepo} rev-parse HEAD`
      .quiet()
      .text();
    const error = await rejection(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        {},
      ),
      PreconditionError,
    );
    expect(error.message).toContain(
      "changed in the data repo since this project last updated",
    );
    expect(error.message).toContain("--stale-ok");
    expect(error.message).toContain("capshelf update skills/hello");
    expect(error.message).toContain("status skills/hello --diff");
    expect(error.message).toContain("capshelf update skills/hello --merge");
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
    const error = await rejection(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        { scope: "local" },
      ),
      PreconditionError,
    );
    const message = error.message;
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
    const f = await staleFixture();
    const error = await rejection(
      syncTrackedIntoDataRepo(
        f.project,
        f.dataRepo,
        "skills",
        "hello",
        f.lock,
        {},
      ),
      PreconditionError,
    );
    const message = error.message;
    expect(message).toContain("capshelf update skills/hello --merge");
    // Update-time merge keeps both sides, so it is the first choice.
    expect(message.indexOf("--merge")).toBeLessThan(
      message.indexOf("to take the upstream version"),
    );
    expect(message.indexOf("to take the upstream version")).toBeLessThan(
      message.indexOf("--stale-ok"),
    );
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

    const error = await rejection(
      syncTrackedIntoDataRepo(
        project,
        dataRepo,
        "pi-extensions",
        "guard",
        lock,
        { scope: "local" },
      ),
      PreconditionError,
    );
    const message = error.message;
    expect(message).toContain(
      "changed in the data repo since this project last updated",
    );
    expect(message).toContain("capshelf update pi-extensions/guard --local");
    expect(message).toContain(
      "capshelf update pi-extensions/guard --local --merge",
    );
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

  test("a dirty data-repo item path blocks plain and overwrite promotion", async () => {
    const f = await staleFixture();
    await writeFile(
      join(f.dataRepo, "skills", "hello", "SKILL.md"),
      "uncommitted upstream edit\n",
    );
    for (const options of [{}, { staleOk: true }]) {
      const error = await rejection(
        syncTrackedIntoDataRepo(
          f.project,
          f.dataRepo,
          "skills",
          "hello",
          f.lock,
          options,
        ),
        PreconditionError,
      );
      expect(error.message).toContain("uncommitted changes");
      expect(error.message).toContain("status --short -- skills/hello");
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
    const error = await rejection(
      promoteFragmentSource(
        f.project,
        f.dataRepo,
        { ...emptyManifest(), settings: ["theme"] },
        f.lock,
        "settings",
        "theme",
        {},
      ),
      PreconditionError,
    );
    expect(error.message).toContain(
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

    const error = await rejection(
      promoteFragmentSource(
        f.project,
        f.dataRepo,
        { ...emptyManifest(), settings: ["theme"] },
        f.lock,
        "settings",
        "theme",
        {},
      ),
      PreconditionError,
    );
    const message = error.message;
    expect(message).toContain("capshelf update settings/theme");
    expect(message).toContain("--stale-ok");
    // Update merge does not support fragments, so the refusal must not offer it.
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

  test("a clean tree at the locked commit is already-current, not a stale refusal", async () => {
    const f = await fragmentStaleFixture();
    const headBefore = await $`git -C ${f.dataRepo} rev-parse HEAD`
      .quiet()
      .text();

    // Nothing edited anywhere: the canonical source is clean and HEAD is the
    // commit the lock names. Until 2026-08-26 this threw, because the clean
    // branch compared against `entry.sha`, which a version 4 entry never has
    // (`src/lock.ts:188-192`). The refusal named committed changes that did
    // not exist and sent the user to `capshelf update`.
    const result = await promoteFragmentSource(
      f.project,
      f.dataRepo,
      { ...emptyManifest(), settings: ["theme"] },
      f.lock,
      "settings",
      "theme",
      {},
    );

    expect(result.action).toBe("already-current");
    expect(result.committed).toBe(false);
    expect(result.sha).toBe(f.lockedSha);
    // A no-op promote writes nothing: no commit, and the lock keeps its pin.
    expect(await $`git -C ${f.dataRepo} rev-parse HEAD`.quiet().text()).toBe(
      headBefore,
    );
    expect(
      dataEntryOrThrow(f.lock.items[dataKey("settings", "theme")], "test")
        .sourcePinDigest,
    ).toBe(f.lockedSha);
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
