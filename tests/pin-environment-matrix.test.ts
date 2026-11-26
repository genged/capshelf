import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { parseLock } from "../src/lock";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_INTEGRATION_TEST_TIMEOUT_MS, tempDir } from "./cli-fixtures";

/**
 * The matrix is data so new Git features add a row, and each cell asserts
 * mechanism-free properties: same commit must give the same identity and
 * delivery in any clone.
 */

interface Cell {
  name: string;
  config?: Record<string, string>;
  attributes?: string;
  objectFormat?: "sha256";
  indexBit?: "assume-unchanged" | "skip-worktree";
  replaceRef?: boolean;
  ambientEnv?: boolean;
  partialClone?: boolean;
  refusal?: RegExp;
}

const CONSUMPTION_CELLS: Cell[] = [
  { name: "baseline" },
  { name: "autocrlf=false", config: { "core.autocrlf": "false" } },
  { name: "autocrlf=input", config: { "core.autocrlf": "input" } },
  { name: "autocrlf=true", config: { "core.autocrlf": "true" } },
  { name: "eol=lf", config: { "core.eol": "lf" } },
  { name: "eol=crlf", config: { "core.eol": "crlf" } },
  { name: "fileMode=false", config: { "core.filemode": "false" } },
  { name: "ignoreCase=true", config: { "core.ignorecase": "true" } },
  { name: "ignoreCase=false", config: { "core.ignorecase": "false" } },
  { name: "index bit assume-unchanged", indexBit: "assume-unchanged" },
  { name: "index bit skip-worktree", indexBit: "skip-worktree" },
  { name: "replacement ref rewrites the item", replaceRef: true },
  { name: "ambient GIT_DIR and friends", ambientEnv: true },
  { name: "blobless partial clone", partialClone: true },
  {
    name: "autocrlf=true × eol=crlf",
    config: { "core.autocrlf": "true", "core.eol": "crlf" },
  },
  {
    name: "autocrlf=input × fsmonitor off",
    config: { "core.autocrlf": "input", "core.fsmonitor": "false" },
  },
];

const AUTHORING_CELLS: Cell[] = [
  {
    name: "authored under autocrlf=input",
    config: { "core.autocrlf": "input" },
  },
  { name: "authored under autocrlf=true", config: { "core.autocrlf": "true" } },
  { name: "committed attributes: * text=auto", attributes: "* text=auto\n" },
  { name: "committed attributes: *.csv -text", attributes: "*.csv -text\n" },
  {
    name: "committed attributes: eol=crlf on ps1",
    attributes: "*.csv text eol=crlf\n",
  },
  { name: "object format sha256", objectFormat: "sha256" },
  {
    name: "committed attributes: an external filter driver",
    attributes: "*.md filter=fake\n",
    refusal: /declares a git content filter/,
  },
  {
    name: "authored under fileMode=false",
    config: { "core.filemode": "false" },
  },
];

