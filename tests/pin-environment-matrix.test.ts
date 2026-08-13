import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_INTEGRATION_TEST_TIMEOUT_MS, tempDir } from "./cli-fixtures";

/**
 * A CLASS DEFENCE, not a checklist.
 *
 * The bug this design exists to fix is one member of a family: *the same commit
 * produces a different answer in a different clone*. Enumerating members one at
 * a time loses, because Git keeps adding them. So the matrix is data — adding a
 * Git feature means adding a row here, not writing a test — and the properties
 * asserted in every cell name no mechanism at all.
 *
 * The rows split by where the configuration acts:
 *
 * - **Consumption** cells clone one canonical commit and vary how the clone is
 *   configured. Identity and delivery must be *identical* to the baseline, for
 *   every one of them. This is the class the original bug belonged to.
 * - **Authoring** cells change what gets committed in the first place, so the
 *   tree legitimately differs. What must still hold is that the project
 *   receives what Git stores, that `add` and `apply` agree, and that a fresh
 *   install is clean.
 *
 * Property 5 spans both: a cell either succeeds or fails with a refusal this
 * design names. An unclassified failure is the signal that a Git feature nobody
 * anticipated has reached an answer it must not decide.
 */

interface Cell {
  name: string;
  /**
   * Configuration applied to the repository capshelf reads. For a consumption
   * cell that is a clone of the canonical commit; for an authoring cell it is
   * the repository the fixture is committed into.
   */
  config?: Record<string, string>;
  /** A committed `.gitattributes` — authoring only, it changes the tree. */
  attributes?: string;
  objectFormat?: "sha256";
  indexBit?: "assume-unchanged" | "skip-worktree";
  replaceRef?: boolean;
  /** Ambient repository-selecting variables set for the CLI run. */
  ambientEnv?: boolean;
  partialClone?: boolean;
  /** Cells that legitimately refuse, with the refusal this design names. */
  refusal?: RegExp;
}

/** Same commit, different clone. Identity and delivery must not move. */
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

/** Different commit, because the configuration changed what got committed. */
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

/**
 * One fixture item, built identically in every cell: multi-file, a non-ASCII
 * name, one executable, one CRLF-authored file, and a metadata sidecar.
 */
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
  // The executable bit goes into the *index* as well as onto disk, so a
  // `core.fileMode=false` repository still commits the mode the fixture means.
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
    // The commit capshelf pins stays HEAD; a *replacement* is registered for it
    // that resolves to a different tree. Plain git honors that graft in every
    // read, so this cell fails outright unless source reads disable it — and
    // replacement refs are not fetched by default, so the lock would record an
    // object id that resolves differently in every other clone.
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

  // Property 3: installing by the other route gives an identical tree.
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

  // Property 4: a fresh install is clean.
  expect(runCli(project, ["status", "--strict"], env).exitCode).toBe(0);

  // Row 5 of the object model: the sidecar never reaches a project.
  expect(existsSync(join(installedRoot, ".capshelf.yml"))).toBe(false);

  const lock = await file(
    join(project, ".capshelf", "capshelf.lock.json"),
  ).json();
  return {
    digest: lock.items["data/skills/matrix"].sourcePinDigest as string,
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
        // Property 5, first: no cell may fail with an unclassified error.
        expect(`${cell.name}: ${result.refusal ?? "ok"}`).toBe(
          `${cell.name}: ok`,
        );
        // Property 1: identity is clone-independent.
        expect(`${cell.name}: ${result.digest}`).toBe(
          `${cell.name}: ${baseline.digest}`,
        );
        // Property 2: delivery is clone-independent — bytes, names, and modes.
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
          // Property 5: a refusal must be one this design names.
          expect(`${cell.name}: ${result.refusal ?? "(succeeded)"}`).toMatch(
            cell.refusal,
          );
          continue;
        }
        expect(`${cell.name}: ${result.refusal ?? "ok"}`).toBe(
          `${cell.name}: ok`,
        );
        expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
        // Whatever the repository decided to store, the project holds exactly
        // that — the assertions inside `runCell` already proved `add` and
        // `apply` agree and that the fresh install reports clean.
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
