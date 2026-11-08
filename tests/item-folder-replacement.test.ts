import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDestructivePlanUnchanged,
  createDestructiveChangePlan,
} from "../src/destructive-change";
import { planCopyDirectoryDestruction } from "../src/destructive-preflight";
import {
  itemErrorFields,
  itemErrorsExitCode,
  PreconditionError,
} from "../src/errors";
import { contentSourceFor } from "../src/item-source";
import { dataKey, loadLock } from "../src/lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  jsonOutput,
  objectItems,
  runIn,
  tempRepo,
} from "./cli-fixtures";

const T = CLI_INTEGRATION_TEST_TIMEOUT_MS;

/**
 * A data repo with `skills/draw`, and a project that installed it.
 * `gitignore` is the skill's own `.gitignore`, or null for none.
 */
async function installedSkill(opts: {
  gitignore: string | null;
  local?: boolean;
  rootGitignore?: string;
}) {
  const dataRepo = await baselineRepo("capshelf-fold-data-");
  const skill = await addSkill(dataRepo, "draw", "v1\n");
  if (opts.gitignore !== null) {
    await writeFile(join(skill, ".gitignore"), opts.gitignore);
  }
  await commitAll(dataRepo, "add draw");
  const project = await tempRepo("capshelf-fold-project-", { origin: null });
  if (opts.rootGitignore !== undefined) {
    await writeFile(join(project, ".gitignore"), opts.rootGitignore);
    await commitAll(project, "ignore");
  }
  const run = runIn(project);
  expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(0);
  expect(
    run(["add", "skills/draw", ...(opts.local ? ["--local"] : [])]).exitCode,
  ).toBe(0);
  const installed = join(project, ".agents", "skills", "draw");
  return { dataRepo, skill, project, run, installed };
}

async function bump(dataRepo: string, text: string): Promise<void> {
  await addSkill(dataRepo, "draw", text);
  await commitAll(dataRepo, `draw ${text.trim()}`);
}

