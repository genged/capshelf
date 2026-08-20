import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./cli-fixtures";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

/**
 * A stand-in for `gh` that applies the real `--jq` expression to a canned
 * payload. Stubbing the whole answer instead would leave the filter — the part
 * that decides whether a release proceeds — untested.
 */
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
expression=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) expression="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$expression" ]; then
  jq -r "$expression" "$GH_STUB_PAYLOAD"
else
  cat "$GH_STUB_PAYLOAD"
fi
`;

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function withStub(payload: unknown): Promise<string> {
  const dir = await tempDir("capshelf-gh-stub-");
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), GH_STUB);
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(join(dir, "payload.json"), JSON.stringify(payload));
  return dir;
}

async function run(
  script: string,
  args: string[],
  payload: unknown,
): Promise<Result> {
  const dir = await withStub(payload);
  const result = Bun.spawnSync({
    cmd: ["bash", join(SCRIPTS, script), ...args],
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      GH_STUB_PAYLOAD: join(dir, "payload.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const runs = (
  entries: { event: string; status: string; conclusion: string | null }[],
) => ({ workflow_runs: entries });

describe("require-green-test-run.sh", () => {
  test("a successful push run releases the commit", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([{ event: "push", status: "completed", conclusion: "success" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed on abc123");
  });

  test("a workflow_dispatch run counts too", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([
        {
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
        },
      ]),
    );
    expect(result.exitCode).toBe(0);
  });

  /**
   * A pull-request run carries the head SHA but checks out that commit merged
   * into its base, so it cannot vouch for the commit a tag points at.
   */
  test("a successful pull-request run does not count", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([
        { event: "pull_request", status: "completed", conclusion: "success" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no Test run exists");
  });

  test("a failed push run is refused even beside a green pull-request run", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([
        { event: "pull_request", status: "completed", conclusion: "success" },
        { event: "push", status: "completed", conclusion: "failure" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("finished without success");
  });

  test("an unfinished run refuses and says to wait", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([{ event: "push", status: "in_progress", conclusion: null }]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Wait for the Test run");
  });

  /** A re-run in flight beside a failure is not yet a verdict. */
  test("a queued run beside a failed one is treated as unfinished", async () => {
    const result = await run(
      "require-green-test-run.sh",
      ["owner/repo", "abc123"],
      runs([
        { event: "push", status: "completed", conclusion: "failure" },
        { event: "push", status: "queued", conclusion: null },
      ]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has not finished");
  });
});

describe("require-unmoved-tag.sh", () => {
  test("an unmoved tag passes", async () => {
    const result = await run(
      "require-unmoved-tag.sh",
      ["owner/repo", "v1.2.3", "abc123"],
      { sha: "abc123" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("still points at");
  });

  test("a tag moved after validation is refused, naming both commits", async () => {
    const result = await run(
      "require-unmoved-tag.sh",
      ["owner/repo", "v1.2.3", "abc123"],
      { sha: "def456" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("validated abc123, now def456");
  });
});
