import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataKey, loadLock, parseLock, serializeLock } from "../src/lock";
import type { LockEntryV4, LockV4 } from "../src/lock";
import { materializeLockEntry } from "../src/materialize";
import { materializeSubagent } from "../src/subagents";
import { pinItemAtCommit, currentSourceCommit } from "../src/pin";
import { addSkill, commitAll, runInProcess, tempRepo } from "./cli-fixtures";

/**
 * WRITE-THEN-VERIFY.
 *
 * Every write that establishes a claim re-derives that claim immediately,
 * before the command returns. The original defect survived for weeks because
 * the only check of the invariant lived in a *different* command; performed at
 * the moment of writing, it would have failed inside `add`, with the offending
 * file in hand.
 *
 * These are fault-injection tests, not inspections: a double that writes
 * deliberately wrong bytes must make the command fail loudly. A verification
 * that cannot be made to fail is not a verification.
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
      dataRepo,
      "skills",
      "hello",
      await currentSourceCommit(dataRepo, "skills", "hello"),
    );
    if (entry.source !== "data") throw new Error("expected a data entry");

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await expect(
      materializeLockEntry({
        project,
        dataRepo,
        key: dataKey("skills", "hello"),
        entry: {
          ...entry,
          sha: undefined,
          sourcePinDigest: pin.sourcePinDigest,
          sourceCommit: pin.sourceCommit,
        },
        previousEntry: entry,
        scope: "project",
        hooks: {
          // The published bytes are corrupted after the writer put them
          // there, which is what a silent filesystem or a buggy writer looks
          // like from inside the command. Only the post-publish comparison
          // can notice.
          afterPublish: async () => {
            await writeFile(installed, "corrupted\n");
          },
        },
      }),
    ).rejects.toThrow(/does not match the staged regular-file tree/);

    // Rolled back to the previous install, not left holding the corruption.
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
      dataRepo,
      "subagents",
      "reviewer",
      await currentSourceCommit(dataRepo, "subagents", "reviewer"),
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
            // Replace the target with bytes no pin describes, after the writer
            // has finished, so the post-write re-derivation is the only thing
            // that can notice.
            await writeFile(output, "corrupted\n");
          },
        },
      }),
    ).rejects.toThrow(/post-materialization identity mismatch/);

    expect(await readFile(output, "utf-8")).toBe(before);
  });

  test("a lock candidate that lost a digest fails before anything is published", () => {
    const candidate: LockV4 = {
      version: 4,
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

    // The `lock migrate` fault-injection case: a serializer that drops one
    // digest has to fail at the strict parse, not after a file is written.
    const entry = candidate.items[dataKey("skills", "hello")];
    if (entry?.source !== "data") throw new Error("expected a data entry");
    const { sourcePinDigest: _dropped, ...withoutDigest } = entry;
    const broken: LockV4 = {
      version: 4,
      items: {
        // SAFETY: the entry omits sourcePinDigest on purpose. The test proves
        // the writer refuses it. LockEntryV4 is comparable to the narrowed
        // entry, so one assertion states the intent.
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
    // The one writer strict-parses on the way out; this proves the file it
    // produced strict-parses on the way back in, with the same value.
    const parsed = parseLock(raw);
    expect(parsed).toEqual(await loadLock(project));
    if (parsed.version !== 4) throw new Error("expected a version 4 lock");
    expect(serializeLock(parsed)).toBe(await readFile(path, "utf-8"));
  });
});
