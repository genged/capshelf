import { $ } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { handleApiRequest } from "../src/serve-api";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function tempRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await $`git -C ${repo} remote add origin https://example.invalid/${basename(repo)}`.quiet();
  return repo;
}

function cli(args: string[], cwd: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

let PROJECT = "";
let DATA = "";

// Build one real bound project with an installed data item, a settings
// fragment, and a bundle, then drive the read-only API in-process against it.
beforeAll(async () => {
  DATA = await tempRepo("capshelf-api-data-");
  await mkdir(join(DATA, "skills", "hello"), { recursive: true });
  await writeFile(
    join(DATA, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: A friendly hello skill.\n---\n# Hello\n",
  );
  await mkdir(join(DATA, "settings", "perms"), { recursive: true });
  await writeFile(
    join(DATA, "settings", "perms", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] } })}\n`,
  );
  await mkdir(join(DATA, "bundles"), { recursive: true });
  await writeFile(
    join(DATA, "bundles", "starter.yml"),
    "description: Starter set.\nincludes:\n  skills: [hello]\n",
  );
  await $`git -C ${DATA} add -A`.quiet();
  await $`git -C ${DATA} commit -qm ${"init data"}`.quiet();

  PROJECT = await tempRepo("capshelf-api-project-");
  expect(cli(["init", "--data", DATA], PROJECT).exitCode).toBe(0);
  expect(cli(["add", "skills/hello"], PROJECT).exitCode).toBe(0);

  // A second data-repo commit so the activity feed has ordering to assert.
  await writeFile(
    join(DATA, "settings", "perms", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(ls)", "Bash(pwd)"] } })}\n`,
  );
  await $`git -C ${DATA} add -A`.quiet();
  await $`git -C ${DATA} commit -qm ${"widen perms"}`.quiet();
});

async function req(path: string, method = "GET") {
  return handleApiRequest(new Request(`http://localhost${path}`, { method }), {
    project: PROJECT,
  });
}

// JSON.parse(text()) keeps the parsed value implicitly-typed (no `any` keyword,
// which biome would reject), matching the other suites in this repo.
async function body(path: string) {
  const res = (await req(path))!;
  return JSON.parse(await res.text());
}

describe("serve API routing", () => {
  test("returns null for non-/api paths (handed to static serving)", async () => {
    expect(await req("/index.html")).toBeNull();
  });

  test("rejects non-GET with 405 read-only", async () => {
    const res = (await req("/api/status", "POST"))!;
    expect(res.status).toBe(405);
    expect(JSON.parse(await res.text()).error).toBe("read-only");
  });

  test("unknown /api route is 404", async () => {
    expect((await req("/api/nope"))!.status).toBe(404);
  });

  test("a handler failure becomes a 500 JSON error, not a crash", async () => {
    // A malformed item ref makes parseItemRef throw inside the handler.
    const res = (await req("/api/status?item=skills/"))!;
    expect(res.status).toBe(500);
    expect(typeof JSON.parse(await res.text()).error).toBe("string");
  });
});

describe("serve API endpoints", () => {
  test("/api/health reports a ready, read-only binding", async () => {
    const h = await body("/api/health");
    expect(h.readOnly).toBe(true);
    expect(h.dataRepoReady).toBe(true);
    expect(h.project).toBe(PROJECT);
    expect(typeof h.version).toBe("string");
  });

  test("/api/status lists the installed item with drift state", async () => {
    const s = await body("/api/status");
    const hello = s.items.find(
      (i: { kind: string; name: string }) =>
        i.kind === "skills" && i.name === "hello",
    );
    expect(hello).toBeDefined();
    expect(hello.state).toBe("ok");
    expect(hello.lockedSha).toMatch(/^[0-9a-f]+$/);
  });

  test("/api/catalog lists data + system items and bundles", async () => {
    const c = await body("/api/catalog");
    expect(c.dataRepoReady).toBe(true);
    const names = c.data.map((i: { name: string }) => i.name);
    expect(names).toContain("hello");
    expect(names).toContain("perms");
    expect(c.system.length).toBeGreaterThan(0);
    const starter = c.bundles.find(
      (b: { name: string }) => b.name === "starter",
    );
    expect(starter.members).toContain("skills/hello");
  });

  test("/api/catalog?kind filters; an invalid kind is ignored", async () => {
    const onlySkills = await body("/api/catalog?kind=skills");
    expect(
      onlySkills.data.every((i: { kind: string }) => i.kind === "skills"),
    ).toBe(true);

    const bogus = await body("/api/catalog?kind=bogus");
    const kinds = new Set(bogus.data.map((i: { kind: string }) => i.kind));
    expect(kinds.has("settings")).toBe(true); // not narrowed away
  });

  test("/api/config exposes counts and paths", async () => {
    const cfg = await body("/api/config");
    expect(cfg.counts.tracked).toBeGreaterThan(0);
    expect(cfg.paths.manifest.endsWith("capshelf.json")).toBe(true);
    expect(typeof cfg.installMode).toBe("string");
  });

  test("/api/activity returns commits newest-first with head matching", async () => {
    const a = await body("/api/activity");
    expect(a.dataRepoReady).toBe(true);
    expect(a.commits.length).toBeGreaterThanOrEqual(2);
    expect(a.commits[0].subject).toBe("widen perms");
    expect(a.head).toBe(a.commits[0].sha);
  });

  test("/api/activity?n caps the result and ignores junk", async () => {
    expect((await body("/api/activity?n=1")).commits.length).toBe(1);
    // non-integer falls back to the default rather than feeding git a float
    expect(
      (await body("/api/activity?n=abc")).commits.length,
    ).toBeGreaterThanOrEqual(2);
  });
});
