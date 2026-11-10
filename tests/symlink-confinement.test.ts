import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PreconditionError } from "../src/errors";
import { saveLocalConfig } from "../src/local-config";
import { emptyLock, saveLock } from "../src/lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  rejection,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

const TIMEOUT = CLI_INTEGRATION_TEST_TIMEOUT_MS;

const SUBAGENT_CLAUDE =
  "---\nname: demo\ndescription: Demo subagent.\n---\n\nDemo.\n";
const SUBAGENT_CODEX = `name = "demo"
description = "Demo subagent."
developer_instructions = "Demo."
model = "gpt-5.4"
`;

interface World {
  project: string;
  dataRepo: string;
  outside: string;
  run: ReturnType<typeof runInProcess>;
  lockPath: string;
}

/** A project with one item of each strategy on the shelf. */
async function world(claudeOnly = false): Promise<World> {
  const project = await tempRepo("capshelf-confine-project-");
  const dataRepo = await tempRepo("capshelf-confine-data-");
  const outside = await tempDir("capshelf-confine-outside-");
  await mkdir(join(dataRepo, "skills", "foo"), { recursive: true });
  await writeFile(join(dataRepo, "skills", "foo", "SKILL.md"), "foo v1\n");
  await mkdir(join(dataRepo, "subagents", "demo"), { recursive: true });
  await writeFile(
    join(dataRepo, "subagents", "demo", "claude.md"),
    SUBAGENT_CLAUDE,
  );
  await writeFile(
    join(dataRepo, "subagents", "demo", "codex.toml"),
    SUBAGENT_CODEX,
  );
  await mkdir(join(dataRepo, "settings", "sec"), { recursive: true });
  await writeFile(
    join(dataRepo, "settings", "sec", "settings.json"),
    `${JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } })}\n`,
  );
  await mkdir(join(dataRepo, "mcp", "srv"), { recursive: true });
  await writeFile(
    join(dataRepo, "mcp", "srv", "claude.json"),
    `${JSON.stringify({ mcpServers: { srv: { command: "srv-mcp" } } })}\n`,
  );
  await mkdir(join(dataRepo, "codex", "config", "demo"), { recursive: true });
  await writeFile(
    join(dataRepo, "codex", "config", "demo", "config.toml"),
    'model = "demo-model"\n',
  );
  await commitAll(dataRepo, "items");
  const run = runInProcess(project);
  const init = await run([
    "init",
    "--data",
    dataRepo,
    "--no-upstream",
    ...(claudeOnly ? ["--claude-only"] : []),
  ]);
  expect(init.exitCode).toBe(0);
  return {
    project,
    dataRepo,
    outside,
    run,
    lockPath: join(project, ".capshelf", "capshelf.lock.json"),
  };
}

/** Every path below `dir` with its bytes or link target. Byte-for-byte proof. */
async function snapshot(dir: string): Promise<string[]> {
  const rows: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      const label = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        rows.push(`${label} -> ${await readlink(path)}`);
      } else if (entry.isDirectory()) {
        rows.push(`${label}/`);
        await walk(path, label);
      } else {
        rows.push(`${label}: ${(await readFile(path)).toString("base64")}`);
      }
    }
  }
  await walk(dir, "");
  return rows;
}

