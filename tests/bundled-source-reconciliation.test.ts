import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findSystemItem, shaOfSystemItem } from "../src/bundled";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { shaOfInstalled } from "../src/installed";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

const BUNDLED_SKILL = findSystemItem("capshelf")!;
const BUNDLED_CONTENT = BUNDLED_SKILL.files[0]!.content;

interface SupersededProject {
  run: ReturnType<typeof runInProcess>;
  project: string;
  installed: string;
  lockPath: string;
  /** The sha the lock pins: content this binary no longer bundles. */
  supersededSha: string;
}

/**
 * A project whose system item is pinned to bundled content the running binary
 * no longer carries, with the install still holding exactly that content.
 *
 * This is the state an ordinary capshelf upgrade produces, and it cannot be
 * built by driving the CLI: the binary bundles one version of the skill, so the
 * superseded one has to be written directly. Editing the lock is the documented
 * fixture exception — the entry is what is under test.
 */
async function supersededSystemProject(
  prefix: string,
): Promise<SupersededProject> {
  const project = await tempRepo(`${prefix}-project-`);
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const run = runInProcess(project);
  await addSkill(dataRepo, "hello", "hello v1\n");
  await commitAll(dataRepo, "hello v1");
  expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
  expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

  const installed = join(project, ".agents", "skills", "capshelf", "SKILL.md");
  await writeFile(installed, "---\nname: capshelf\n---\n\nolder bundle\n");
  const supersededSha = (await shaOfInstalled(project, "skills", "capshelf"))!;
  expect(supersededSha).not.toBe(await shaOfSystemItem(BUNDLED_SKILL));

  const lockPath = join(project, ".capshelf", "capshelf.lock.json");
  const lock = await file(lockPath).json();
  lock.items["system/skills/capshelf"].sha = supersededSha;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  return { run, project, installed, lockPath, supersededSha };
}

describe("update moves a system item off superseded bundled content", () => {
  test(
    "converges a pristine install with no destructive prompt",
    async () => {
      const { run, installed, lockPath } = await supersededSystemProject(
        "capshelf-superseded-pristine",
      );

      // runInProcess is non-interactive: any reported destructive change would
      // refuse with exit 3 instead of prompting, so exit 0 is the assertion
      // that the pristine rule fired.
      const updated = await run(["update", "skills/capshelf", "--json"]);
      expect(updated.exitCode).toBe(0);
      const report = JSON.parse(updated.stdout.toString()) as {
        items: Array<{ key: string; action: string }>;
        destructiveChanges: unknown[];
      };
      expect(report.destructiveChanges).toEqual([]);
      expect(
        report.items.find((item) => item.key === "system/skills/capshelf"),
      ).toMatchObject({ action: "updated" });

      expect(await file(installed).text()).toBe(BUNDLED_CONTENT);
      const lock = await file(lockPath).json();
      expect(lock.items["system/skills/capshelf"].sha).toBe(
        await shaOfSystemItem(BUNDLED_SKILL),
      );
      expect((await run(["status", "--json"])).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "still gates a hand-edited install and converges under --yes",
    async () => {
      const { run, installed } = await supersededSystemProject(
        "capshelf-superseded-drifted",
      );
      await writeFile(installed, "---\nname: capshelf\n---\n\nmy own edit\n");

      const dryRun = await run([
        "update",
        "skills/capshelf",
        "--dry-run",
        "--json",
      ]);
      expect(dryRun.exitCode).toBe(0);
      const report = JSON.parse(dryRun.stdout.toString()) as {
        destructiveChanges: Array<{
          scope: string;
          item?: string;
          path: string;
          reason: string;
          reviewCommand?: string;
        }>;
      };
      expect(report.destructiveChanges).toContainEqual({
        scope: "project",
        item: "project/system/skills/capshelf",
        path: ".agents/skills/capshelf/SKILL.md",
        reason: "managed_content",
        reviewCommand: "capshelf status skills/capshelf --diff",
      });

      const refused = await run(["update", "skills/capshelf", "--json"]);
      expect(refused.exitCode).toBe(3);
      expect(await file(installed).text()).toContain("my own edit");

      const accepted = await run(["update", "skills/capshelf", "--yes"]);
      expect(accepted.exitCode).toBe(0);
      expect(await file(installed).text()).toBe(BUNDLED_CONTENT);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "aborts when the install changes between the prompt and the write",
    async () => {
      const { run, installed } = await supersededSystemProject(
        "capshelf-superseded-revalidate",
      );
      await writeFile(installed, "---\nname: capshelf\n---\n\nmy own edit\n");

      setDestructiveConfirmationContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async () => {
          await writeFile(
            installed,
            "---\nname: capshelf\n---\n\nlater edit\n",
          );
          return "y";
        },
        stderr: { write: () => true },
      });
      try {
        const raced = await run(["update", "skills/capshelf"]);
        expect(raced.exitCode).toBe(3);
        expect(raced.stderr.toString()).toContain(
          "local state changed after destructive-change preflight",
        );
      } finally {
        setDestructiveConfirmationContext(null);
      }
      expect(await file(installed).text()).toContain("later edit");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--dry-run reports the move without writing the lock or the file",
    async () => {
      const { run, installed, lockPath, supersededSha } =
        await supersededSystemProject("capshelf-superseded-dry-run");
      const lockBefore = await file(lockPath).text();
      const installedBefore = await file(installed).text();

      const dryRun = await run([
        "update",
        "skills/capshelf",
        "--dry-run",
        "--json",
      ]);
      expect(dryRun.exitCode).toBe(0);
      const report = JSON.parse(dryRun.stdout.toString()) as {
        items: Array<{ key: string; action: string; lockedSha?: string }>;
        destructiveChanges: unknown[];
      };
      expect(
        report.items.find((item) => item.key === "system/skills/capshelf"),
      ).toMatchObject({ action: "would-update", lockedSha: supersededSha });
      expect(report.destructiveChanges).toEqual([]);
      expect(await file(lockPath).text()).toBe(lockBefore);
      expect(await file(installed).text()).toBe(installedBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("apply still refuses content the binary no longer carries", () => {
  test(
    "errors for the system item, names update, and applies the rest",
    async () => {
      const { run } = await supersededSystemProject(
        "capshelf-superseded-apply",
      );

      const applied = await run(["apply", "--json"]);
      expect(applied.exitCode).toBe(1);
      const report = JSON.parse(applied.stdout.toString()) as {
        items: Array<{ key: string; action: string; error?: string }>;
      };
      const system = report.items.find(
        (item) => item.key === "system/skills/capshelf",
      )!;
      expect(system.action).toBe("error");
      expect(system.error).toContain("superseded bundled content");
      expect(system.error).toContain("capshelf update skills/capshelf");
      expect(
        report.items.find((item) => item.key === "data/skills/hello"),
      ).toMatchObject({ action: "already-current" });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "keeps the data-item retrieval check strict",
    async () => {
      const project = await tempRepo("capshelf-data-retrieval-project-");
      const dataRepo = await tempRepo("capshelf-data-retrieval-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "hello v1\n");
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lock = await file(lockPath).json();
      lock.items["data/skills/hello"].sha = "0123456789ab";
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

      const applied = await run(["apply", "skills/hello", "--json"]);
      expect(applied.exitCode).toBe(1);
      const report = JSON.parse(applied.stdout.toString()) as {
        items: Array<{ key: string; action: string; error?: string }>;
      };
      expect(report.items[0]!.action).toBe("error");
      expect(report.items[0]!.error).toMatch(
        /source skills\/hello at [0-9a-f]+ hashes to [0-9a-f]+, but lock expects 0123456789ab/,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
