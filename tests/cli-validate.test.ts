import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  jsonOutput,
  objectField,
  objectItems,
  runInProcess,
  stringField,
  tempRepo,
} from "./cli-fixtures";

const GOOD = [
  "---",
  "name: good",
  "description: Deploy the service when the user asks to ship.",
  "---",
  "",
  "1. Build. Run `make build` and check that it exits 0.",
  "2. Ship. Run `make ship` and check the deploy log.",
  "",
  "## Troubleshooting",
  "",
  "| Failure | Fix |",
  "|---|---|",
  "| build fails | run `make clean` first |",
  "",
].join("\n");

const STYLE_ONLY = [
  "---",
  "name: prose",
  "description: A skill with prose only.",
  "---",
  "",
  "Do the work.",
  "",
].join("\n");

const BROKEN = [
  "---",
  "name: other",
  "---",
  "",
  "Read [notes](missing.md).",
  "",
].join("\n");

async function shelf(): Promise<{ project: string; dataRepo: string }> {
  const project = await tempRepo("capshelf-validate-project-");
  const dataRepo = await tempRepo("capshelf-validate-data-");
  await addSkill(dataRepo, "good", GOOD);
  await addSkill(dataRepo, "prose", STYLE_ONLY);
  await addSkill(dataRepo, "broken", BROKEN);
  await mkdir(join(dataRepo, "settings", "base"), { recursive: true });
  await writeFile(join(dataRepo, "settings", "base", "settings.json"), "{}\n");
  await commitAll(dataRepo, "items");
  const run = runInProcess(project);
  expect((await run(["init", "--data", dataRepo, "--no-pick"])).exitCode).toBe(
    0,
  );
  return { project, dataRepo };
}

function itemResults(stdout: Buffer): Record<string, string> {
  const report = jsonOutput({ exitCode: 0, stdout, stderr: Buffer.from("") });
  return Object.fromEntries(
    objectItems(report, "items").map((item) => [
      stringField(item, "ref"),
      stringField(item, "result"),
    ]),
  );
}

describe("capshelf validate", () => {
  test(
    "a passing skill exits 0 and reports each check",
    async () => {
      const { project } = await shelf();
      const result = await runInProcess(project)(["validate", "skills/good"]);
      const out = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      expect(out).toContain("skills/good (data repo)  pass");
      for (const id of [
        "frontmatter",
        "name",
        "description",
        "links",
        "steps",
      ]) {
        expect(out).toContain(id);
      }
      expect(out).toContain("1 skill: 1 pass, 0 warn, 0 fail");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "warnings exit 0, and --strict turns them into exit 4",
    async () => {
      const { project } = await shelf();
      const run = runInProcess(project);
      expect((await run(["validate", "prose"])).exitCode).toBe(0);
      expect((await run(["validate", "prose", "--strict"])).exitCode).toBe(4);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "no item validates every data-repo skill; a failure exits 4 with the same facts in JSON",
    async () => {
      const { project } = await shelf();
      const result = await runInProcess(project)(["validate", "--json"]);
      expect(result.exitCode).toBe(4);
      expect(result.stderr.toString()).toBe("");
      expect(itemResults(result.stdout)).toEqual({
        "skills/broken": "fail",
        "skills/good": "pass",
        "skills/prose": "warn",
      });
      const report = jsonOutput(result);
      expect(objectField(report, "summary")).toEqual({
        items: 3,
        pass: 1,
        warn: 1,
        fail: 1,
      });
      const broken = objectItems(report, "items").find(
        (item) => item.ref === "skills/broken",
      );
      expect(broken).toBeDefined();
      const failed = objectItems(broken ?? {}, "checks")
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.id);
      expect(failed).toEqual(["name", "description", "links"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "validate writes nothing to the data repo or the project",
    async () => {
      const { project, dataRepo } = await shelf();
      const before = [
        await $`git -C ${dataRepo} status --porcelain`.text(),
        await $`git -C ${project} status --porcelain --untracked-files=all`.text(),
      ];
      await runInProcess(project)(["validate"]);
      expect([
        await $`git -C ${dataRepo} status --porcelain`.text(),
        await $`git -C ${project} status --porcelain --untracked-files=all`.text(),
      ]).toEqual(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a non-skill item exits 3 and an unknown item exits 2",
    async () => {
      const { project } = await shelf();
      const run = runInProcess(project);
      const settings = await run(["validate", "settings/base"]);
      expect(settings.exitCode).toBe(3);
      expect(settings.stderr.toString()).toContain(
        "validate checks skills only",
      );
      expect((await run(["validate", "base"])).exitCode).toBe(3);
      expect((await run(["validate", "skills/nope"])).exitCode).toBe(2);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--here validates the installed copy, not the data repo",
    async () => {
      const { project } = await shelf();
      const run = runInProcess(project);
      expect((await run(["add", "skills/good"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "good", "SKILL.md");
      await writeFile(installed, GOOD.replace("name: good", "name: edited"));

      const here = await run(["validate", "skills/good", "--here", "--json"]);
      expect(here.exitCode).toBe(4);
      const item = objectItems(jsonOutput(here), "items")[0];
      expect(item?.location).toBe("project");
      expect(item?.result).toBe("fail");

      expect((await run(["validate", "skills/good"])).exitCode).toBe(0);
      expect((await run(["validate", "skills/prose", "--here"])).exitCode).toBe(
        2,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
