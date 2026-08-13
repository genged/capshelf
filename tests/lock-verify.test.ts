import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyDataLockEntries } from "../src/lock-verify";
import { dataKey, type LockV4 } from "../src/lock";
import { currentPin } from "./pin-fixtures";
import { ManifestSchema, type Manifest } from "../src/manifest";
import { captureCommittedItemNeeds } from "../src/metadata";

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "capshelf-lockverify-"));
  await $`git -C ${dir} init -q`.quiet();
  await $`git -C ${dir} config user.email t@t`.quiet();
  await $`git -C ${dir} config user.name t`.quiet();
  return dir;
}

function manifestWith(name: string): Manifest {
  return ManifestSchema.parse({
    version: 1,
    installMode: "codex-compatible",
    items: [{ kind: "skills", name }],
  });
}

// The pin `add` records comes from the committed tree; set-data re-derives it
// at the same commit through `verifyDataLockEntries`. The two must agree,
// including file ordering and sidecar exclusion.
async function lockFromAdd(dataRepo: string, name: string): Promise<LockV4> {
  const _repoRelPath = `skills/${name}`;
  return {
    version: 4,
    items: {
      [dataKey("skills", name)]: {
        source: "data",
        ...(await currentPin(dataRepo, "skills", name)),
        appliedAt: "2026-07-02T00:00:00.000Z",
        ...(await captureCommittedItemNeeds(dataRepo, {
          kind: "skills",
          name,
        })),
      },
    },
  };
}

describe("verifyDataLockEntries", () => {
  test("accepts a multi-file skill carrying a metadata sidecar", async () => {
    const dataRepo = await tempRepo();
    const skill = join(dataRepo, "skills", "greet");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "name: greet\n---\nhi\n");
    // A second content file whose name sorts differently under locale collation
    // than under code-unit order (café vs SKILL) — the case that exposed the
    // sort mismatch — plus the catalog sidecar that must be excluded.
    await writeFile(join(skill, "café.md"), "accent\n");
    await writeFile(join(skill, ".capshelf.yml"), "tags: [demo]\n");
    await $`git -C ${dataRepo} add -A`.quiet();
    await $`git -C ${dataRepo} commit -qm init`.quiet();

    const lock = await lockFromAdd(dataRepo, "greet");

    // Must not throw: the recorded sha reproduces at the pinned commit.
    await verifyDataLockEntries(dataRepo, manifestWith("greet"), lock);
  });

  test("rejects a lock whose sha no longer matches the pinned commit", async () => {
    const dataRepo = await tempRepo();
    const skill = join(dataRepo, "skills", "greet");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "name: greet\n---\nhi\n");
    await $`git -C ${dataRepo} add -A`.quiet();
    await $`git -C ${dataRepo} commit -qm init`.quiet();

    const lock = await lockFromAdd(dataRepo, "greet");
    const entry = lock.items[dataKey("skills", "greet")]!;
    if (entry.source !== "data") throw new Error("expected a data entry");
    entry.sourcePinDigest = "0".repeat(64);

    await expect(
      verifyDataLockEntries(dataRepo, manifestWith("greet"), lock),
    ).rejects.toThrow(/pins to .* but lock expects/);
  });

  test("rejects a needs snapshot that does not match its provenance commit", async () => {
    const dataRepo = await tempRepo();
    const skill = join(dataRepo, "skills", "greet");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "hi\n");
    await writeFile(
      join(skill, ".capshelf.yml"),
      "needs:\n  network: [api.example.com]\n",
    );
    await $`git -C ${dataRepo} add -A`.quiet();
    await $`git -C ${dataRepo} commit -qm init`.quiet();

    const lock = await lockFromAdd(dataRepo, "greet");
    const entry = lock.items[dataKey("skills", "greet")]!;
    if (entry.source !== "data") throw new Error("expected data entry");
    entry.needs = { network: ["other.example.com"], env: [], bin: [] };

    await expect(
      verifyDataLockEntries(dataRepo, manifestWith("greet"), lock),
    ).rejects.toThrow(/do not match the lock snapshot/);
  });
});
