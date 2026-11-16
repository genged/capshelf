import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  addSkill,
  commitAll,
  jsonOutput,
  objectField,
  readJsonObject,
  runInProcess,
  stringField,
  tempRepo,
} from "./cli-fixtures";

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const key = full.slice(root.length);
      if (entry.isSymbolicLink()) {
        entries.set(key, `symlink ${await readlink(full)}`);
      } else if (entry.isDirectory()) {
        entries.set(key, "directory");
        await walk(full);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        entries.set(key, `file ${digest}`);
      }
    }
  }
  await walk(root);
  return entries;
}

async function setup(prefix: string) {
  const project = await tempRepo(`${prefix}-project-`);
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const run = runInProcess(project);
  expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
  return { project, dataRepo, run };
}

async function writeSkill(project: string, name: string): Promise<void> {
  await mkdir(join(project, ".agents", "skills", name), { recursive: true });
  await writeFile(
    join(project, ".agents", "skills", name, "SKILL.md"),
    `${name}\n`,
  );
}

describe("get-path across project and local locks", () => {
  test("a skill shared in local scope resolves by bare name and by kind/name", async () => {
    const { project, run } = await setup("capshelf-gp-local");
    await writeSkill(project, "draft");
    expect((await run(["share", "skills/draft"])).exitCode).toBe(0);
    const expected = join(project, ".agents", "skills", "draft");

    for (const ref of ["draft", "skills/draft"]) {
      const result = await run(["get-path", ref]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(expected);
    }

    const json = await run(["get-path", "draft", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = jsonOutput(json);
    const localLock = await readJsonObject(
      join(project, ".capshelf", "local.lock.json"),
    );
    expect(stringField(parsed, "scope")).toBe("local");
    expect(stringField(parsed, "path")).toBe(expected);
    expect(objectField(parsed, "lock")).toEqual(
      objectField(objectField(localLock, "items"), "data/skills/draft"),
    );
  });

  test("a project-scope skill reports scope project", async () => {
    const { project, run } = await setup("capshelf-gp-project");
    await writeSkill(project, "shared");
    expect(
      (await run(["share", "skills/shared", "--to", "project"])).exitCode,
    ).toBe(0);

    const json = await run(["get-path", "shared", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = jsonOutput(json);
    const projectLock = await readJsonObject(
      join(project, ".capshelf", "capshelf.lock.json"),
    );
    expect(stringField(parsed, "scope")).toBe("project");
    expect(objectField(parsed, "lock")).toEqual(
      objectField(objectField(projectLock, "items"), "data/skills/shared"),
    );
  });

  test("a skill moved to local scope still resolves", async () => {
    const { project, run } = await setup("capshelf-gp-move");
    await writeSkill(project, "mover");
    expect(
      (await run(["share", "skills/mover", "--to", "project"])).exitCode,
    ).toBe(0);
    expect((await run(["move", "mover", "--to", "local"])).exitCode).toBe(0);

    const result = await run(["get-path", "mover"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(
      join(project, ".agents", "skills", "mover"),
    );
    const json = jsonOutput(await run(["get-path", "mover", "--json"]));
    expect(stringField(json, "scope")).toBe("local");
  });

  test("a key in both locks exits 3 and names both scopes, with no writes", async () => {
    const { project, dataRepo, run } = await setup("capshelf-gp-both");
    await mkdir(join(dataRepo, "skills", "both"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "both", "SKILL.md"), "both\n");
    await commitAll(dataRepo, "both skill");
    expect((await run(["add", "--local", "skills/both"])).exitCode).toBe(0);

    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const localLock = await readJsonObject(localLockPath);
    const projectLock = await readJsonObject(projectLockPath);
    // Write the row by hand to build the state that the `move` help text
    // calls an interrupted move (src/commands/move.ts:61).
    const projectItems = objectField(projectLock, "items");
    projectItems["data/skills/both"] = objectField(
      objectField(localLock, "items"),
      "data/skills/both",
    );
    await writeFile(
      projectLockPath,
      `${JSON.stringify(projectLock, null, 2)}\n`,
    );
    const before = await snapshotTree(project);
    expect([...before.keys()].some((p) => p.includes("skills/both"))).toBe(
      true,
    );

    const result = await run(["get-path", "both"]);
    expect(result.exitCode).toBe(3);
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output).toContain("project and local");
    expect(output).toContain("move both --to local");

    expect(await snapshotTree(project)).toEqual(before);
  });

  test("an untracked item exits 2 with the unchanged message", async () => {
    const { run } = await setup("capshelf-gp-none");
    const result = await run(["get-path", "ghost"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "not tracked in this project: ghost",
    );
  });

  test("--output on a local skill is refused", async () => {
    const { project, run } = await setup("capshelf-gp-output");
    await writeSkill(project, "draft");
    expect((await run(["share", "skills/draft"])).exitCode).toBe(0);
    const result = await run(["get-path", "draft", "--output"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "--output and --target are only valid",
    );
  });

  test("a bare name that matches two kinds in one lock is ambiguous", async () => {
    const { project, dataRepo, run } = await setup("capshelf-gp-amb-one");
    await addSkill(dataRepo, "pdf");
    await mkdir(join(dataRepo, "pi", "extensions", "pdf"), { recursive: true });
    await writeFile(
      join(dataRepo, "pi", "extensions", "pdf", "index.ts"),
      "x\n",
    );
    await commitAll(dataRepo, "pdf pair");
    expect((await run(["add", "--local", "skills/pdf"])).exitCode).toBe(0);
    expect((await run(["add", "--local", "pi-extensions/pdf"])).exitCode).toBe(
      0,
    );

    const result = await run(["get-path", "pdf"]);
    // get-path throws a plain Error for this (src/commands/get-path.ts:56). The
    // CLI boundary maps a non-CliError to exit code 1 (src/cli.ts:128).
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('ambiguous item "pdf": found ');
    expect(result.stderr.toString()).toContain("; use kind/name");
    expect(result.stderr.toString()).toContain("skills/pdf");
    expect(result.stderr.toString()).toContain("pi-extensions/pdf");

    const skill = jsonOutput(await run(["get-path", "skills/pdf", "--json"]));
    expect(stringField(skill, "path")).toBe(
      join(project, ".agents", "skills", "pdf"),
    );
    expect(stringField(skill, "scope")).toBe("local");
    const ext = jsonOutput(
      await run(["get-path", "pi-extensions/pdf", "--json"]),
    );
    expect(stringField(ext, "path")).toBe(
      join(project, ".pi", "extensions", "pdf"),
    );
    expect(stringField(ext, "scope")).toBe("local");
  });

  test("a bare name that matches two kinds split across scopes is ambiguous", async () => {
    const { project, dataRepo, run } = await setup("capshelf-gp-amb-split");
    await addSkill(dataRepo, "pdf");
    await mkdir(join(dataRepo, "pi", "extensions", "pdf"), { recursive: true });
    await writeFile(
      join(dataRepo, "pi", "extensions", "pdf", "index.ts"),
      "x\n",
    );
    await commitAll(dataRepo, "pdf pair");
    expect((await run(["add", "--local", "skills/pdf"])).exitCode).toBe(0);
    expect((await run(["add", "pi-extensions/pdf"])).exitCode).toBe(0);

    const result = await run(["get-path", "pdf"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'ambiguous item "pdf": found pi-extensions/pdf, skills/pdf; use kind/name',
    );

    const skill = jsonOutput(await run(["get-path", "skills/pdf", "--json"]));
    expect(stringField(skill, "path")).toBe(
      join(project, ".agents", "skills", "pdf"),
    );
    expect(stringField(skill, "scope")).toBe("local");
    const ext = jsonOutput(
      await run(["get-path", "pi-extensions/pdf", "--json"]),
    );
    expect(stringField(ext, "path")).toBe(
      join(project, ".pi", "extensions", "pdf"),
    );
    expect(stringField(ext, "scope")).toBe("project");
  });
});