/** `node_modules` the way npm leaves it: a package and a `.bin` symlink. */
async function nodeModules(installed: string): Promise<void> {
  await mkdir(join(installed, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(installed, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(installed, "node_modules", "pkg", "index.js"), "pkg\n");
  await symlink(
    "../pkg/index.js",
    join(installed, "node_modules", ".bin", "pkg"),
  );
}

describe("D11: the consent snapshot", () => {
  async function plan(project: string, dataRepo: string) {
    const lock = await loadLock(project);
    const key = dataKey("skills", "draw");
    const entry = lock.items[key];
    if (entry === undefined) throw new Error("expected a lock entry");
    const source = contentSourceFor({
      entry,
      kind: "skills",
      name: "draw",
      repo: dataRepo,
    });
    const planned = await planCopyDirectoryDestruction({
      project,
      currentSource: source,
      selectedSource: source,
      kind: "skills",
      name: "draw",
      key,
      scope: "project",
      currentEntry: entry,
      selectedEntry: entry,
      reviewCommand: "capshelf status skills/draw --diff",
    });
    return createDestructiveChangePlan(planned.changes, planned.snapshotParts);
  }

  test(
    "a managed file changed between plan and write refuses and is named",
    async () => {
      const { dataRepo, project, installed } = await installedSkill({
        gitignore: "node_modules/\n",
      });
      const accepted = await plan(project, dataRepo);
      await writeFile(join(installed, "SKILL.md"), "edited\n");
      const current = await plan(project, dataRepo);
      expect(() => assertDestructivePlanUnchanged(accepted, current)).toThrow(
        `changed: ${join(installed, "SKILL.md")}`,
      );
    },
    T,
  );
});

describe("D9: per-item errors keep their hint and exit code", () => {
  const canMkfifo = spawnSync("mkfifo", ["--help"]).status === 0;

  test.skipIf(!canMkfifo)(
    "update and apply print the hint, put it in JSON, and exit 3",
    async () => {
      const { dataRepo, run, installed } = await installedSkill({
        gitignore: "node_modules/\n",
      });
      expect(spawnSync("mkfifo", [join(installed, "pipe")]).status).toBe(0);
      await bump(dataRepo, "v2\n");

      // A sweep reports the refusal as a per-item row.
      const update = run(["update"]);
      expect(update.exitCode).toBe(3);
      expect(update.stdout.toString()).toContain(
        "Remove or relocate the path, then rerun the command.",
      );

      const json = run(["update", "--json"]);
      expect(json.exitCode).toBe(3);
      const row = objectItems(jsonOutput(json), "items").find(
        (item) => item.action === "error",
      );
      expect(row?.action).toBe("error");
      expect(String(row?.hint)).toContain("Remove or relocate the path");
      expect(row).not.toHaveProperty("exitCode");

      const apply = run(["apply", "--json"]);
      expect(apply.exitCode).toBe(3);
      const applyRow = objectItems(jsonOutput(apply), "items").find(
        (item) => item.action === "error",
      );
      expect(String(applyRow?.hint)).toContain("Remove or relocate the path");
      expect(applyRow).not.toHaveProperty("exitCode");
    },
    T,
  );

  test("the exit code is the shared one, or 1 for a mix", () => {
    const precondition = {
      action: "error",
      ...itemErrorFields(new PreconditionError("no", { hint: "fix it" })),
    };
    const plain = { action: "error", ...itemErrorFields(new Error("boom")) };
    expect(precondition.hint).toBe("fix it");
    expect(itemErrorsExitCode([precondition, precondition])).toBe(3);
    expect(itemErrorsExitCode([precondition, plain])).toBe(1);
    expect(itemErrorsExitCode([plain])).toBe(1);
    expect(itemErrorsExitCode([{ action: "updated" }, precondition])).toBe(3);
  });
});

describe("D10: one visibility rule for installed files", () => {
  for (const local of [false, true]) {
    test(
      `a root .gitignore ignores node_modules with a .bin symlink (${local ? "local" : "project"} scope)`,
      async () => {
        const { dataRepo, run, installed } = await installedSkill({
          gitignore: null,
          rootGitignore: "node_modules/\n",
          local,
        });
        await nodeModules(installed);
        await bump(dataRepo, "v2\n");
        const update = run([
          "update",
          "skills/draw",
          ...(local ? ["--local"] : []),
        ]);
        expect(update.stdout.toString()).not.toContain("unsupported symlink");
        expect(update.exitCode).toBe(0);
        expect(
          await readlink(join(installed, "node_modules", ".bin", "pkg")),
        ).toBe("../pkg/index.js");
        expect(await file(join(installed, "SKILL.md")).text()).toBe("v2\n");
      },
      T,
    );
  }

  test(
    "local scope honors core.excludesFile",
    async () => {
      const { dataRepo, project, run, installed } = await installedSkill({
        gitignore: null,
        local: true,
      });
      const excludes = join(project, ".git", "global-ignore");
      await writeFile(excludes, "node_modules/\n");
      await $`git -C ${project} config core.excludesFile ${excludes}`.quiet();
      await nodeModules(installed);
      await bump(dataRepo, "v2\n");
      const update = run(["update", "--local", "skills/draw"]);
      expect(update.exitCode).toBe(0);
      expect(
        await file(join(installed, "node_modules", "pkg", "index.js")).text(),
      ).toBe("pkg\n");
    },
    T,
  );
});

describe("D12: status shows visible extra files", () => {
  test(
    "text, JSON, and --strict",
    async () => {
      const { run, installed } = await installedSkill({ gitignore: null });
      await mkdir(join(installed, "build"));
      await writeFile(join(installed, "build", "out.js"), "out\n");

      const text = run(["status"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout.toString()).toContain("up-to-date, 1 extra file");
      expect(text.stdout.toString()).toContain(
        "! 1 file is not part of the item, and Git can see them.",
      );
      expect(text.stdout.toString()).toContain("build/out.js");
      expect(text.stdout.toString()).toContain(
        "To keep them, add them to a .gitignore file.",
      );

      const json = run(["status", "--json"]);
      const row = objectItems(jsonOutput(json), "items").find(
        (item) => item.name === "draw",
      );
      expect(row?.visibleExtras).toEqual(["build/out.js"]);
      expect(row?.installation).toBe("visible-extra");

      expect(run(["status", "--strict"]).exitCode).toBe(4);
    },
    T,
  );

  test(
    "a kept-local row does not fail --strict for visible extras",
    async () => {
      const { run, installed } = await installedSkill({ gitignore: null });
      await writeFile(join(installed, "SKILL.md"), "mine\n");
      await writeFile(join(installed, "extra.md"), "extra\n");
      expect(
        run(["keep-local", "skills/draw", "--reason", "ours"]).exitCode,
      ).toBe(0);
      expect(run(["status", "--strict"]).exitCode).toBe(0);
    },
    T,
  );
});
