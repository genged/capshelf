import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ConfigValue } from "../src/config-values";
import { tempDir } from "./cli-fixtures";

const workflow: ConfigValue = parse(
  await readFile(
    join(import.meta.dir, "../.github/workflows/release-lane.yml"),
    "utf8",
  ),
);
const publication = z
  .object({
    jobs: z.object({
      publish: z.object({
        steps: z.array(
          z.object({ name: z.string(), run: z.string().optional() }),
        ),
      }),
    }),
  })
  .parse(workflow)
  .jobs.publish.steps.find(
    (step) => step.name === "Publish GitHub release assets",
  );
const publishScript = z.string().parse(publication?.run);

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  'release view') exit 0 ;;
  'release edit') exit 0 ;;
  'release upload') exit "$UPLOAD_EXIT_CODE" ;;
  *) exit 1 ;;
esac
`;

describe("release publication", () => {
  test.each([
    0, 1,
  ])("a draft is published only after upload succeeds (exit %s)", async (uploadExitCode) => {
    const dir = await tempDir("capshelf-release-publication-");
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), GH_STUB);
    await chmod(join(bin, "gh"), 0o755);
    const callsFile = join(dir, "calls");
    const result = Bun.spawnSync({
      cmd: ["bash", "-e", "-c", publishScript],
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TAG: "v1.2.3",
        VERSION: "1.2.3",
        GH_CALLS: callsFile,
        UPLOAD_EXIT_CODE: String(uploadExitCode),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(uploadExitCode);
    const calls = await readFile(callsFile, "utf8");
    if (uploadExitCode === 0) {
      expect(calls.trim().split("\n").at(-1)).toBe(
        "release edit v1.2.3 --draft=false",
      );
    } else {
      expect(calls).not.toContain("--draft=false");
    }
  });
});
