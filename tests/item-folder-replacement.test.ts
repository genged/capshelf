import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { materializeLockEntry } from "../src/materialize";
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
import { currentPin } from "./pin-fixtures";

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

const runningAsRoot = process.getuid?.() === 0;

describe("D3: ignored state moves by rename", () => {
  test.skipIf(runningAsRoot)(
    "an update does not read ignored files, and they survive",
    async () => {
      const { dataRepo, run, installed } = await installedSkill({
        gitignore: "node_modules/\n",
      });
      await nodeModules(installed);
      const secret = join(installed, "node_modules", "pkg", "index.js");
      // Unreadable: any read of the bytes fails the command.
      await chmod(secret, 0o000);
      await bump(dataRepo, "v2\n");
      try {
        const update = run(["update", "skills/draw"]);
        expect(update.stderr.toString()).toBe("");
        expect(update.exitCode).toBe(0);
        expect((await lstat(secret)).mode & 0o777).toBe(0o000);
      } finally {
        await chmod(secret, 0o644);
      }
      expect(await file(secret).text()).toBe("pkg\n");
      expect(
        await readlink(join(installed, "node_modules", ".bin", "pkg")),
      ).toBe("../pkg/index.js");
      expect(await file(join(installed, "SKILL.md")).text()).toBe("v2\n");
    },
    T,
  );

  test(
    "a new managed path inside an ignored-only folder keeps the ignored files",
    async () => {
      const { dataRepo, skill, run, installed } = await installedSkill({
        gitignore: "*.log\n",
      });
      await mkdir(join(installed, "logs"));
      await writeFile(join(installed, "logs", "run.log"), "local\n");
      await mkdir(join(skill, "logs"));
      await writeFile(join(skill, "logs", "README.md"), "shipped\n");
      await commitAll(dataRepo, "ship logs/README.md");

      const update = run(["update", "skills/draw"]);
      expect(update.stderr.toString()).toBe("");
      expect(update.exitCode).toBe(0);
      expect(await file(join(installed, "logs", "run.log")).text()).toBe(
        "local\n",
      );
      expect(await file(join(installed, "logs", "README.md")).text()).toBe(
        "shipped\n",
      );
    },
    T,
  );

  test(
    "a failure after publish restores the old managed files and the ignored files",
    async () => {
      const { dataRepo, project, installed } = await installedSkill({
        gitignore: "node_modules/\n",
      });
      await nodeModules(installed);
      await bump(dataRepo, "v2\n");
      const lock = await loadLock(project);
      const key = dataKey("skills", "draw");
      const previous = lock.items[key];
      if (previous === undefined || previous.source !== "data") {
        throw new Error("expected a data lock entry");
      }
      const entry = {
        source: "data" as const,
        appliedAt: previous.appliedAt,
        ...(await currentPin(dataRepo, "skills", "draw")),
      };
      const source = (selected: typeof previous) =>
        contentSourceFor({
          entry: selected,
          kind: "skills",
          name: "draw",
          repo: dataRepo,
        });

      await expect(
        materializeLockEntry({
          project,
          source: source(entry),
          kind: "skills",
          name: "draw",
          key,
          entry,
          previous: { entry: previous, source: source(previous) },
          scope: "project",
          hooks: {
            afterPublish: async () => {
              throw new Error("injected failure after publish");
            },
          },
        }),
      ).rejects.toThrow("injected failure after publish");

      expect(await file(join(installed, "SKILL.md")).text()).toBe("v1\n");
      expect(
        await file(join(installed, "node_modules", "pkg", "index.js")).text(),
      ).toBe("pkg\n");
      expect(
        await readlink(join(installed, "node_modules", ".bin", "pkg")),
      ).toBe("../pkg/index.js");
      expect(
        (await readdir(dirname(installed))).filter((name) =>
          name.startsWith(".capshelf-"),
        ),
      ).toEqual([]);
    },
    T,
  );
});

describe("D4 and D11: the consent snapshot", () => {
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
    "a write to an ignored file between plan and write keeps the plan valid",
    async () => {
      const { dataRepo, project, installed } = await installedSkill({
        gitignore: "node_modules/\n",
      });
      await nodeModules(installed);
      const accepted = await plan(project, dataRepo);
      await writeFile(
        join(installed, "node_modules", "pkg", "index.js"),
        "rebuilt\n",
      );
      assertDestructivePlanUnchanged(accepted, await plan(project, dataRepo));
    },
    T,
  );

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

/**
 * A Go module cache style tree: folders 0555, files 0444. Linux refuses to
 * move a read-only folder to a new parent, and a delete cannot remove the
 * entries of a read-only folder. Root bypasses both checks.
 */
async function readOnlyTree(base: string): Promise<string> {
  const module = join(base, "github.com", "x", "y@v1.0.0");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "y.go"), "package y\n");
  await chmod(join(module, "y.go"), 0o444);
  for (const folder of [
    module,
    join(base, "github.com", "x"),
    join(base, "github.com"),
  ]) {
    await chmod(folder, 0o555);
  }
  return join(module, "y.go");
}

