import { describe, expect, test } from "bun:test";
import { $, file } from "bun";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function tempRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await $`git -C ${repo} remote add origin https://example.invalid/${prefix}`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

function run(project: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd: project,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Seed a small but representative OKF bundle (concept doc, index.md, log.md, subdir). */
async function seedBundle(dataRepo: string, name: string): Promise<void> {
  const root = join(dataRepo, "okf", name);
  await mkdir(join(root, "tables"), { recursive: true });
  await writeFile(
    join(root, "index.md"),
    `# ${name}\n\n- [orders](/tables/orders.md)\n`,
  );
  await writeFile(join(root, "log.md"), "## 2026-05-28\n\n- initial bundle\n");
  await writeFile(
    join(root, "tables", "orders.md"),
    "---\ntype: BigQuery Table\ntitle: Orders\n---\n\n# Schema\n",
  );
}

describe("cli okf integration", () => {
  test("add materializes the whole bundle under .okf and status is clean", async () => {
    const project = await tempRepo("capshelf-okf-project-");
    const dataRepo = await tempRepo("capshelf-okf-data-");
    await seedBundle(dataRepo, "sales");
    await commitAll(dataRepo, "okf bundle");

    expect(run(project, ["init", "--data", dataRepo]).exitCode).toBe(0);
    const add = run(project, ["add", "okf/sales"]);
    expect(add.exitCode).toBe(0);

    // Whole tree materialized, reserved files included.
    expect(existsSync(join(project, ".okf", "sales", "index.md"))).toBe(true);
    expect(existsSync(join(project, ".okf", "sales", "log.md"))).toBe(true);
    expect(
      existsSync(join(project, ".okf", "sales", "tables", "orders.md")),
    ).toBe(true);

    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.okf).toEqual(["sales"]);

    expect(run(project, ["status"]).exitCode).toBe(0);
  });

  test("editing log.md is real drift, and revert restores it", async () => {
    const project = await tempRepo("capshelf-okf-drift-project-");
    const dataRepo = await tempRepo("capshelf-okf-drift-data-");
    await seedBundle(dataRepo, "sales");
    await commitAll(dataRepo, "okf bundle");

    expect(run(project, ["init", "--data", dataRepo]).exitCode).toBe(0);
    expect(run(project, ["add", "okf/sales"]).exitCode).toBe(0);

    const logPath = join(project, ".okf", "sales", "log.md");
    await writeFile(logPath, "## 2026-06-30\n\n- local edit\n");

    // log.md is native bundle content, so editing it is real drift:
    // --strict exits 4 and the item is reported drifted.
    const status = run(project, ["status", "--strict"]);
    expect(status.exitCode).toBe(4);
    expect(status.stdout.toString() + status.stderr.toString()).toContain(
      "sales",
    );

    expect(run(project, ["revert", "okf/sales"]).exitCode).toBe(0);
    expect(await readFile(logPath, "utf-8")).toContain("initial bundle");
    expect(run(project, ["status", "--strict"]).exitCode).toBe(0);
  });

  test("--okf-path overrides the output directory", async () => {
    const project = await tempRepo("capshelf-okf-path-project-");
    const dataRepo = await tempRepo("capshelf-okf-path-data-");
    await seedBundle(dataRepo, "sales");
    await commitAll(dataRepo, "okf bundle");

    expect(
      run(project, ["init", "--data", dataRepo, "--okf-path", "knowledge"])
        .exitCode,
    ).toBe(0);
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.okfPath).toBe("knowledge");

    expect(run(project, ["add", "okf/sales"]).exitCode).toBe(0);
    expect(existsSync(join(project, "knowledge", "sales", "index.md"))).toBe(
      true,
    );
    expect(existsSync(join(project, ".okf"))).toBe(false);
  });

  test("share adopts a project bundle and promote pushes local edits back", async () => {
    const project = await tempRepo("capshelf-okf-share-project-");
    const dataRepo = await tempRepo("capshelf-okf-share-data-");
    await writeFile(join(dataRepo, "README.md"), "seed\n");
    await commitAll(dataRepo, "seed");

    expect(run(project, ["init", "--data", dataRepo]).exitCode).toBe(0);

    // Author a project-local bundle, then adopt it into the data repo.
    const root = join(project, ".okf", "draft");
    await mkdir(join(root, "tables"), { recursive: true });
    await writeFile(join(root, "index.md"), "# draft\n");
    await writeFile(join(root, "log.md"), "## 2026-06-30\n\n- new\n");
    await writeFile(join(root, "tables", "orders.md"), "type: Table\n");

    const share = run(project, [
      "share",
      "okf/draft",
      "--to",
      "project",
      "-m",
      "add draft",
    ]);
    expect(share.exitCode).toBe(0);
    expect(
      existsSync(join(dataRepo, "okf", "draft", "tables", "orders.md")),
    ).toBe(true);
    expect(existsSync(join(dataRepo, "okf", "draft", "log.md"))).toBe(true);

    // Edit log.md locally and promote it back.
    await writeFile(join(root, "log.md"), "## 2026-07-01\n\n- promoted\n");
    expect(
      run(project, ["promote", "okf/draft", "-m", "update draft"]).exitCode,
    ).toBe(0);
    expect(
      await readFile(join(dataRepo, "okf", "draft", "log.md"), "utf-8"),
    ).toContain("promoted");
  });

  test("get-path returns the materialized bundle directory", async () => {
    const project = await tempRepo("capshelf-okf-getpath-project-");
    const dataRepo = await tempRepo("capshelf-okf-getpath-data-");
    await seedBundle(dataRepo, "sales");
    await commitAll(dataRepo, "okf bundle");

    expect(run(project, ["init", "--data", dataRepo]).exitCode).toBe(0);
    expect(run(project, ["add", "okf/sales"]).exitCode).toBe(0);

    const getPath = run(project, ["get-path", "okf/sales"]);
    expect(getPath.exitCode).toBe(0);
    expect(getPath.stdout.toString().trim()).toBe(
      join(project, ".okf", "sales"),
    );
  });
});
