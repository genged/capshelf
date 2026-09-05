import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addRegisteredProject,
  emptyProjectRegistry,
  loadProjectRegistry,
  projectRegistryPath,
  registerProject,
  saveProjectRegistry,
} from "../src/project-registry";
import { tempDir } from "./cli-fixtures";

describe("project registry", () => {
  test("lives under the XDG config home, with ~/.config as the fallback", () => {
    expect(projectRegistryPath({ XDG_CONFIG_HOME: "/x/config" })).toBe(
      "/x/config/capshelf/projects.json",
    );
    expect(projectRegistryPath({ XDG_CONFIG_HOME: "  " })).toMatch(
      /\/\.config\/capshelf\/projects\.json$/,
    );
    expect(projectRegistryPath({})).toMatch(
      /\/\.config\/capshelf\/projects\.json$/,
    );
  });

  test("a missing file is an empty registry", async () => {
    const dir = await tempDir("capshelf-registry-");
    const registry = await loadProjectRegistry(join(dir, "projects.json"));
    expect(registry).toEqual({ version: 1, projects: [] });
  });

  test("adds a project once, resolved, and keeps insertion order", () => {
    const registry = emptyProjectRegistry();
    const now = new Date("2026-09-05T10:00:00.000Z");
    expect(addRegisteredProject(registry, "/a/b/", now)).toBe(true);
    expect(addRegisteredProject(registry, "/a/b", now)).toBe(false);
    expect(addRegisteredProject(registry, "/a/b/../b", now)).toBe(false);
    expect(addRegisteredProject(registry, "/c", now)).toBe(true);
    expect(registry.projects).toEqual([
      { path: "/a/b", registeredAt: "2026-09-05T10:00:00.000Z" },
      { path: "/c", registeredAt: "2026-09-05T10:00:00.000Z" },
    ]);
  });

  test("registerProject writes the file and is idempotent", async () => {
    const dir = await tempDir("capshelf-registry-");
    const path = join(dir, "nested", "projects.json");
    expect(await registerProject("/proj/one", path)).toBe(true);
    expect(await registerProject("/proj/one", path)).toBe(false);
    expect(await registerProject("/proj/two", path)).toBe(true);
    const written = JSON.parse(await readFile(path, "utf-8"));
    expect(written.version).toBe(1);
    expect(written.projects.map((p: { path: string }) => p.path)).toEqual([
      "/proj/one",
      "/proj/two",
    ]);
    expect((await readFile(path, "utf-8")).endsWith("\n")).toBe(true);
  });

  test("refuses a registry newer than this version", async () => {
    const dir = await tempDir("capshelf-registry-");
    const path = join(dir, "projects.json");
    await Bun.write(path, JSON.stringify({ version: 2, projects: [] }));
    await expect(loadProjectRegistry(path)).rejects.toThrow(
      /registry version 2, newer than this capshelf supports/,
    );
  });

  test("rejects a malformed entry instead of guessing", async () => {
    const dir = await tempDir("capshelf-registry-");
    const path = join(dir, "projects.json");
    await Bun.write(
      path,
      JSON.stringify({ version: 1, projects: [{ path: "" }] }),
    );
    await expect(loadProjectRegistry(path)).rejects.toThrow();
    await expect(
      saveProjectRegistry(
        { version: 1, projects: [{ path: "", registeredAt: "x" }] },
        path,
      ),
    ).rejects.toThrow();
  });
});
