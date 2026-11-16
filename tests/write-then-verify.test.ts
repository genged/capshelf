import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataKey, loadLock, parseLock, serializeLock } from "../src/lock";
import type { LockEntryV4, WritableLock } from "../src/lock";
import { materializeLockEntry } from "../src/materialize";
import { materializeSubagent } from "../src/subagents";
import { pinItemAtCommit, currentSourceCommit } from "../src/pin";
import { contentSourceFor, gitTreeSource } from "../src/item-source";
import { addSkill, commitAll, runInProcess, tempRepo } from "./cli-fixtures";

/**
 * Fault-injection tests: a double writes wrong bytes and the command must fail,
 * since a verification that cannot fail is not one.
 */
describe("write-then-verify", () => {
  test("a corrupted staged file fails the write and preserves the old install", async () => {
    const project = await tempRepo("capshelf-verify-project-");
    const dataRepo = await tempRepo("capshelf-verify-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    await commitAll(dataRepo, "hello v2");
    const entry = (await loadLock(project)).items[dataKey("skills", "hello")]!;
    const pin = await pinItemAtCommit(
      gitTreeSource({
        repo: dataRepo,
        kind: "skills",
        name: "hello",
        commit: await currentSourceCommit(dataRepo, "skills", "hello"),
      }),
      "skills",
      "hello",
    );
    if (entry.source !== "data") throw new Error("expected a data entry");

    const selected: LockEntryV4 = {
      ...entry,
      sha: undefined,
      sourcePinDigest: pin.sourcePinDigest,
      sourceCommit: pin.sourceCommit,
    };
    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await expect(
      materializeLockEntry({
        project,
        source: contentSourceFor({
          entry: selected,
          kind: "skills",
          name: "hello",
          repo: dataRepo,
        }),
        kind: "skills",
        name: "hello",
        key: dataKey("skills", "hello"),
        entry: selected,
        previous: {
          entry,
          source: contentSourceFor({
            entry,
            kind: "skills",
            name: "hello",
            repo: dataRepo,
          }),
        },
        scope: "project",
        hooks: {
          // Corrupt the bytes after publish, as a silent filesystem would; only
          // the post-publish comparison can detect this.
          afterPublish: async () => {
            await writeFile(installed, "corrupted\n");
          },
        },
      }),
    ).rejects.toThrow(/does not match the staged regular-file tree/);

    expect(await readFile(installed, "utf-8")).toBe("hello v1\n");
  });

  test("a subagent whose written output is corrupted fails and rolls back", async () => {
    const project = await tempRepo("capshelf-verify-subagent-project-");
    const dataRepo = await tempRepo("capshelf-verify-subagent-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "subagents", "reviewer"), { recursive: true });
    await writeFile(
      join(dataRepo, "subagents", "reviewer", "claude.md"),
      "---\nname: reviewer\ndescription: Review changes\n---\n\nReview it.\n",
    );
    await commitAll(dataRepo, "reviewer v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    await writeFile(
      join(dataRepo, "subagents", "reviewer", "claude.md"),
      "---\nname: reviewer\ndescription: Review changes\n---\n\nReview it twice.\n",
    );
    await commitAll(dataRepo, "reviewer v2");
    const previous = (await loadLock(project)).items[
      dataKey("subagents", "reviewer")
    ]!;
    if (previous.source !== "data") throw new Error("expected a data entry");
    const pin = await pinItemAtCommit(
      gitTreeSource({
        repo: dataRepo,
        kind: "subagents",
        name: "reviewer",
        commit: await currentSourceCommit(dataRepo, "subagents", "reviewer"),
      }),
      "subagents",
      "reviewer",
    );
    const output = join(project, ".claude", "agents", "reviewer.md");
    const before = await readFile(output, "utf-8");

    await expect(
      materializeSubagent({
        project,
        dataRepo,
        name: "reviewer",
        entry: {
          ...previous,
          sha: undefined,
          sourcePinDigest: pin.sourcePinDigest,
          sourceCommit: pin.sourceCommit,
        },
        previousEntry: previous,
        hooks: {
          afterReplace: async () => {
            await writeFile(output, "corrupted\n");
          },
        },
      }),
    ).rejects.toThrow(/post-materialization identity mismatch/);

    expect(await readFile(output, "utf-8")).toBe(before);
  });

  test("a lock candidate that lost a digest fails before anything is published", () => {
    const candidate: WritableLock = {
      version: 5,
      items: {
        [dataKey("skills", "hello")]: {
          source: "data",
          sourcePinDigest: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          needs: { network: [], env: [], bin: [] },
          needsSourceCommit: "b".repeat(40),
          appliedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    };
    expect(() => serializeLock(candidate)).not.toThrow();

    const entry = candidate.items[dataKey("skills", "hello")];
    if (entry?.source !== "data") throw new Error("expected a data entry");
    const { sourcePinDigest: _dropped, ...withoutDigest } = entry;
    const broken: WritableLock = {
      version: 5,
      items: {
        // SAFETY: the entry deliberately omits sourcePinDigest; LockEntryV4 is
        // comparable to the narrowed entry.
        [dataKey("skills", "hello")]: withoutDigest as LockEntryV4,
      },
    };
    expect(() => serializeLock(broken)).toThrow();
  });

  test("a saved lock reloads to the value that was written", async () => {
    const project = await tempRepo("capshelf-verify-lock-project-");
    const dataRepo = await tempRepo("capshelf-verify-lock-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const path = join(project, ".capshelf", "capshelf.lock.json");
    const raw = await file(path).json();
    const parsed = parseLock(raw);
    expect(parsed).toEqual(await loadLock(project));
    if (parsed.version !== 5) throw new Error("expected a version 5 lock");
    expect(serializeLock(parsed)).toBe(await readFile(path, "utf-8"));
  });
});
