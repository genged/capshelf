import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigObject, ConfigValue } from "../src/config-values";
import { tempDir } from "./cli-fixtures";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const REPOSITORY = "owner/repo";
const TAG = "v1.2.3";
const COMMIT_ENDPOINT = `repos/${REPOSITORY}/commits/refs/tags/${TAG}`;
const TAGS_ENDPOINT = `repos/${REPOSITORY}/tags?per_page=100`;
const RELEASES_ENDPOINT = `repos/${REPOSITORY}/releases?per_page=100`;
const TEST_ENDPOINT = `repos/${REPOSITORY}/actions/workflows/test.yml/runs?head_sha=${SHA}&per_page=100`;

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
test "$1" = api
endpoint="$2"
shift 2
expression='.'
slurp=false
paginate=false
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) expression="$2"; shift 2 ;;
    --slurp) slurp=true; shift ;;
    --paginate) paginate=true; shift ;;
    *) printf 'unexpected argument: %s\\n' "$1" >&2; exit 1 ;;
  esac
done
route="$(jq -ce --arg endpoint "$endpoint" '.[$endpoint] // error("unexpected endpoint: " + $endpoint)' "$GH_ROUTES")"
code="$(jq -r '.exitCode // 0' <<< "$route")"
if [ "$code" != 0 ]; then
  printf 'injected API failure\\n' >&2
  exit "$code"
fi
if [ "$slurp" = true ]; then
  test "$paginate" = true
  jq '.pages' <<< "$route"
else
  jq '.pages[0]' <<< "$route" | jq -r "$expression"
fi
`;

type Routes = Record<string, { pages?: ConfigValue[]; exitCode?: number }>;

async function runScript(
  script: string,
  routes: Routes,
  eventName = "push",
  event: ConfigValue = {},
) {
  const dir = await tempDir("capshelf-release-coordination-");
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), GH_STUB);
  await chmod(join(bin, "gh"), 0o755);
  await writeFile(join(dir, "routes.json"), JSON.stringify(routes));
  await writeFile(join(dir, "event.json"), JSON.stringify(event));
  const output = join(dir, "output");
  await writeFile(output, "");
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      join(import.meta.dir, "../scripts", script),
      REPOSITORY,
      TAG,
      SHA,
    ],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_ROUTES: join(dir, "routes.json"),
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_REF: `refs/tags/${TAG}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const outputs = Object.fromEntries(
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const equals = line.indexOf("=");
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
  };
}

function completedEvent(overrides: ConfigObject = {}): ConfigValue {
  return {
    workflow_run: {
      conclusion: "success",
      event: "push",
      head_sha: SHA,
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      ...overrides,
    },
  };
}

