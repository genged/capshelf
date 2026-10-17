import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitTreeSource } from "../src/item-source";
import { itemTreeEntriesAtCommit } from "../src/pin";
import type { PinTreeEntry } from "../src/pin";
import {
  newRunsEntries,
  pluginRunsAtCommit,
  pluginRunsOnDisk,
  readPluginRuns,
  runsHaveEntries,
} from "../src/plugin-runs";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

function reader(files: Record<string, string>) {
  return async (rel: string) =>
    rel in files ? Buffer.from(files[rel]!) : null;
}
interface HookGroupJson {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

function hooksJson(event: string, command: string, matcher?: string): string {
  const group: HookGroupJson = { hooks: [{ type: "command", command }] };
  if (matcher) group.matcher = matcher;
  return JSON.stringify({ hooks: { [event]: [group] } });
}

describe("readPluginRuns", () => {
  test("no hooks and no servers", async () => {
    const runs = await readPluginRuns(
      reader({ ".claude-plugin/plugin.json": '{"name":"p"}' }),
    );
    expect(runs).toEqual({ hooks: [], mcpServers: [], unknown: [] });
    expect(runsHaveEntries(runs)).toBe(false);
  });
  test("hooks/hooks.json only", async () => {
    const runs = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json": '{"name":"p"}',
        "hooks/hooks.json": hooksJson("SessionStart", "bash a.sh", "startup"),
      }),
    );
    expect(runs.hooks).toEqual([
      {
        event: "SessionStart",
        matcher: "startup",
        type: "command",
        command: "bash a.sh",
        source: "hooks/hooks.json",
      },
    ]);
  });
  test("a manifest hooks path adds to the default file (R10)", async () => {
    const runs = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json": '{"name":"p","hooks":"./custom/h.json"}',
        "hooks/hooks.json": hooksJson("SessionStart", "a"),
        "custom/h.json": hooksJson("PreToolUse", "b", "Bash"),
      }),
    );
    expect(runs.hooks.map((h) => h.command)).toEqual(["a", "b"]);
  });
  test("inline manifest hooks and an array of paths", async () => {
    const inline = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "p",
          hooks: JSON.parse(hooksJson("Stop", "c")),
        }),
      }),
    );
    expect(inline.hooks[0]!.source).toBe(".claude-plugin/plugin.json");
    const list = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json":
          '{"name":"p","hooks":["./a.json","./b.json"]}',
        "a.json": hooksJson("Stop", "a"),
        "b.json": hooksJson("Stop", "b"),
      }),
    );
    expect(list.hooks.map((h) => h.command)).toEqual(["a", "b"]);
  });
  test(".mcp.json in both shapes and inline mcpServers", async () => {
    const flat = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json": '{"name":"p"}',
        ".mcp.json": '{"srv":{"command":"docker","args":["run"]}}',
      }),
    );
    expect(flat.mcpServers).toEqual([
      { name: "srv", command: "docker run", url: null, source: ".mcp.json" },
    ]);
    const wrapped = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json": '{"name":"p"}',
        ".mcp.json": '{"mcpServers":{"web":{"type":"http","url":"https://x"}}}',
      }),
    );
    expect(wrapped.mcpServers[0]).toMatchObject({
      name: "web",
      command: null,
      url: "https://x",
    });
    const inline = await readPluginRuns(
      reader({
        ".claude-plugin/plugin.json":
          '{"name":"p","mcpServers":{"i":{"command":"node"}}}',
      }),
    );
    expect(inline.mcpServers[0]).toMatchObject({
      name: "i",
      source: ".claude-plugin/plugin.json",
    });
  });
  test("an unreadable declaration is unknown, never 'no hooks'", async () => {
    const cases: Array<Record<string, string>> = [
      {
        ".claude-plugin/plugin.json": '{"name":"p"}',
        "hooks/hooks.json": "{not json",
      },
      {
        ".claude-plugin/plugin.json": '{"name":"p","hooks":"../outside.json"}',
      },
      { ".claude-plugin/plugin.json": '{"name":"p","hooks":"./missing.json"}' },
      { ".claude-plugin/plugin.json": '{"name":"p","hooks":42}' },
      { ".claude-plugin/plugin.json": "{bad" },
      {
        ".claude-plugin/plugin.json": '{"name":"p"}',
        "hooks/hooks.json": '{"hooks":{"Stop":"x"}}',
      },
    ];
    for (const files of cases) {
      const runs = await readPluginRuns(reader(files));
      expect(runs.unknown.length).toBe(1);
      expect(runsHaveEntries(runs)).toBe(true);
    }
  });
});

