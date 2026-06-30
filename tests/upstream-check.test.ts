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
    codexConfig: [],
    okf: [],
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

  test("rejects an origin bound to the wrong upstream, naming both URLs", async () => {
    const repo = await tempRepo("capshelf-upstream-mismatch-");
    await $`git -C ${repo} remote add origin git@github.com:other/elsewhere.git`.quiet();

    const error = await verifyDataRepoUpstream(
      repo,
      manifest("https://github.com/mg/agent-shared"),
    ).then(
      () => {
        throw new Error("expected verifyDataRepoUpstream to reject");
      },
      (e: unknown) => e as Error & { exitCode?: number },
    );

    expect(error).toBeInstanceOf(UpstreamVerificationError);
    expect(error.exitCode).toBe(4);
    expect(error.message).toContain("bound to the wrong upstream");
    // Both sides of the mismatch must be named so the user can see the diff.
    expect(error.message).toContain(
      "declares: https://github.com/mg/agent-shared",
    );
    expect(error.message).toContain("https://github.com/other/elsewhere");
  });

  test("rejects an unnormalizable manifest upstream before touching the repo", async () => {
    // The manifest value is config the user committed; the contract is a
    // plain Error naming the manifest file and the bad value (no exit-4
    // verification failure -- the manifest itself is broken).
    const error = await verifyDataRepoUpstream(
      "/nonexistent/never-read",
      manifest("not a valid url"),
    ).then(
      () => {
        throw new Error("expected verifyDataRepoUpstream to reject");
      },
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamVerificationError);
    expect(error.message).toBe(
      "invalid dataRepoUpstream in .capshelf/capshelf.json: not a valid url",
    );
  });

  test("skips origin checks when the manifest has no upstream", async () => {
    const repo = await tempRepo("capshelf-upstream-skipped-");

    await expect(
      verifyDataRepoUpstream(repo, manifest()),
    ).resolves.toBeUndefined();
  });
});
