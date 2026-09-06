import { $ } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerProject } from "../src/project-registry";
import { startUiServer } from "../src/ui/server";
import type { UiServer } from "../src/ui/server";
import type {
  UiDiffResponse,
  UiError,
  UiOverview,
  UiProjectStatus,
  UiShelf,
  UiShelfItemDetail,
} from "../src/ui/shared/api-types";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface World {
  dataRepo: string;
  project: string;
  registryPath: string;
  server: UiServer;
}

let world: World;

interface RequestOptions {
  token?: string | null;
  host?: string;
  method?: string;
}

async function request(
  path: string,
  params: Record<string, string>,
  options: RequestOptions,
): Promise<Response> {
  const url = new URL(path, world.server.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (options.host !== undefined) headers.Host = options.host;
  return await fetch(url, { headers, method: options.method ?? "GET" });
}

/** A JSON API response. Every `/api/` route and error answers JSON. */
async function get<T>(
  path: string,
  params: Record<string, string> = {},
  options: RequestOptions = {},
): Promise<{ status: number; body: T }> {
  const response = await request(path, params, options);
  // SAFETY: every /api route is owned by src/ui/api.ts, which returns the
  // payload type the caller names, and `errorResponse` in src/ui/server.ts
  // answers every refusal with `UiError`. The server and this test are one
  // build.
  return { status: response.status, body: (await response.json()) as T };
}

/** A static asset: the shell, its script, or its stylesheet. */
async function getText(
  path: string,
): Promise<{ status: number; body: string }> {
  const response = await request(path, {}, { token: null });
  return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
  const dataRepo = await tempRepo("capshelf-ui-data-");
  await addSkill(dataRepo, "hello", "# hello\n\nfirst line\nsecond line\n");
  await writeFile(
    join(dataRepo, "skills", "hello", ".capshelf.yml"),
    "description: Says hello.\ntags: [greeting]\n",
  );
  await commitAll(dataRepo, "add hello");
  const project = await tempDir("capshelf-ui-project-");
  const run = runInProcess(project);
  const init = await run(["init", "--data", dataRepo, "--no-pick"]);
  expect(init.exitCode).toBe(0);
  expect(init.stdout.toString()).toContain("registered for capshelf ui");
  expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
  const registryPath = join(await tempDir("capshelf-ui-registry-"), "p.json");
  await registerProject(project, registryPath);
  const server = startUiServer({
    registryPath,
    token: TOKEN,
    currentProject: project,
  });
  world = { dataRepo, project, registryPath, server };
});

afterAll(async () => {
  await world?.server.stop();
});