describe("newRunsEntries", () => {
  const hook = (command: string) => ({
    event: "SessionStart",
    matcher: null,
    type: "command",
    command,
    source: "hooks/hooks.json",
  });
  const runs = (...commands: string[]) => ({
    hooks: commands.map(hook),
    mcpServers: [],
    unknown: [],
  });
  test("a new entry and a changed command are new", () => {
    expect(
      newRunsEntries(runs("a"), runs("a", "b")).hooks.map((h) => h.command),
    ).toEqual(["b"]);
    expect(
      newRunsEntries(runs("a"), runs("a2")).hooks.map((h) => h.command),
    ).toEqual(["a2"]);
  });
  test("a removed entry and no change are not new", () => {
    expect(runsHaveEntries(newRunsEntries(runs("a", "b"), runs("a")))).toBe(
      false,
    );
    expect(runsHaveEntries(newRunsEntries(runs("a"), runs("a")))).toBe(false);
  });
  test("a new unknown is new", () => {
    const next = {
      ...runs("a"),
      unknown: ["hooks/hooks.json could not be read"],
    };
    expect(newRunsEntries(runs("a"), next).unknown).toEqual(next.unknown);
  });
  test("an unknown the previous tree also had is still reported (D7)", () => {
    const both = {
      ...runs("a"),
      unknown: ["hooks/hooks.json could not be read"],
    };
    const fresh = newRunsEntries(both, both);
    expect(fresh.unknown).toEqual(both.unknown);
    expect(fresh.hooks).toEqual([]);
    expect(runsHaveEntries(fresh)).toBe(true);
  });
});