function testRun(overrides: ConfigObject = {}): ConfigValue {
  return {
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function eligibilityRoutes(runs: ConfigValue[] = [testRun()]): Routes {
  return {
    [COMMIT_ENDPOINT]: { pages: [{ sha: SHA }] },
    [RELEASES_ENDPOINT]: { pages: [[]] },
    [TEST_ENDPOINT]: { pages: [{ workflow_runs: runs }] },
  };
}

const tagRoutes: Routes = {
  [TAGS_ENDPOINT]: { pages: [[{ name: TAG, commit: { sha: SHA } }]] },
};

function parseTargets(outputs: Record<string, string>): ConfigValue {
  const targets = outputs.targets;
  if (targets === undefined) throw new Error("Missing release targets output");
  const parsed: ConfigValue = JSON.parse(targets);
  return parsed;
}

const ineligibleCompletions: ConfigObject[] = [
  { conclusion: "failure" },
  { conclusion: "cancelled" },
  { event: "pull_request" },
  { repository: { full_name: "other/repo" } },
  { head_repository: { full_name: "fork/repo" } },
];

const unrelatedRuns: ConfigObject[] = [
  { head_sha: OTHER_SHA },
  { head_repository: { full_name: "fork/repo" } },
  { event: "pull_request" },
];

describe("release event coordination", () => {
  test("tag first defers, then successful Test completion makes it eligible", async () => {
    const request = await runScript("resolve-release-request.sh", {
      [COMMIT_ENDPOINT]: { pages: [{ sha: SHA }] },
    });
    expect(request.exitCode).toBe(0);
    const pending = await runScript(
      "prepare-release.sh",
      eligibilityRoutes([testRun({ status: "in_progress", conclusion: null })]),
    );
    expect(pending.exitCode).toBe(0);
    expect(pending.outputs.ready).toBe("false");
    expect(pending.stdout).toContain("Deferred until Test completes");
    const completion = await runScript(
      "resolve-release-request.sh",
      tagRoutes,
      "workflow_run",
      completedEvent(),
    );
    expect(completion.exitCode).toBe(0);
    expect(completion.outputs.targets).toBe(request.outputs.targets);
    const ready = await runScript("prepare-release.sh", eligibilityRoutes());
    expect(ready.exitCode).toBe(0);
    expect(ready.outputs.ready).toBe("true");
  });

  test("Test first finds no tag, then a tag push makes it eligible", async () => {
    const completion = await runScript(
      "resolve-release-request.sh",
      { [TAGS_ENDPOINT]: { pages: [[]] } },
      "workflow_run",
      completedEvent(),
    );
    expect(completion.exitCode).toBe(0);
    expect(completion.outputs.targets).toBe("[]");
    const request = await runScript("resolve-release-request.sh", {
      [COMMIT_ENDPOINT]: { pages: [{ sha: SHA }] },
    });
    expect(request.exitCode).toBe(0);
    expect(parseTargets(request.outputs)).toEqual([{ tag: TAG, sha: SHA }]);
    const ready = await runScript("prepare-release.sh", eligibilityRoutes());
    expect(ready.exitCode).toBe(0);
    expect(ready.outputs.ready).toBe("true");
  });

  test("manual release uses the input tag", async () => {
    const request = await runScript(
      "resolve-release-request.sh",
      { [COMMIT_ENDPOINT]: { pages: [{ sha: SHA }] } },
      "workflow_dispatch",
      { inputs: { tag: TAG } },
    );
    expect(request.exitCode).toBe(0);
    expect(request.outputs.targets).toContain(TAG);
  });

  test.each(ineligibleCompletions)("ignores an ineligible completion: %j", async (overrides) => {
    const result = await runScript(
      "resolve-release-request.sh",
      {},
      "workflow_run",
      completedEvent(overrides),
    );
    expect(result.exitCode).toBe(0);
    expect(result.outputs.targets).toBe("[]");
  });

  test("manual Test completion finds exact SHA tags across pages", async () => {
    const result = await runScript(
      "resolve-release-request.sh",
      {
        [TAGS_ENDPOINT]: {
          pages: [
            [{ name: "v9.9.9", commit: { sha: OTHER_SHA } }],
            [
              { name: "v1.2.3-rc1", commit: { sha: SHA } },
              { name: TAG, commit: { sha: SHA } },
            ],
          ],
        },
      },
      "workflow_run",
      completedEvent({ event: "workflow_dispatch" }),
    );
    expect(result.exitCode).toBe(0);
    expect(parseTargets(result.outputs)).toEqual([{ tag: TAG, sha: SHA }]);
  });

  test("a repeated request skips a release published by the first request", async () => {
    const first = await runScript("prepare-release.sh", eligibilityRoutes());
    expect(first.outputs.ready).toBe("true");
    const duplicate = await runScript("prepare-release.sh", {
      [COMMIT_ENDPOINT]: { pages: [{ sha: SHA }] },
      [RELEASES_ENDPOINT]: {
        pages: [[], [{ tag_name: TAG, draft: false }]],
      },
    });
    expect(duplicate.exitCode).toBe(0);
    expect(duplicate.outputs.ready).toBe("false");
    expect(duplicate.stdout).toContain("already published");
  });

  test("a draft still needs validation and publication", async () => {
    const result = await runScript("prepare-release.sh", {
      ...eligibilityRoutes(),
      [RELEASES_ENDPOINT]: { pages: [[{ tag_name: TAG, draft: true }]] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.ready).toBe("true");
  });

  test("a missing Test run defers", async () => {
    const result = await runScript("prepare-release.sh", eligibilityRoutes([]));
    expect(result.exitCode).toBe(0);
    expect(result.outputs.ready).toBe("false");
  });

  test.each(["failure", "cancelled", "timed_out"])(
    "a completed %s blocks release",
    async (conclusion) => {
      const result = await runScript(
        "prepare-release.sh",
        eligibilityRoutes([testRun({ conclusion })]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.outputs.ready).toBe("false");
    },
  );

  test.each(unrelatedRuns)("another green run cannot authorize release: %j", async (overrides) => {
    const result = await runScript(
      "prepare-release.sh",
      eligibilityRoutes([testRun(overrides)]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.outputs.ready).toBe("false");
  });

  test("a green Test run on a later page authorizes release", async () => {
    const result = await runScript("prepare-release.sh", {
      ...eligibilityRoutes(),
      [TEST_ENDPOINT]: {
        pages: [
          { workflow_runs: [testRun({ conclusion: "failure" })] },
          { workflow_runs: [testRun()] },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.ready).toBe("true");
  });

  test("a tag moved after discovery blocks release", async () => {
    const result = await runScript("prepare-release.sh", {
      [COMMIT_ENDPOINT]: { pages: [{ sha: OTHER_SHA }] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.outputs.ready).toBe("false");
    expect(result.stderr).toContain("moved");
  });

  test.each([COMMIT_ENDPOINT, RELEASES_ENDPOINT, TEST_ENDPOINT])(
    "an API error at %s is not a deferral",
    async (endpoint) => {
      const result = await runScript("prepare-release.sh", {
        ...eligibilityRoutes(),
        [endpoint]: { exitCode: 2 },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.outputs.ready).toBe("false");
      expect(result.stdout).not.toContain("Deferred");
    },
  );

  test("a tag discovery API error cannot look like no tags", async () => {
    const result = await runScript(
      "resolve-release-request.sh",
      { [TAGS_ENDPOINT]: { exitCode: 1 } },
      "workflow_run",
      completedEvent(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.outputs.targets).toBeUndefined();
  });
});
