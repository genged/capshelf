import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyDataLockEntries } from "../src/lock-verify";
import { hashNamedContents } from "../src/content-hash";
import { dataKey, type Lock, type WritableLock } from "../src/lock";
import type { ItemKind } from "../src/master";
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

async function lockFromAdd(
  dataRepo: string,
  name: string,
): Promise<WritableLock> {
  const _repoRelPath = `skills/${name}`;
  return {
    version: 5,
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

async function commitFile(
  repo: string,
  relPath: string,
  content: string,
): Promise<string> {
  await mkdir(join(repo, relPath, ".."), { recursive: true });
  await writeFile(join(repo, relPath), content);
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${`write ${relPath}`}`.quiet();
  return (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
}

function legacyLock(
  kind: ItemKind,
  name: string,
  sha: string,
  sourceCommit: string,
): Lock {
  return {
    version: 3,
    items: {
      [dataKey(kind, name)]: {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: "2026-07-02T00:00:00.000Z",
        needs: null,
        needsSourceCommit: null,
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
    // "café.md" sorts differently under locale collation than code-unit order
    // against SKILL; the sidecar must be excluded.
    await writeFile(join(skill, "café.md"), "accent\n");
    await writeFile(join(skill, ".capshelf.yml"), "tags: [demo]\n");
    await $`git -C ${dataRepo} add -A`.quiet();
    await $`git -C ${dataRepo} commit -qm init`.quiet();

    const lock = await lockFromAdd(dataRepo, "greet");

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

  test("accepts a legacy skill entry whose sha matches the commit", async () => {
    const dataRepo = await tempRepo();
    const commit = await commitFile(dataRepo, "skills/greet/SKILL.md", "hi\n");
    const sha = hashNamedContents([{ name: "SKILL.md", content: "hi\n" }]);

    await verifyDataLockEntries(
      dataRepo,
      manifestWith("greet"),
      legacyLock("skills", "greet", sha, commit),
    );
  });

  test("rejects a legacy skill entry whose content changed at the commit", async () => {
    const dataRepo = await tempRepo();
    await commitFile(dataRepo, "skills/greet/SKILL.md", "hi\n");
    const changed = await commitFile(
      dataRepo,
      "skills/greet/SKILL.md",
      "changed\n",
    );
    const lockedSha = hashNamedContents([
      { name: "SKILL.md", content: "hi\n" },
    ]);
    const actualSha = hashNamedContents([
      { name: "SKILL.md", content: "changed\n" },
    ]);

    await expect(
      verifyDataLockEntries(
        dataRepo,
        manifestWith("greet"),
        legacyLock("skills", "greet", lockedSha, changed),
      ),
    ).rejects.toThrow(
      `source skills/greet at ${changed} hashes to ${actualSha}, but lock expects ${lockedSha}`,
    );
  });

  describe.each([
    [
      "settings",
      "base",
      "settings/base",
      "settings/base/settings.json",
      '{"model":"one"}\n',
      '{"model":"two"}\n',
    ],
    [
      "mcp",
      "tools",
      "mcp/tools",
      "mcp/tools/claude.json",
      '{"mcpServers":{"one":{"command":"one"}}}\n',
      '{"mcpServers":{"two":{"command":"two"}}}\n',
    ],
    [
      "codex-config",
      "base",
      "codex/config/base",
      "codex/config/base/config.toml",
      'model = "one"\n',
      'model = "two"\n',
    ],
  ] as const)("legacy %s fragment entry", (kind, name, itemPath, relPath, first, second) => {
    test("is accepted when the sha matches the commit", async () => {
      const dataRepo = await tempRepo();
      const commit = await commitFile(dataRepo, relPath, first);
      const sha = hashNamedContents([{ name: relPath, content: first }]);

      await verifyDataLockEntries(
        dataRepo,
        manifestWith("greet"),
        legacyLock(kind, name, sha, commit),
      );
    });

    test("is refused when the content changed at the commit", async () => {
      const dataRepo = await tempRepo();
      await commitFile(dataRepo, relPath, first);
      const changed = await commitFile(dataRepo, relPath, second);
      const lockedSha = hashNamedContents([{ name: relPath, content: first }]);
      const actualSha = hashNamedContents([{ name: relPath, content: second }]);

      await expect(
        verifyDataLockEntries(
          dataRepo,
          manifestWith("greet"),
          legacyLock(kind, name, lockedSha, changed),
        ),
      ).rejects.toThrow(
        `source ${itemPath} at ${changed} hashes to ${actualSha}, but lock expects ${lockedSha}`,
      );
    });

    test("gives the missing-commit message when the commit has none of its files", async () => {
      const dataRepo = await tempRepo();
      const commit = await commitFile(dataRepo, "skills/other/SKILL.md", "x\n");

      await expect(
        verifyDataLockEntries(
          dataRepo,
          manifestWith("greet"),
          legacyLock(kind, name, "0".repeat(64), commit),
        ),
      ).rejects.toThrow(`does not contain commit ${commit}`);
    });
  });

  test("gives the missing-commit message for a digest-pinned entry at an unknown commit", async () => {
    const dataRepo = await tempRepo();
    await commitFile(dataRepo, "skills/greet/SKILL.md", "hi\n");
    const lock = await lockFromAdd(dataRepo, "greet");
    const entry = lock.items[dataKey("skills", "greet")]!;
    if (entry.source !== "data") throw new Error("expected a data entry");
    const missing = "a".repeat(40);
    entry.sourceCommit = missing;

    await expect(
      verifyDataLockEntries(dataRepo, manifestWith("greet"), lock),
    ).rejects.toThrow(`does not contain commit ${missing}`);
  });

  test("gives the missing-commit message for a needs snapshot at an unknown commit", async () => {
    const dataRepo = await tempRepo();
    await commitFile(
      dataRepo,
      "skills/greet/.capshelf.yml",
      "needs:\n  network: [api.example.com]\n",
    );
    await commitFile(dataRepo, "skills/greet/SKILL.md", "hi\n");
    const lock = await lockFromAdd(dataRepo, "greet");
    const entry = lock.items[dataKey("skills", "greet")]!;
    if (entry.source !== "data") throw new Error("expected a data entry");
    const missing = "b".repeat(40);
    entry.needsSourceCommit = missing;

    await expect(
      verifyDataLockEntries(dataRepo, manifestWith("greet"), lock),
    ).rejects.toThrow(`does not contain commit ${missing}`);
  });
});