describe("pluginRunsAtCommit", () => {
  test("reads hooks and mcp servers from a pinned tree, default then manifest order", async () => {
    const repo = await tempRepo("capshelf-plugin-runs-commit-");
    const pluginDir = join(repo, "plugins", "p");
    await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginDir, "hooks"), { recursive: true });
    await mkdir(join(pluginDir, "custom"), { recursive: true });
    await writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        hooks: "./custom/h.json",
        mcpServers: { i: { command: "node" } },
      }),
    );
    await writeFile(
      join(pluginDir, "hooks", "hooks.json"),
      hooksJson("SessionStart", "bash a.sh", "startup"),
    );
    await writeFile(
      join(pluginDir, "custom", "h.json"),
      hooksJson("PreToolUse", "bash b.sh", "Bash"),
    );
    await writeFile(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({ srv: { command: "docker" } }),
    );
    await commitAll(repo, "plugin p");

    const entries = await itemTreeEntriesAtCommit(
      gitTreeSource({ repo, kind: "plugins", name: "p", commit: "HEAD" }),
      "plugins",
    );
    const runs = await pluginRunsAtCommit(repo, entries);

    expect(runs.hooks.map((h) => h.command)).toEqual([
      "bash a.sh",
      "bash b.sh",
    ]);
    expect(runs.mcpServers).toEqual([
      { name: "srv", command: "docker", url: null, source: ".mcp.json" },
      {
        name: "i",
        command: "node",
        url: null,
        source: ".claude-plugin/plugin.json",
      },
    ]);
    expect(runs.unknown).toEqual([]);
  });

  test("a manifest path with no matching tree entry is unknown, not thrown", async () => {
    const repo = await tempRepo("capshelf-plugin-runs-commit-missing-");
    const pluginDir = join(repo, "plugins", "p");
    await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", hooks: "./missing.json" }),
    );
    await commitAll(repo, "plugin p");

    const entries = await itemTreeEntriesAtCommit(
      gitTreeSource({ repo, kind: "plugins", name: "p", commit: "HEAD" }),
      "plugins",
    );
    const runs = await pluginRunsAtCommit(repo, entries);

    expect(runs.unknown).toEqual(["missing.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });

  test("a non-regular tree entry at a default path is unknown, not absent", async () => {
    const repo = await tempRepo("capshelf-plugin-runs-commit-mode-");
    const pluginDir = join(repo, "plugins", "p");
    await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginDir, "hooks"), { recursive: true });
    await writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await writeFile(
      join(pluginDir, "hooks", "hooks.json"),
      hooksJson("Stop", "bash x.sh"),
    );
    await commitAll(repo, "plugin p");

    const entries = await itemTreeEntriesAtCommit(
      gitTreeSource({ repo, kind: "plugins", name: "p", commit: "HEAD" }),
      "plugins",
    );
    // SAFETY: `itemTreeEntriesAtCommit` never actually returns this mode for
    // hooks/hooks.json — assertRegularBlobEntries (src/git.ts:697-712)
    // refuses a symlink or gitlink before pin.ts builds a PinTreeEntry, and
    // GitFileMode's type only admits "100644"/"100755". This cast simulates
    // a caller that bypasses that guard, to prove pluginRunsAtCommit does
    // not depend on it.
    const tampered: PinTreeEntry[] = entries.map((entry) =>
      entry.path === "hooks/hooks.json"
        ? { ...entry, mode: "120000" as PinTreeEntry["mode"] }
        : entry,
    );

    const runs = await pluginRunsAtCommit(repo, tampered);

    expect(runs.hooks).toEqual([]);
    expect(runs.unknown).toEqual(["hooks/hooks.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });
});

describe("pluginRunsOnDisk", () => {
  test("reads hooks and mcp servers from an installed directory", async () => {
    const dir = await tempDir("capshelf-plugin-runs-disk-");
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await writeFile(
      join(dir, "hooks", "hooks.json"),
      hooksJson("Stop", "bash stop.sh"),
    );
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { web: { url: "https://x" } } }),
    );

    const runs = await pluginRunsOnDisk(dir);

    expect(runs.hooks.map((h) => h.command)).toEqual(["bash stop.sh"]);
    expect(runs.mcpServers).toEqual([
      { name: "web", command: null, url: "https://x", source: ".mcp.json" },
    ]);
    expect(runs.unknown).toEqual([]);
  });

  test("a symlinked hooks file is unknown, never silently skipped", async () => {
    const dir = await tempDir("capshelf-plugin-runs-disk-symlink-");
    const outsideDir = await tempDir("capshelf-plugin-runs-disk-outside-");
    const outsideFile = join(outsideDir, "h.json");
    await writeFile(outsideFile, hooksJson("Stop", "bash evil.sh"));
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await mkdir(join(dir, "custom"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", hooks: "./custom/h.json" }),
    );
    await symlink(outsideFile, join(dir, "custom", "h.json"));

    const runs = await pluginRunsOnDisk(dir);

    expect(runs.hooks).toEqual([]);
    expect(runs.unknown).toEqual(["custom/h.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });

  test("a symlinked default hooks/hooks.json is unknown, never absent", async () => {
    const dir = await tempDir("capshelf-plugin-runs-disk-default-symlink-");
    const outsideDir = await tempDir("capshelf-plugin-runs-disk-outside2-");
    const outsideFile = join(outsideDir, "hooks.json");
    await writeFile(outsideFile, hooksJson("Stop", "bash evil.sh"));
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await mkdir(join(dir, "hooks"), { recursive: true });
    await symlink(outsideFile, join(dir, "hooks", "hooks.json"));

    const runs = await pluginRunsOnDisk(dir);

    expect(runs.hooks).toEqual([]);
    expect(runs.unknown).toEqual(["hooks/hooks.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });

  test("a symlinked .mcp.json is unknown, never absent", async () => {
    const dir = await tempDir("capshelf-plugin-runs-disk-mcp-symlink-");
    const outsideDir = await tempDir("capshelf-plugin-runs-disk-outside3-");
    const outsideFile = join(outsideDir, "mcp.json");
    await writeFile(outsideFile, JSON.stringify({ srv: { command: "evil" } }));
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await symlink(outsideFile, join(dir, ".mcp.json"));

    const runs = await pluginRunsOnDisk(dir);

    expect(runs.mcpServers).toEqual([]);
    expect(runs.unknown).toEqual([".mcp.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });

  test("a directory at hooks/hooks.json is unknown", async () => {
    const dir = await tempDir("capshelf-plugin-runs-disk-hooks-dir-");
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await mkdir(join(dir, "hooks", "hooks.json"), { recursive: true });

    const runs = await pluginRunsOnDisk(dir);

    expect(runs.hooks).toEqual([]);
    expect(runs.unknown).toEqual(["hooks/hooks.json could not be read"]);
    expect(runsHaveEntries(runs)).toBe(true);
  });
});
