import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Manifest } from "../src/manifest";
import {
  UpstreamVerificationError,
  verifyDataRepoUpstream,
} from "../src/upstream-check";

async function tempRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

function manifest(upstream?: string): Manifest {
  return {
    installMode: "codex-compatible",
    ...(upstream && { dataRepoUpstream: upstream }),
    skills: [],
    settings: [],
    mcp: [],
  };
}

describe("upstream verification", () => {
  test("accepts matching origins across normalized URL forms", async () => {
    const repo = await tempRepo("capshelf-upstream-match-");
    await $`git -C ${repo} remote add origin git@github.com:mg/agent-shared.git`.quiet();

    await expect(
      verifyDataRepoUpstream(
        repo,
        manifest("https://github.com/mg/agent-shared"),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects missing origin when the manifest declares an upstream", async () => {
    const repo = await tempRepo("capshelf-upstream-no-origin-");

    await expect(
      verifyDataRepoUpstream(
        repo,
        manifest("https://github.com/mg/agent-shared"),
      ),
    ).rejects.toMatchObject({
      constructor: UpstreamVerificationError,
      exitCode: 4,
      message: expect.stringContaining("has no `origin` remote configured"),
    });
  });

  test("skips origin checks when the manifest has no upstream", async () => {
    const repo = await tempRepo("capshelf-upstream-skipped-");

    await expect(verifyDataRepoUpstream(repo, manifest())).resolves.toBeUndefined();
  });
});