describe("capshelf ui server", () => {
  test("serves the shell and its assets without a token", async () => {
    const shell = await getText("/");
    expect(shell.status).toBe(200);
    expect(shell.body).toContain('<div id="app">');
    expect(shell.body).toContain('src="/app.js"');
    const script = await getText("/app.js");
    expect(script.status).toBe(200);
    expect(script.body.length).toBeGreaterThan(1000);
    const css = await getText("/app.css");
    expect(css.status).toBe(200);
    expect(css.body).toContain("--green");
    const logo = await fetch(`${world.server.url}/logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect((await logo.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(logo.headers.get("cache-control")).toBe("no-store");
  });

  test("refuses the API without the token, with a foreign host, and for writes", async () => {
    const noToken = await get<UiError>("/api/overview", {}, { token: null });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error.message).toMatch(/access token/);
    const wrongToken = await get<UiError>(
      "/api/overview",
      {},
      { token: "nope" },
    );
    expect(wrongToken.status).toBe(401);
    const foreignHost = await get<UiError>(
      "/api/overview",
      {},
      { host: "evil.example.test:80" },
    );
    expect(foreignHost.status).toBe(403);
    const post = await get<UiError>("/api/overview", {}, { method: "POST" });
    expect(post.status).toBe(405);
    const missing = await get<UiError>("/api/nothing");
    expect(missing.status).toBe(404);
    const noParam = await get<UiError>("/api/project/status");
    expect(noParam.status).toBe(400);
    expect(noParam.body.error.message).toMatch(/project is required/);
  });

  test("the overview lists the registered project and its shelf", async () => {
    const { status, body } = await get<UiOverview>("/api/overview");
    expect(status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      path: world.project,
      exists: true,
    });
    expect(body.currentProject).toBe(world.project);
    expect(body.shelves).toEqual([
      { dataRepo: world.dataRepo, display: expect.any(String) },
    ]);
    expect(body.registryPath).toBe(world.registryPath);
  });

  test(
    "project status carries the CLI rows, labels, commands, and diffs",
    async () => {
      const clean = await get<UiProjectStatus>("/api/project/status", {
        project: world.project,
      });
      expect(clean.status).toBe(200);
      const hello = clean.body.items.find(
        (item) => item.ref === "skills/hello",
      );
      expect(hello).toBeDefined();
      expect(hello).toMatchObject({
        id: "project/data/skills/hello",
        scope: "project",
        source: "data",
        attention: false,
        tone: "ok",
        stateLabel: "Up to date",
        stateDetail: "up-to-date",
        actions: [],
        diffViews: [],
        installedPath: ".agents/skills/hello",
      });
      expect(hello?.row.state).toBe("ok");
      expect(clean.body.cdCommand).toBe(`cd ${world.project}`);
      expect(clean.body.shelf?.revisions[0]?.subject).toBe("add hello");
      expect(clean.body.shelf?.clean).toBe(true);
      expect(clean.body.notices).toEqual([]);
      const system = clean.body.items.find((item) => item.source === "system");
      expect(system?.ref).toBe("skills/capshelf");

      // A local edit: the row drifts, the command list names the three
      // resolutions, and the installed comparison shows the edit.
      await writeFile(
        join(world.project, ".agents", "skills", "hello", "SKILL.md"),
        "# hello\n\nfirst line\nedited line\n",
      );
      const drifted = await get<UiProjectStatus>("/api/project/status", {
        project: world.project,
      });
      const driftedHello = drifted.body.items.find(
        (item) => item.ref === "skills/hello",
      );
      expect(driftedHello).toMatchObject({
        attention: true,
        tone: "attention",
        stateLabel: "Drifted",
        diffViews: ["installed"],
      });
      expect(driftedHello?.row.state).toBe("drifted_local");
      expect(driftedHello?.actions.map((action) => action.command)).toEqual([
        "capshelf promote skills/hello",
        "capshelf keep-local skills/hello",
        "capshelf revert skills/hello",
      ]);
      const diff = await get<UiDiffResponse>("/api/project/diff", {
        project: world.project,
        item: "project/data/skills/hello",
        view: "installed",
      });
      expect(diff.status).toBe(200);
      expect(diff.body.diff?.text).toContain("-second line");
      expect(diff.body.diff?.text).toContain("+edited line");
      expect(diff.body.diff?.from.role).toBe("locked");
      expect(diff.body.diff?.to.role).toBe("installed");
      const noUpstream = await get<UiDiffResponse>("/api/project/diff", {
        project: world.project,
        item: "project/data/skills/hello",
        view: "upstream",
      });
      expect(noUpstream.body.diff).toBeNull();

      // The shelf moves too: both comparisons exist, and the merge command
      // leads the list.
      await addSkill(
        world.dataRepo,
        "hello",
        "# hello\n\nfirst line\nsecond line\nthird line\n",
      );
      await commitAll(world.dataRepo, "extend hello");
      const both = await get<UiProjectStatus>("/api/project/status", {
        project: world.project,
      });
      const bothHello = both.body.items.find(
        (item) => item.ref === "skills/hello",
      );
      expect(bothHello?.row.state).toBe("drifted_and_update");
      expect(bothHello?.diffViews).toEqual(["installed", "upstream"]);
      expect(bothHello?.actions[0]?.command).toBe(
        "capshelf update skills/hello --merge",
      );
      const upstream = await get<UiDiffResponse>("/api/project/diff", {
        project: world.project,
        item: "project/data/skills/hello",
        view: "upstream",
      });
      expect(upstream.body.diff?.text).toContain("+third line");
      expect(upstream.body.diff?.to.role).toBe("upstream");

      const badView = await get<UiError>("/api/project/diff", {
        project: world.project,
        item: "project/data/skills/hello",
        view: "sideways",
      });
      expect(badView.status).toBe(400);
      const unknownItem = await get<UiError>("/api/project/diff", {
        project: world.project,
        item: "project/data/skills/nope",
        view: "installed",
      });
      expect(unknownItem.status).toBe(404);
      const unregistered = await get<UiError>("/api/project/status", {
        project: "/nowhere",
      });
      expect(unregistered.status).toBe(404);
      expect(unregistered.body.error.hint).toContain(world.registryPath);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the shelf lists items with usage, and reads an item's files",
    async () => {
      const shelf = await get<UiShelf>("/api/shelf", { repo: world.dataRepo });
      expect(shelf.status).toBe(200);
      const hello = shelf.body.items.find(
        (item) => item.ref === "skills/hello",
      );
      expect(hello).toMatchObject({
        source: "data",
        description: "Says hello.",
        tags: ["greeting"],
      });
      expect(hello?.lastCommit?.subject).toBe("extend hello");
      expect(hello?.usage).toHaveLength(1);
      expect(hello?.usage[0]).toMatchObject({
        project: world.project,
        scope: "project",
        current: false,
        keptLocal: false,
      });
      expect(shelf.body.items.some((item) => item.source === "system")).toBe(
        true,
      );
      expect(shelf.body.projects.map((project) => project.path)).toEqual([
        world.project,
      ]);

      const detail = await get<UiShelfItemDetail>("/api/shelf/item", {
        repo: world.dataRepo,
        ref: "skills/hello",
      });
      expect(detail.status).toBe(200);
      expect(detail.body.files).toEqual(["SKILL.md"]);
      expect(detail.body.file?.name).toBe("SKILL.md");
      expect(detail.body.file?.text).toContain("third line");
      expect(detail.body.metadata.tags).toEqual(["greeting"]);
      expect(detail.body.path).toBe(join(world.dataRepo, "skills", "hello"));

      const system = await get<UiShelfItemDetail>("/api/shelf/item", {
        repo: world.dataRepo,
        ref: "skills/capshelf",
      });
      expect(system.status).toBe(200);
      expect(system.body.source).toBe("system");
      expect(system.body.file?.text).toContain("capshelf");

      const noFile = await get<UiError>("/api/shelf/item", {
        repo: world.dataRepo,
        ref: "skills/hello",
        file: "nope.md",
      });
      expect(noFile.status).toBe(404);
      const noItem = await get<UiError>("/api/shelf/item", {
        repo: world.dataRepo,
        ref: "skills/nope",
      });
      expect(noItem.status).toBe(404);
      const noRepo = await get<UiError>("/api/shelf", { repo: "/nowhere" });
      expect(noRepo.status).toBe(404);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("a registered path without a manifest is reported, not hidden", async () => {
    const gone = await tempDir("capshelf-ui-gone-");
    await registerProject(gone, world.registryPath);
    const overview = await get<UiOverview>("/api/overview");
    expect(overview.body.projects.map((project) => project.exists)).toEqual([
      true,
      false,
    ]);
    const status = await get<UiError>("/api/project/status", { project: gone });
    expect(status.status).toBe(400);
    expect(status.body.error.message).toMatch(/no capshelf project/);
  });

  test("a legacy lock produces a migration notice", async () => {
    const lockPath = join(world.project, ".capshelf", "capshelf.lock.json");
    const lock = JSON.parse(await Bun.file(lockPath).text());
    const legacy = {
      version: 3,
      items: Object.fromEntries(
        Object.entries(lock.items).map(([key, entry]) => {
          const value = entry as Record<string, unknown>;
          if (value.source !== "data") return [key, value];
          const { sourcePinDigest, ...rest } = value;
          return [key, { ...rest, sha: String(sourcePinDigest).slice(0, 12) }];
        }),
      ),
    };
    await writeFile(lockPath, `${JSON.stringify(legacy, null, 2)}\n`);
    try {
      const status = await get<UiProjectStatus>("/api/project/status", {
        project: world.project,
      });
      expect(status.status).toBe(200);
      expect(status.body.lockVersion).toBe(3);
      expect(status.body.notices[0]?.message).toMatch(/legacy lock/);
      expect(status.body.notices[0]?.actions?.[0]?.command).toBe(
        "capshelf lock migrate --dry-run",
      );
    } finally {
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
  });

  test("the item id, not a second status run, selects the diff row", async () => {
    // A diff request for a project the server has not loaded yet computes
    // the rows first, then answers from them.
    const server = startUiServer({
      registryPath: world.registryPath,
      token: TOKEN,
    });
    try {
      const url = new URL("/api/project/diff", server.url);
      url.searchParams.set("project", world.project);
      url.searchParams.set("item", "project/data/skills/hello");
      url.searchParams.set("view", "installed");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as UiDiffResponse;
      expect(body.diff?.text).toContain("+edited line");
    } finally {
      await server.stop();
    }
  });
});

// Keep the shell dependency visible: the fixtures above run real git.
void $;