async function buildFixture(root: string): Promise<void> {
  const item = join(root, "skills", "matrix");
  await mkdir(join(item, "scripts"), { recursive: true });
  await writeFile(join(item, "SKILL.md"), "# matrix\n");
  await writeFile(join(item, "café.md"), "unicode name\n");
  await writeFile(join(item, "template.csv"), "a,b\r\nc,d\r\n");
  await writeFile(join(item, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(item, "scripts", "run.sh"), 0o755);
  await writeFile(join(item, ".capshelf.yml"), "tags: [matrix]\n");
}

async function commitFixture(repo: string, cell: Cell): Promise<void> {
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await $`git -C ${repo} config uploadpack.allowFilter true`.quiet();
  for (const [key, value] of Object.entries(cell.config ?? {})) {
    await $`git -C ${repo} config ${key} ${value}`.quiet();
  }
  await buildFixture(repo);
  if (cell.attributes !== undefined) {
    await writeFile(join(repo, ".gitattributes"), cell.attributes);
  }
  await $`git -C ${repo} add -A`.quiet();
  // The executable bit is set in the index too so a `core.fileMode=false`
  // repository still commits the intended mode.
  await $`git -C ${repo} update-index --chmod=+x skills/matrix/scripts/run.sh`.quiet();
  await $`git -C ${repo} commit -qm fixture`.quiet();
}

let canonicalRepo: string | null = null;

async function canonical(): Promise<string> {
  if (canonicalRepo !== null) return canonicalRepo;
  const repo = await tempDir("capshelf-matrix-canonical-");
  await $`git -C ${repo} init -q`.quiet();
  await commitFixture(repo, { name: "canonical" });
  canonicalRepo = repo;
  return repo;
}

async function consumptionRepo(cell: Cell): Promise<string> {
  const source = await canonical();
  const clone = await tempDir("capshelf-matrix-clone-");
  const filterArgs = cell.partialClone === true ? ["--filter=blob:none"] : [];
  await $`git clone -q --no-local ${filterArgs} file://${source} ${clone}`.quiet();
  await $`git -C ${clone} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${clone} config user.name capshelf`.quiet();
  for (const [key, value] of Object.entries(cell.config ?? {})) {
    await $`git -C ${clone} config ${key} ${value}`.quiet();
  }
  if (cell.indexBit !== undefined) {
    await $`git -C ${clone} update-index --${cell.indexBit} skills/matrix/SKILL.md`.quiet();
    await writeFile(
      join(clone, "skills", "matrix", "SKILL.md"),
      "# invisible to the index\n",
    );
  }
  if (cell.replaceRef === true) {
    // Git honors replace refs in every read and does not fetch them, so source
    // reads must disable them or the lock records an object id that resolves
    // differently elsewhere.
    const pinned = (await $`git -C ${clone} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
    await $`git -C ${clone} checkout -q -b rewritten`.quiet();
    await writeFile(
      join(clone, "skills", "matrix", "SKILL.md"),
      "# rewritten\n",
    );
    await $`git -C ${clone} commit -qam rewritten`.quiet();
    const rewritten = (await $`git -C ${clone} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
    await $`git -C ${clone} checkout -q -`.quiet();
    await $`git -C ${clone} replace -f ${pinned} ${rewritten}`.quiet();
  }
  return clone;
}

async function authoringRepo(cell: Cell): Promise<string> {
  const repo = await tempDir("capshelf-matrix-authored-");
  const initArgs =
    cell.objectFormat === "sha256"
      ? ["init", "-q", "--object-format=sha256"]
      : ["init", "-q"];
  await $`git -C ${repo} ${initArgs}`.quiet();
  await commitFixture(repo, cell);
  return repo;
}

interface InstalledTree {
  names: string[];
  bytes: Record<string, string>;
  executable: Record<string, boolean>;
}

async function readInstalledTree(root: string): Promise<InstalledTree> {
  const names: string[] = [];
  const bytes: Record<string, string> = {};
  const executable: Record<string, boolean> = {};
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(root, rel) : root;
    for (const entry of (await readdir(abs, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      names.push(child);
      bytes[child] = (await readFile(join(root, child))).toString("base64");
      executable[child] = (lstatSync(join(root, child)).mode & 0o111) !== 0;
    }
  }
  await walk("");
  return { names: names.sort(), bytes, executable };
}

function runCli(
  project: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      ...args,
    ],
    cwd: project,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface CellResult {
  digest: string | null;
  installed: InstalledTree | null;
  refusal: string | null;
}

async function runCell(cell: Cell, kind: "consumption" | "authoring") {
  const dataRepo =
    kind === "consumption"
      ? await consumptionRepo(cell)
      : await authoringRepo(cell);
  const project = await tempDir("capshelf-matrix-project-");
  const env: Record<string, string> = {};
  if (cell.ambientEnv === true) {
    const decoy = await tempDir("capshelf-matrix-decoy-");
    await $`git -C ${decoy} init -q`.quiet();
    env.GIT_DIR = join(decoy, ".git");
    env.GIT_WORK_TREE = decoy;
    env.GIT_INDEX_FILE = join(decoy, ".git", "index");
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(decoy, ".git", "objects");
  }

  for (const args of [
    ["init", "--data", dataRepo, "--no-upstream"],
    ["add", "skills/matrix"],
  ]) {
    const result = runCli(project, args, env);
    if (result.exitCode !== 0) {
      return {
        digest: null,
        installed: null,
        refusal: `${result.stdout.toString()}${result.stderr.toString()}`,
      } satisfies CellResult;
    }
  }

  const installedRoot = join(project, ".agents", "skills", "matrix");
  const afterAdd = await readInstalledTree(installedRoot);

  const second = await tempDir("capshelf-matrix-apply-");
  expect(
    runCli(second, ["init", "--data", dataRepo, "--no-upstream"], env).exitCode,
  ).toBe(0);
  for (const name of ["capshelf.json", "capshelf.lock.json"]) {
    await writeFile(
      join(second, ".capshelf", name),
      await readFile(join(project, ".capshelf", name), "utf-8"),
    );
  }
  expect(runCli(second, ["apply", "skills/matrix"], env).exitCode).toBe(0);
  expect(
    await readInstalledTree(join(second, ".agents", "skills", "matrix")),
  ).toEqual(afterAdd);

  expect(runCli(project, ["status", "--strict"], env).exitCode).toBe(0);

  expect(existsSync(join(installedRoot, ".capshelf.yml"))).toBe(false);

  const lock = parseLock(
    await file(join(project, ".capshelf", "capshelf.lock.json")).json(),
  );
  const entry = lock.items["data/skills/matrix"];
  if (entry?.source !== "data" || entry.sourcePinDigest === undefined) {
    throw new Error("the lock has no pinned entry for skills/matrix");
  }
  return {
    digest: entry.sourcePinDigest,
    installed: afterAdd,
    refusal: null,
  } satisfies CellResult;
}

describe("environment matrix", () => {
  test(
    "the same commit yields the same identity and the same bytes in every clone",
    async () => {
      const baseline = await runCell(CONSUMPTION_CELLS[0]!, "consumption");
      expect(baseline.refusal).toBeNull();
      expect(baseline.digest).toMatch(/^[0-9a-f]{64}$/);

      for (const cell of CONSUMPTION_CELLS.slice(1)) {
        const result = await runCell(cell, "consumption");
        expect(`${cell.name}: ${result.refusal ?? "ok"}`).toBe(
          `${cell.name}: ok`,
        );
        expect(`${cell.name}: ${result.digest}`).toBe(
          `${cell.name}: ${baseline.digest}`,
        );
        expect(result.installed?.names).toEqual(baseline.installed!.names);
        expect(result.installed?.bytes).toEqual(baseline.installed!.bytes);
        expect(result.installed?.executable).toEqual(
          baseline.installed!.executable,
        );
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS * 12,
  );

  test(
    "an authoring configuration changes the tree, and nothing else breaks",
    async () => {
      for (const cell of AUTHORING_CELLS) {
        const result = await runCell(cell, "authoring");
        if (cell.refusal) {
          expect(`${cell.name}: ${result.refusal ?? "(succeeded)"}`).toMatch(
            cell.refusal,
          );
          continue;
        }
        expect(`${cell.name}: ${result.refusal ?? "ok"}`).toBe(
          `${cell.name}: ok`,
        );
        expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(result.installed?.names).toEqual([
          "SKILL.md",
          "café.md",
          "scripts/run.sh",
          "template.csv",
        ]);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS * 8,
  );
});