async function head(repo: string): Promise<string> {
  return (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
}

/** Replace `path` (which `init` may have made) with a symlink to `outside`. */
async function linkOutside(path: string, outside: string) {
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  await symlink(outside, path);
}

/** Move a real folder to `outside` and leave a symlink to it in its place. */
async function relocateThroughLink(dir: string, outside: string) {
  await cp(dir, outside, { recursive: true, verbatimSymlinks: true });
  await rm(dir, { recursive: true });
  await symlink(outside, dir);
}

function expectRefusal(
  result: { exitCode: number; stdout: Buffer; stderr: Buffer },
  outside: string,
) {
  expect(result.exitCode).toBe(3);
  // A refusal is reported on stderr, or on stdout by a command that prints a
  // per-item report.
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(output).toContain("outside the project");
  expect(output).toContain(outside);
}

/** The refused command left the outside folder and the project lock as they were. */
async function expectUntouched(
  w: World,
  outsideBefore: string[],
  lockBefore: string,
) {
  expect(await snapshot(w.outside)).toEqual(outsideBefore);
  expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
}

describe("area a: copy-directory items (skills)", () => {
  test.each([
    { mode: "codex-compatible", link: ".agents", claudeOnly: false },
    { mode: "claude-only", link: ".claude", claudeOnly: true },
  ])(
    "$mode: add refuses a symlinked $link that leaves the project",
    async ({ link, claudeOnly }) => {
      const w = await world(claudeOnly);
      await linkOutside(join(w.project, link), w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "skills/foo"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual([]);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test.each([
    { mode: "codex-compatible", link: ".agents", claudeOnly: false },
    { mode: "claude-only", link: ".claude", claudeOnly: true },
  ])(
    "$mode: add refuses a symlinked leaf that leaves the project",
    async ({ link, claudeOnly }) => {
      const w = await world(claudeOnly);
      await mkdir(join(w.project, link, "skills"), { recursive: true });
      await mkdir(join(w.outside, "elsewhere"));
      await writeFile(join(w.outside, "elsewhere", "keep.txt"), "keep\n");
      await symlink(
        join(w.outside, "elsewhere"),
        join(w.project, link, "skills", "foo"),
      );
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "skills/foo"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test.each([
    { mode: "codex-compatible", link: ".agents", claudeOnly: false },
    { mode: "claude-only", link: ".claude", claudeOnly: true },
  ])(
    "$mode: update, apply, and rm refuse a $link that became a symlink",
    async ({ link, claudeOnly }) => {
      const w = await world(claudeOnly);
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await writeFile(
        join(w.dataRepo, "skills", "foo", "SKILL.md"),
        "foo v2\n",
      );
      await commitAll(w.dataRepo, "foo v2");
      await relocateThroughLink(join(w.project, link), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      for (const args of [
        ["update", "skills/foo", "--yes"],
        ["apply"],
        ["rm", "skills/foo", "--yes"],
      ]) {
        const result = await w.run(args);
        expectRefusal(result, w.outside);
        expect(await snapshot(w.outside)).toEqual(before);
        expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
      }
    },
    TIMEOUT,
  );
});

describe("area b: codex-compatible alias", () => {
  test(
    "add and rm refuse a .claude/skills folder that is a symlink outside",
    async () => {
      const w = await world();
      await linkOutside(join(w.project, ".claude", "skills"), w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const added = await w.run(["add", "skills/foo"]);
      expectRefusal(added, w.outside);
      expect(await snapshot(w.outside)).toEqual([]);
      expect(existsSync(join(w.project, ".agents", "skills", "foo"))).toBe(
        false,
      );
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);

      await rm(join(w.project, ".claude", "skills"));
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await relocateThroughLink(
        join(w.project, ".claude", "skills"),
        w.outside,
      );
      const before = await snapshot(w.outside);
      const lockAfterAdd = await readFile(w.lockPath, "utf-8");
      const removed = await w.run(["rm", "skills/foo", "--yes"]);
      expectRefusal(removed, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockAfterAdd);
      expect(existsSync(join(w.project, ".agents", "skills", "foo"))).toBe(
        true,
      );
    },
    TIMEOUT,
  );
});

describe("area c: subagents", () => {
  test.each([".claude", ".codex"])(
    "add refuses a symlinked %s that leaves the project",
    async (link) => {
      const w = await world();
      await linkOutside(join(w.project, link), w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "subagents/demo"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual([]);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test(
    "add refuses a symlinked leaf that leaves the project",
    async () => {
      const w = await world();
      await mkdir(join(w.project, ".claude", "agents"), { recursive: true });
      await writeFile(join(w.outside, "victim.md"), "victim\n");
      await symlink(
        join(w.outside, "victim.md"),
        join(w.project, ".claude", "agents", "demo.md"),
      );
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "subagents/demo"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test.each([".claude", ".codex"])(
    "rm refuses a %s that became a symlink",
    async (link) => {
      const w = await world();
      expect((await w.run(["add", "subagents/demo"])).exitCode).toBe(0);
      await relocateThroughLink(join(w.project, link), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["rm", "subagents/demo", "--yes"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );
});

describe("area c2: subagent leaf on rm", () => {
  test(
    "rm refuses a subagent file that became a link outside",
    async () => {
      const w = await world();
      expect((await w.run(["add", "subagents/demo"])).exitCode).toBe(0);
      const leaf = join(w.project, ".claude", "agents", "demo.md");
      await rename(leaf, join(w.outside, "moved.md"));
      await symlink(join(w.outside, "moved.md"), leaf);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["rm", "subagents/demo", "--yes"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );
});

describe("area d: fragments", () => {
  test.each([
    { ref: "settings/sec", link: ".claude" },
    { ref: "codex-config/demo", link: ".codex" },
  ])(
    "add $ref refuses a symlinked $link that leaves the project",
    async ({ ref, link }) => {
      const w = await world();
      await linkOutside(join(w.project, link), w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", ref]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual([]);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test(
    "add mcp/srv refuses a .mcp.json that is a symlink outside",
    async () => {
      const w = await world();
      await writeFile(join(w.outside, "other.json"), "{}\n");
      await symlink(
        join(w.outside, "other.json"),
        join(w.project, ".mcp.json"),
      );
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "mcp/srv"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test.each([
    { ref: "settings/sec", link: ".claude" },
    { ref: "codex-config/demo", link: ".codex" },
  ])(
    "rm $ref refuses a $link that became a symlink",
    async ({ ref, link }) => {
      const w = await world();
      expect((await w.run(["add", ref])).exitCode).toBe(0);
      await relocateThroughLink(join(w.project, link), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["rm", ref, "--yes"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );

  test(
    "rm mcp/srv refuses a .mcp.json that became a symlink outside",
    async () => {
      const w = await world();
      expect((await w.run(["add", "mcp/srv"])).exitCode).toBe(0);
      const mcp = join(w.project, ".mcp.json");
      await rename(mcp, join(w.outside, "moved.json"));
      await symlink(join(w.outside, "moved.json"), mcp);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["rm", "mcp/srv", "--yes"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
      expect(await readFile(w.lockPath, "utf-8")).toBe(lockBefore);
    },
    TIMEOUT,
  );
});

describe("area e: .capshelf metadata", () => {
  test(
    "add refuses a .capshelf folder that is a symlink outside",
    async () => {
      const w = await world();
      await relocateThroughLink(join(w.project, ".capshelf"), w.outside);
      const before = await snapshot(w.outside);
      const result = await w.run(["add", "skills/foo"]);
      expectRefusal(result, w.outside);
      expect(await snapshot(w.outside)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "add refuses a lock file that is a link outside",
    async () => {
      const w = await world();
      const target = join(w.outside, "victim.json");
      await writeFile(target, await readFile(w.lockPath));
      await rm(w.lockPath);
      await symlink(target, w.lockPath);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const result = await w.run(["add", "skills/foo"]);
      expectRefusal(result, w.outside);
      expect(`${result.stdout}${result.stderr}`).toContain(target);
      await expectUntouched(w, before, lockBefore);
    },
    TIMEOUT,
  );

  test(
    "the local config writer refuses a local.json that is a link outside",
    async () => {
      const project = await tempDir("capshelf-confine-localcfg-project-");
      const outside = await tempDir("capshelf-confine-localcfg-outside-");
      await mkdir(join(project, ".capshelf"));
      const target = join(outside, "victim.json");
      await writeFile(target, "victim\n");
      await symlink(target, join(project, ".capshelf", "local.json"));
      const error = await rejection(
        saveLocalConfig(project, {
          dataRepo: "/x",
          skills: [],
          plugins: [],
          piExtensions: [],
          settings: [],
          mcp: [],
        }),
        PreconditionError,
      );
      expect(error.message).toContain(outside);
      expect(await readFile(target, "utf-8")).toBe("victim\n");
    },
    TIMEOUT,
  );

  test(
    "init refuses a .capshelf symlink that exists before the first write",
    async () => {
      const project = await tempRepo("capshelf-confine-init-project-");
      const dataRepo = await tempRepo("capshelf-confine-init-data-");
      const outside = await tempDir("capshelf-confine-init-outside-");
      await symlink(outside, join(project, ".capshelf"));
      const result = await runInProcess(project)([
        "init",
        "--data",
        dataRepo,
        "--no-upstream",
      ]);
      expectRefusal(result, outside);
      expect(await snapshot(outside)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the metadata writer refuses a .capshelf symlink",
    async () => {
      const project = await tempDir("capshelf-confine-writer-project-");
      const outside = await tempDir("capshelf-confine-writer-outside-");
      await symlink(outside, join(project, ".capshelf"));
      const error = await rejection(
        saveLock(project, emptyLock()),
        PreconditionError,
      );
      expect(error.message).toContain(outside);
      expect(await snapshot(outside)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("area f: copy-up reads", () => {
  test(
    "promote refuses a skill whose parent folder links outside",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await writeFile(
        join(w.project, ".agents", "skills", "foo", "SKILL.md"),
        "secret edit\n",
      );
      await relocateThroughLink(join(w.project, ".agents"), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const dataHead = await head(w.dataRepo);
      const result = await w.run(["promote", "skills/foo"]);
      expectRefusal(result, w.outside);
      expect(await head(w.dataRepo)).toBe(dataHead);
      await expectUntouched(w, before, lockBefore);
    },
    TIMEOUT,
  );

  test(
    "share refuses a skill whose parent folder links outside",
    async () => {
      const w = await world();
      await mkdir(join(w.outside, "skills", "mine"), { recursive: true });
      await writeFile(
        join(w.outside, "skills", "mine", "SKILL.md"),
        "private\n",
      );
      await linkOutside(join(w.project, ".agents"), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const dataHead = await head(w.dataRepo);
      const result = await w.run(["share", "skills/mine"]);
      expectRefusal(result, w.outside);
      expect(await head(w.dataRepo)).toBe(dataHead);
      await expectUntouched(w, before, lockBefore);
    },
    TIMEOUT,
  );

  test(
    "share refuses a subagent whose parent folder links outside",
    async () => {
      const w = await world();
      await mkdir(join(w.outside, "agents"), { recursive: true });
      await writeFile(join(w.outside, "agents", "mine.md"), SUBAGENT_CLAUDE);
      await linkOutside(join(w.project, ".claude"), w.outside);
      const before = await snapshot(w.outside);
      const lockBefore = await readFile(w.lockPath, "utf-8");
      const dataHead = await head(w.dataRepo);
      const result = await w.run(["share", "subagents/mine"]);
      expectRefusal(result, w.outside);
      expect(await head(w.dataRepo)).toBe(dataHead);
      await expectUntouched(w, before, lockBefore);
    },
    TIMEOUT,
  );
});

describe("area g: data repo", () => {
  test(
    "a committed symlinked folder in the data repo is still refused",
    async () => {
      const w = await world();
      const elsewhere = await tempDir("capshelf-confine-data-elsewhere-");
      await rm(join(w.dataRepo, "subagents"), { recursive: true });
      await symlink(elsewhere, join(w.dataRepo, "subagents"));
      await commitAll(w.dataRepo, "link subagents away");
      await mkdir(join(w.project, ".claude", "agents"), { recursive: true });
      await writeFile(
        join(w.project, ".claude", "agents", "mine.md"),
        SUBAGENT_CLAUDE,
      );
      const dataHead = await head(w.dataRepo);
      const result = await w.run(["share", "subagents/mine"]);
      expect(result.exitCode).not.toBe(0);
      expect(await head(w.dataRepo)).toBe(dataHead);
      expect(await snapshot(elsewhere)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("legitimate symlinks that stay inside the project", () => {
  test(
    "codex-compatible add creates the .claude/skills alias and rm removes it",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      const alias = join(w.project, ".claude", "skills", "foo");
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(await readFile(join(alias, "SKILL.md"), "utf-8")).toBe("foo v1\n");
      expect((await w.run(["rm", "skills/foo", "--yes"])).exitCode).toBe(0);
      expect(existsSync(alias)).toBe(false);
      expect(
        lstatSync(join(w.project, ".claude", "skills")).isDirectory(),
      ).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "an in-project link at another depth for .claude/skills gets a working alias",
    async () => {
      const w = await world();
      await mkdir(join(w.project, "store", "deep"), { recursive: true });
      await rm(join(w.project, ".claude", "skills"), {
        recursive: true,
        force: true,
      });
      await symlink("../store/deep", join(w.project, ".claude", "skills"));
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      const alias = join(w.project, "store", "deep", "foo");
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(await readFile(join(alias, "SKILL.md"), "utf-8")).toBe("foo v1\n");
      expect(
        await readFile(
          join(w.project, ".claude", "skills", "foo", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("foo v1\n");
      expect((await w.run(["rm", "skills/foo", "--yes"])).exitCode).toBe(0);
      expect(existsSync(alias)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a standard alias still matches after .agents becomes an in-project link",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await rename(join(w.project, ".agents"), join(w.project, "agents-real"));
      await symlink("agents-real", join(w.project, ".agents"));
      const alias = join(w.project, ".claude", "skills", "foo");
      expect((await w.run(["status"])).exitCode).toBe(0);
      expect((await w.run(["apply"])).exitCode).toBe(0);
      expect(await readlink(alias)).toBe("../../.agents/skills/foo");
      expect(await readFile(join(alias, "SKILL.md"), "utf-8")).toBe("foo v1\n");
      expect((await w.run(["rm", "skills/foo", "--yes"])).exitCode).toBe(0);
      expect(existsSync(alias)).toBe(false);
      expect(existsSync(join(w.project, "agents-real", "skills", "foo"))).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  test(
    "a dangling alias still matches when .agents links to a folder that lacks skills/",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await rename(join(w.project, ".agents"), join(w.project, "agents-real"));
      await symlink("agents-real", join(w.project, ".agents"));
      await rm(join(w.project, "agents-real", "skills"), { recursive: true });
      const alias = join(w.project, ".claude", "skills", "foo");
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(existsSync(alias)).toBe(false);
      const status = await w.run(["status"]);
      expect(status.stderr.toString()).not.toContain("resolves outside");
      expect((await w.run(["apply"])).exitCode).toBe(0);
      expect((await w.run(["rm", "skills/foo", "--yes"])).exitCode).toBe(0);
      expect((await readdir(dirname(alias))).includes("foo")).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "an in-project link to a folder named ..cache is allowed",
    async () => {
      const w = await world();
      await mkdir(join(w.project, "..cache"));
      await rm(join(w.project, ".claude", "skills"), {
        recursive: true,
        force: true,
      });
      await symlink("../..cache", join(w.project, ".claude", "skills"));
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      expect(
        await readFile(join(w.project, "..cache", "foo", "SKILL.md"), "utf-8"),
      ).toBe("foo v1\n");
    },
    TIMEOUT,
  );

  test(
    "an alias folder link that leaves the project is refused at any depth",
    async () => {
      const w = await world();
      await mkdir(join(w.outside, "deep"));
      await rm(join(w.project, ".claude", "skills"), {
        recursive: true,
        force: true,
      });
      await symlink(
        join(w.outside, "deep"),
        join(w.project, ".claude", "skills"),
      );
      const result = await w.run(["add", "skills/foo"]);
      expectRefusal(result, join(w.outside, "deep"));
      expect(await snapshot(w.outside)).toEqual(["deep/"]);
    },
    TIMEOUT,
  );

  test(
    "an alias whose target folder was deleted by hand does not break status",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/foo"])).exitCode).toBe(0);
      await rm(join(w.project, ".agents", "skills", "foo"), {
        recursive: true,
      });
      const alias = join(w.project, ".claude", "skills", "foo");
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      const status = await w.run(["status", "--json"]);
      expect(status.stderr.toString()).not.toContain("dangling");
      expect(status.stdout.toString()).not.toContain("dangling");
      expect((await w.run(["rm", "skills/foo", "--yes"])).exitCode).toBe(0);
      expect(existsSync(alias)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a .codex link to a folder inside the project works for a fragment add",
    async () => {
      const w = await world();
      await mkdir(join(w.project, "codex-real"));
      await symlink("codex-real", join(w.project, ".codex"));
      expect((await w.run(["add", "codex-config/demo"])).exitCode).toBe(0);
      expect(
        await readFile(join(w.project, "codex-real", "config.toml"), "utf-8"),
      ).toContain("demo-model");
      expect((await w.run(["rm", "codex-config/demo", "--yes"])).exitCode).toBe(
        0,
      );
    },
    TIMEOUT,
  );

  test(
    "a project reached through a symlink still works",
    async () => {
      const w = await world();
      const parent = await tempDir("capshelf-confine-rootlink-");
      const viaLink = join(parent, "project-link");
      await symlink(w.project, viaLink);
      const run = runInProcess(viaLink);
      expect((await run(["add", "skills/foo"])).exitCode).toBe(0);
      expect(
        await readFile(
          join(w.project, ".agents", "skills", "foo", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("foo v1\n");
    },
    TIMEOUT,
  );
});