async function makeWritable(path: string): Promise<void> {
  await $`chmod -R u+w ${path}`.quiet().nothrow();
}

describe("read-only folders", () => {
  test.skipIf(runningAsRoot)(
    "an update keeps an ignored read-only folder in place",
    async () => {
      const { dataRepo, run, installed } = await installedSkill({
        gitignore: "gomod/\n",
      });
      const gomod = join(installed, "gomod");
      await mkdir(gomod);
      const source = await readOnlyTree(gomod);
      await chmod(gomod, 0o555);
      await bump(dataRepo, "v2\n");
      try {
        const update = run(["update", "skills/draw"]);
        expect(update.stderr.toString()).toBe("");
        expect(update.exitCode).toBe(0);
        expect(await file(source).text()).toBe("package y\n");
        expect((await lstat(gomod)).mode & 0o777).toBe(0o555);
        expect(await file(join(installed, "SKILL.md")).text()).toBe("v2\n");
      } finally {
        await makeWritable(installed);
      }
    },
    T,
  );

  test.skipIf(runningAsRoot)(
    "rm deletes a read-only tree",
    async () => {
      const { run, installed } = await installedSkill({
        gitignore: "gomod/\n",
      });
      await readOnlyTree(join(installed, "gomod"));
      try {
        const rm = run(["rm", "skills/draw", "--yes"]);
        expect(rm.stderr.toString()).toBe("");
        expect(rm.exitCode).toBe(0);
        expect(await file(join(installed, "SKILL.md")).exists()).toBe(false);
      } finally {
        await makeWritable(installed);
      }
    },
    T,
  );

  test.skipIf(runningAsRoot)(
    "a consented update deletes a visible read-only tree and leaves no scratch folder",
    async () => {
      const { dataRepo, run, installed } = await installedSkill({
        gitignore: null,
      });
      await readOnlyTree(join(installed, "gomod"));
      await bump(dataRepo, "v2\n");
      try {
        const update = run(["update", "skills/draw", "--yes"]);
        expect(update.stderr.toString()).toBe("");
        expect(update.exitCode).toBe(0);
        expect(await readdir(installed)).toEqual(["SKILL.md"]);
        const scratch = (await readdir(dirname(installed))).filter((name) =>
          name.startsWith(".capshelf-"),
        );
        expect(scratch).toEqual([]);
      } finally {
        await makeWritable(dirname(installed));
      }
    },
    T,
  );
});

describe("D7: rm and init", () => {
  test(
    "rm JSON has no keptMountPoints without a mount",
    async () => {
      const { run } = await installedSkill({ gitignore: null });
      const rm = run(["rm", "skills/draw", "--json", "--yes"]);
      expect(rm.exitCode).toBe(0);
      expect(jsonOutput(rm)).not.toHaveProperty("keptMountPoints");
    },
    T,
  );

  test.skipIf(runningAsRoot)(
    "a failed rm keeps the alias and the lock row, and a rerun finishes",
    async () => {
      const { project, run, installed } = await installedSkill({
        gitignore: null,
      });
      const alias = join(project, ".claude", "skills", "draw");
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      // The delete cannot remove the item folder from a read-only parent.
      const stuck = dirname(installed);
      await chmod(stuck, 0o555);
      try {
        const rm = run(["rm", "skills/draw", "--yes"]);
        expect(rm.exitCode).toBe(1);
        expect(rm.stderr.toString()).toContain(
          "a rerun of this command finishes the removal",
        );
        expect((await lstat(alias)).isSymbolicLink()).toBe(true);
        const lock = await loadLock(project);
        expect(lock.items[dataKey("skills", "draw")]).toBeDefined();
      } finally {
        await chmod(stuck, 0o755);
      }
      expect(run(["rm", "skills/draw", "--yes"]).exitCode).toBe(0);
    },
    T,
  );

  test(
    "an init re-run keeps ignored files in the system skill folder",
    async () => {
      const dataRepo = await baselineRepo("capshelf-init-data-");
      const project = await tempRepo("capshelf-init-project-", {
        origin: null,
      });
      await writeFile(
        join(project, ".gitignore"),
        ".agents/skills/capshelf/node_modules/\n",
      );
      await commitAll(project, "ignore");
      const run = runIn(project);
      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      const kept = join(
        project,
        ".agents",
        "skills",
        "capshelf",
        "node_modules",
        "cache.js",
      );
      await mkdir(dirname(kept), { recursive: true });
      await writeFile(kept, "local\n");
      // A fresh clone has the committed lock but no clone-local config.
      await $`rm ${join(project, ".capshelf", "local.json")}`.quiet();

      const again = run(["init", "--data", dataRepo, "--no-upstream"]);
      expect(again.stderr.toString()).toBe("");
      expect(again.exitCode).toBe(0);
      expect(await file(kept).text()).toBe("local\n");
    },
    T,
  );
});
