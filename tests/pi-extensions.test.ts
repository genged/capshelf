import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { installedPath } from "../src/installed";
import { parseItemRef } from "../src/item-ref";
import {
  isStrictRuntimeWarning,
  runtimeWarningsForItem,
  type RuntimeWarningType,
} from "../src/runtime-warnings";
import { listMasterItems, shaOfGitVisibleItem } from "../src/master";
import { lastTouchingContentCommit, lastTouchingCommit } from "../src/git";

async function tempDir(prefix: string): Promise<string> {
  // macOS exposes tmpdir() through /var, which resolves to /private/var. The
  // CLI reports canonical project paths, so fixtures must use canonical paths.
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function tempRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const cli = join(import.meta.dir, "..", "src", "cli.ts");

function runCli(
  project: string,
  home: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd: project,
    env: { ...process.env, HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function expectWarningTypes(
  value: { runtimeWarnings?: Array<{ type: RuntimeWarningType }> },
  expected: RuntimeWarningType[],
): void {
  expect(
    (value.runtimeWarnings ?? []).map((warning) => warning.type).sort(),
  ).toEqual([...expected].sort());
}

describe("pi extension item contracts", () => {
  test("discovers only directory extensions with index.ts and maps their paths", async () => {
    const dataRepo = await tempRepo("capshelf-pi-catalog-");
    await mkdir(join(dataRepo, "pi", "extensions", "guard", "src"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "pi", "extensions", "guard", "index.ts"),
      "export default function guard() {}\n",
    );
    await writeFile(
      join(dataRepo, "pi", "extensions", "guard", "src", "rules.ts"),
      "export const rules = [];\n",
    );
    await mkdir(join(dataRepo, "pi", "extensions", "missing-entry"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "pi", "extensions", "missing-entry", "readme.md"),
      "not installable\n",
    );

    const items = await listMasterItems(dataRepo, "pi-extensions");
    expect(items.map((item) => item.name)).toEqual(["guard"]);
    expect(items[0]?.repoRelPath).toBe("pi/extensions/guard");
    expect(parseItemRef("pi-extensions/guard")).toEqual({
      kind: "pi-extensions",
      name: "guard",
    });
    expect(installedPath("/project", "pi-extensions", "guard")).toBe(
      "/project/.pi/extensions/guard",
    );
  });

  test("hashes nested content while excluding only the root sidecar from identity and sourceCommit", async () => {
    const dataRepo = await tempRepo("capshelf-pi-identity-");
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(join(extension, "src"), { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default 1;\n");
    await writeFile(
      join(extension, "src", "rules.ts"),
      "export const a = 1;\n",
    );
    await commitAll(dataRepo, "extension content");

    const contentCommit = await lastTouchingContentCommit(
      dataRepo,
      "pi/extensions/guard",
    );
    const initialSha = await shaOfGitVisibleItem(
      dataRepo,
      "pi/extensions/guard",
    );

    await writeFile(join(extension, ".capshelf.yml"), "tags: [safety]\n");
    await commitAll(dataRepo, "catalog metadata");
    expect(await lastTouchingCommit(dataRepo, "pi/extensions/guard")).not.toBe(
      contentCommit,
    );
    expect(
      await lastTouchingContentCommit(dataRepo, "pi/extensions/guard"),
    ).toBe(contentCommit);
    expect(await shaOfGitVisibleItem(dataRepo, "pi/extensions/guard")).toBe(
      initialSha,
    );

    await writeFile(
      join(extension, "src", ".capshelf.yml"),
      "nested content\n",
    );
    expect(await shaOfGitVisibleItem(dataRepo, "pi/extensions/guard")).not.toBe(
      initialSha,
    );
  });

  test("dependency and executable-code warnings are structured and advisory", async () => {
    const project = await tempDir("capshelf-pi-warning-project-");
    const extension = installedPath(project, "pi-extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default 1;\n");
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3.0.0" } }),
    );

    const warnings = runtimeWarningsForItem(project, "pi-extensions", "guard");
    expectWarningTypes({ runtimeWarnings: warnings }, [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);
    expect(
      warnings.every((warning) => warning.path === ".pi/extensions/guard"),
    ).toBe(true);
    expect(warnings.every((warning) => !isStrictRuntimeWarning(warning))).toBe(
      true,
    );

    for (const packageJson of [
      { dependencies: {} },
      { devDependencies: { zod: "^3.0.0" } },
    ]) {
      await writeFile(
        join(extension, "package.json"),
        JSON.stringify(packageJson),
      );
      expectWarningTypes(
        {
          runtimeWarnings: runtimeWarningsForItem(
            project,
            "pi-extensions",
            "guard",
          ),
        },
        ["pi_extension_executes_code"],
      );
    }
    await writeFile(join(extension, "package.json"), "not json\n");
    expectWarningTypes(
      {
        runtimeWarnings: runtimeWarningsForItem(
          project,
          "pi-extensions",
          "guard",
        ),
      },
      ["pi_extension_executes_code"],
    );
  });
});

describe("pi extension CLI lifecycle", () => {
  test("adds, warns, detects drift, promotes, updates, reverts, and removes", async () => {
    const home = await tempDir("capshelf-pi-home-");
    const dataRepo = await tempRepo("capshelf-pi-data-");
    const project = await tempRepo("capshelf-pi-project-");
    const extension = join(dataRepo, "pi", "extensions", "path-guard");
    await mkdir(join(extension, "src"), { recursive: true });
    await writeFile(
      join(extension, "index.ts"),
      "export { rules } from './src/rules';\n",
    );
    await writeFile(
      join(extension, "src", "rules.ts"),
      "export const rules = ['v1'];\n",
    );
    await writeFile(
      join(extension, "package.json"),
      `${JSON.stringify({ dependencies: { minimatch: "^10.0.0" } })}\n`,
    );
    await writeFile(
      join(extension, ".capshelf.yml"),
      "description: Protect sensitive paths.\ntags: [safety]\n",
    );
    await commitAll(dataRepo, "path guard v1");

    expect(
      runCli(project, home, ["init", "--data", dataRepo, "--no-upstream"])
        .exitCode,
    ).toBe(0);

    const listed = runCli(project, home, ["ls", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(
      JSON.parse(listed.stdout).data.some(
        (item: { kind: string; name: string }) =>
          item.kind === "pi-extensions" && item.name === "path-guard",
      ),
    ).toBe(true);
    const listedHuman = runCli(project, home, ["ls"]);
    expect(listedHuman.exitCode).toBe(0);
    expect(listedHuman.stdout).not.toContain(
      "Pi extensions execute arbitrary code",
    );
    const searched = runCli(project, home, ["search", "rules", "--json"]);
    expect(searched.exitCode).toBe(0);
    expect(
      JSON.parse(searched.stdout).results.some(
        (item: { kind: string; name: string }) =>
          item.kind === "pi-extensions" && item.name === "path-guard",
      ),
    ).toBe(true);

    const shown = runCli(project, home, ["show", "pi-extensions/path-guard"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(
      "warning: Pi extensions execute arbitrary code",
    );
    expect(shown.stdout).toContain(
      "warning: pi extension declares package dependencies",
    );
    expect(shown.stdout.indexOf("warning: Pi extensions")).toBeLessThan(
      shown.stdout.indexOf("─── index.ts"),
    );
    expect(shown.stdout).toContain("─── src/rules.ts");
    expect(shown.stdout).not.toContain("─── .capshelf.yml");

    const shownJson = runCli(project, home, [
      "show",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(shownJson.exitCode).toBe(0);
    expectWarningTypes(JSON.parse(shownJson.stdout), [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);

    const local = runCli(project, home, [
      "add",
      "pi-extensions/path-guard",
      "--local",
    ]);
    expect(local.exitCode).toBe(3);
    expect(local.stderr).toContain(
      "local scope is not supported for pi extensions",
    );

    const installed = join(project, ".pi", "extensions", "path-guard");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "index.ts"), "unmanaged\n");
    const conflict = runCli(project, home, ["add", "pi-extensions/path-guard"]);
    expect(conflict.exitCode).toBe(3);
    expect(conflict.stderr).toContain(
      "target already exists but is not managed by capshelf",
    );
    await rm(installed, { recursive: true, force: true });

    const added = runCli(project, home, [
      "add",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(added.exitCode).toBe(0);
    const addedJson = JSON.parse(added.stdout);
    expectWarningTypes(addedJson, [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);
    expect(await file(join(installed, "src", "rules.ts")).text()).toContain(
      "v1",
    );
    expect(await file(join(installed, ".capshelf.yml")).exists()).toBe(false);
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.piExtensions).toEqual(["path-guard"]);
    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/pi-extensions/path-guard"].source).toBe("data");

    const addedHuman = runCli(project, home, [
      "add",
      "pi-extensions/path-guard",
    ]);
    expect(addedHuman.exitCode).toBe(0);
    expect(addedHuman.stdout).toContain(
      "warning: Pi extensions execute arbitrary code",
    );
    expect(addedHuman.stdout).toContain(
      "warning: pi extension declares package dependencies",
    );

    const status = runCli(project, home, [
      "status",
      "pi-extensions/path-guard",
      "--strict",
      "--json",
    ]);
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout);
    expect(statusJson.items[0].state).toBe("ok");
    expectWarningTypes(statusJson.items[0], [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);
    const statusHuman = runCli(project, home, [
      "status",
      "pi-extensions/path-guard",
    ]);
    expect(statusHuman.exitCode).toBe(0);
    expect(statusHuman.stdout).toContain(
      "warning: Pi extensions execute arbitrary code",
    );

    const path = runCli(project, home, [
      "get-path",
      "pi-extensions/path-guard",
    ]);
    expect(path.exitCode).toBe(0);
    expect(path.stdout.trim()).toBe(installed);

    await writeFile(join(installed, "stale.ts"), "stale\n");
    const applied = runCli(project, home, [
      "apply",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(await file(join(installed, "stale.ts")).exists()).toBe(false);

    await writeFile(
      join(installed, "src", "rules.ts"),
      "export const rules = ['local'];\n",
    );
    const drift = runCli(project, home, [
      "status",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(JSON.parse(drift.stdout).items[0].state).toBe("drifted_local");

    const keepLocal = runCli(project, home, [
      "keep-local",
      "pi-extensions/path-guard",
    ]);
    expect(keepLocal.exitCode).toBe(3);
    expect(keepLocal.stderr).toContain(
      "keep-local is not supported for pi extensions",
    );

    const promoted = runCli(project, home, [
      "promote",
      "pi-extensions/path-guard",
      "-m",
      "tighten path guard",
      "--json",
    ]);
    expect(promoted.exitCode).toBe(0);
    expectWarningTypes(JSON.parse(promoted.stdout), [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);
    expect(await file(join(extension, "src", "rules.ts")).text()).toContain(
      "local",
    );
    expect(await file(join(extension, ".capshelf.yml")).text()).toContain(
      "safety",
    );
    const promotedHuman = runCli(project, home, [
      "promote",
      "pi-extensions/path-guard",
    ]);
    expect(promotedHuman.exitCode).toBe(0);
    expect(promotedHuman.stdout).toContain(
      "warning: Pi extensions execute arbitrary code",
    );

    await writeFile(
      join(extension, "src", "rules.ts"),
      "export const rules = ['upstream'];\n",
    );
    await commitAll(dataRepo, "path guard upstream");
    const updateAvailable = runCli(project, home, [
      "status",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(JSON.parse(updateAvailable.stdout).items[0].state).toBe(
      "update_available",
    );
    const updated = runCli(project, home, [
      "update",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(updated.exitCode).toBe(0);
    expect(await file(join(installed, "src", "rules.ts")).text()).toContain(
      "upstream",
    );

    await writeFile(join(installed, "src", "rules.ts"), "drift again\n");
    const reverted = runCli(project, home, [
      "revert",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(reverted.exitCode).toBe(0);
    expect(await file(join(installed, "src", "rules.ts")).text()).toContain(
      "upstream",
    );

    const removed = runCli(project, home, [
      "rm",
      "pi-extensions/path-guard",
      "--json",
    ]);
    expect(removed.exitCode).toBe(0);
    expect(await file(installed).exists()).toBe(false);
  });

  test("share defaults to project scope, requires index.ts, and does not edit git excludes", async () => {
    const home = await tempDir("capshelf-pi-share-home-");
    const dataRepo = await tempRepo("capshelf-pi-share-data-");
    const project = await tempRepo("capshelf-pi-share-project-");
    expect(
      runCli(project, home, ["init", "--data", dataRepo, "--no-upstream"])
        .exitCode,
    ).toBe(0);

    const extension = join(project, ".pi", "extensions", "review-tools");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "readme.md"), "draft\n");
    const missingEntry = runCli(project, home, [
      "share",
      "pi-extensions/review-tools",
    ]);
    expect(missingEntry.exitCode).toBe(3);
    expect(missingEntry.stderr).toContain("missing index.ts");
    expect(
      await file(join(dataRepo, "pi", "extensions", "review-tools")).exists(),
    ).toBe(false);

    await writeFile(
      join(extension, "index.ts"),
      "export default function review() {}\n",
    );
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3.0.0" } }),
    );
    const excludePath = join(project, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf-8");
    const shared = runCli(project, home, [
      "share",
      "pi-extensions/review-tools",
      "--json",
    ]);
    expect(shared.exitCode).toBe(0);
    const sharedJson = JSON.parse(shared.stdout);
    expect(sharedJson.scope).toBe("project");
    expectWarningTypes(sharedJson, [
      "pi_extension_executes_code",
      "pi_extension_dependencies_not_installed",
    ]);
    expect(
      await file(
        join(dataRepo, "pi", "extensions", "review-tools", "index.ts"),
      ).text(),
    ).toContain("review");
    expect(await readFile(excludePath, "utf-8")).toBe(excludeBefore);
    const humanExtension = join(project, ".pi", "extensions", "human-review");
    await mkdir(humanExtension, { recursive: true });
    await writeFile(
      join(humanExtension, "index.ts"),
      "export default function review() {}\n",
    );
    const sharedHuman = runCli(project, home, [
      "share",
      "pi-extensions/human-review",
    ]);
    expect(sharedHuman.exitCode).toBe(0);
    expect(sharedHuman.stdout).toContain(
      "warning: Pi extensions execute arbitrary code",
    );
    expect(await readFile(excludePath, "utf-8")).toBe(excludeBefore);

    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.piExtensions).toEqual(["review-tools", "human-review"]);
  });

  test("rejects every local-scope entry point without changing project state", async () => {
    const home = await tempDir("capshelf-pi-scope-home-");
    const dataRepo = await tempRepo("capshelf-pi-scope-data-");
    const project = await tempRepo("capshelf-pi-scope-project-");
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default 1;\n");
    await commitAll(dataRepo, "add guard");

    expect(
      runCli(project, home, ["init", "--data", dataRepo, "--no-upstream"])
        .exitCode,
    ).toBe(0);
    expect(runCli(project, home, ["add", "pi-extensions/guard"]).exitCode).toBe(
      0,
    );

    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const manifestBefore = await readFile(manifestPath, "utf-8");
    const lockBefore = await readFile(lockPath, "utf-8");
    const refusals = [
      ["share", "pi-extensions/unmanaged", "--to", "local"],
      ["move", "pi-extensions/guard", "--to", "local"],
      ["apply", "pi-extensions/guard", "--local"],
      ["update", "pi-extensions/guard", "--local"],
      ["promote", "pi-extensions/guard", "--local"],
      ["revert", "pi-extensions/guard", "--local"],
      ["rm", "pi-extensions/guard", "--local"],
    ];

    for (const args of refusals) {
      const result = runCli(project, home, args);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain(
        "local scope is not supported for pi extensions",
      );
    }
    expect(await readFile(manifestPath, "utf-8")).toBe(manifestBefore);
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    expect(
      await file(
        join(project, ".pi", "extensions", "guard", "index.ts"),
      ).exists(),
    ).toBe(true);
  });

  test("uses the canonical source path for dirty-add and stale-promote guards", async () => {
    const home = await tempDir("capshelf-pi-guards-home-");
    const dataRepo = await tempRepo("capshelf-pi-guards-data-");
    const project = await tempRepo("capshelf-pi-guards-project-");
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default 'v1';\n");
    await commitAll(dataRepo, "guard v1");
    expect(
      runCli(project, home, ["init", "--data", dataRepo, "--no-upstream"])
        .exitCode,
    ).toBe(0);

    await writeFile(join(extension, "index.ts"), "export default 'dirty';\n");
    const dirtyAdd = runCli(project, home, ["add", "pi-extensions/guard"]);
    expect(dirtyAdd.exitCode).toBe(3);
    expect(dirtyAdd.stderr).toContain("uncommitted changes");
    await $`git -C ${dataRepo} checkout -- pi/extensions/guard/index.ts`.quiet();

    expect(runCli(project, home, ["add", "pi-extensions/guard"]).exitCode).toBe(
      0,
    );
    const installed = join(project, ".pi", "extensions", "guard", "index.ts");
    await writeFile(installed, "export default 'local';\n");
    await writeFile(
      join(extension, "index.ts"),
      "export default 'upstream';\n",
    );
    await commitAll(dataRepo, "guard upstream");

    const stale = runCli(project, home, ["promote", "pi-extensions/guard"]);
    expect(stale.exitCode).toBe(3);
    expect(stale.stderr).toContain(
      "changed in the data repo since this project last updated",
    );
    expect(await readFile(join(extension, "index.ts"), "utf-8")).toContain(
      "upstream",
    );

    const overwritten = runCli(project, home, [
      "promote",
      "pi-extensions/guard",
      "--stale-ok",
      "-m",
      "accept local guard",
    ]);
    expect(overwritten.exitCode).toBe(0);
    expect(await readFile(join(extension, "index.ts"), "utf-8")).toContain(
      "local",
    );
  });

  test("never runs package tools, reloads Pi, or edits Pi settings", async () => {
    const home = await tempDir("capshelf-pi-no-exec-home-");
    const dataRepo = await tempRepo("capshelf-pi-no-exec-data-");
    const project = await tempRepo("capshelf-pi-no-exec-project-");
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default 'v1';\n");
    await writeFile(
      join(extension, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3.0.0" } }),
    );
    await commitAll(dataRepo, "guard v1");
    expect(
      runCli(project, home, ["init", "--data", dataRepo, "--no-upstream"])
        .exitCode,
    ).toBe(0);

    const settingsPath = join(project, ".pi", "settings.json");
    const settings = '{"extensions":["./mine.ts"],"packages":["mine"]}\n';
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(settingsPath, settings);

    const shimDir = await tempDir("capshelf-pi-tool-shims-");
    const sentinel = join(shimDir, "invoked");
    const shim =
      '#!/bin/sh\nprintf "%s\\n" "$0" >> "$CAPSHELF_TEST_TOOL_SENTINEL"\nexit 97\n';
    for (const command of ["npm", "npx", "pnpm", "yarn", "bun", "bunx", "pi"]) {
      const path = join(shimDir, command);
      await writeFile(path, shim);
      await chmod(path, 0o755);
    }
    const isolatedEnv = {
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      CAPSHELF_TEST_TOOL_SENTINEL: sentinel,
    };

    const added = runCli(
      project,
      home,
      ["add", "pi-extensions/guard"],
      isolatedEnv,
    );
    expect(added.exitCode).toBe(0);
    const applied = runCli(
      project,
      home,
      ["apply", "pi-extensions/guard"],
      isolatedEnv,
    );
    expect(applied.exitCode).toBe(0);

    await writeFile(join(extension, "index.ts"), "export default 'v2';\n");
    await commitAll(dataRepo, "guard v2");
    const updated = runCli(
      project,
      home,
      ["update", "pi-extensions/guard"],
      isolatedEnv,
    );
    expect(updated.exitCode).toBe(0);

    expect(await readFile(settingsPath, "utf-8")).toBe(settings);
    expect(await file(sentinel).exists()).toBe(false);
    expect(
      await file(
        join(project, ".pi", "extensions", "guard", "node_modules"),
      ).exists(),
    ).toBe(false);
  });
});
