import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type GitFileMode,
  mergeNamedTrees,
  type NamedFile,
} from "../src/merge-tree";

function file(
  path: string,
  content: string,
  mode: GitFileMode = "100644",
): NamedFile {
  return { path, content: Buffer.from(content), mode };
}

function contents(files: NamedFile[]): Record<string, string> {
  return Object.fromEntries(
    files.map((entry) => [entry.path, entry.content.toString()]),
  );
}

describe("mergeNamedTrees", () => {
  test("combines disjoint files and independent hunks", async () => {
    const base = [
      file("shared.txt", "one\ntwo\nthree\n"),
      file("base-only.txt", "base\n"),
    ];
    const local = [
      file("shared.txt", "ONE\ntwo\nthree\n"),
      file("base-only.txt", "base\n"),
      file("local.txt", "local\n"),
    ];
    const upstream = [
      file("shared.txt", "one\ntwo\nTHREE\n"),
      file("base-only.txt", "base\n"),
      file("upstream.txt", "upstream\n"),
    ];

    const result = await mergeNamedTrees(base, local, upstream);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contents(result.files)).toEqual({
      "base-only.txt": "base\n",
      "local.txt": "local\n",
      "shared.txt": "ONE\ntwo\nTHREE\n",
      "upstream.txt": "upstream\n",
    });
  });

  test("reports sorted conflicts without returning conflict-marker files", async () => {
    const base = [file("z.txt", "base\n"), file("a.txt", "base\n")];
    const local = [file("z.txt", "local\n"), file("a.txt", "local\n")];
    const upstream = [file("z.txt", "upstream\n"), file("a.txt", "upstream\n")];

    const result = await mergeNamedTrees(base, local, upstream);

    expect(result).toEqual({
      ok: false,
      conflicts: ["a.txt", "z.txt"],
    });
  });

  test("handles binary one-sided changes and flags binary two-sided changes", async () => {
    const base = [
      { path: "asset.bin", content: Buffer.from([0, 1, 2]), mode: "100644" },
    ] satisfies NamedFile[];
    const local = [
      { path: "asset.bin", content: Buffer.from([0, 1, 2]), mode: "100644" },
    ] satisfies NamedFile[];
    const upstream = [
      { path: "asset.bin", content: Buffer.from([0, 9, 2]), mode: "100644" },
    ] satisfies NamedFile[];

    const oneSided = await mergeNamedTrees(base, local, upstream);
    expect(oneSided.ok).toBe(true);
    if (oneSided.ok) {
      expect(oneSided.files[0]?.content).toEqual(Buffer.from([0, 9, 2]));
    }

    const twoSided = await mergeNamedTrees(
      base,
      [{ path: "asset.bin", content: Buffer.from([0, 8, 2]), mode: "100644" }],
      upstream,
    );
    expect(twoSided).toEqual({ ok: false, conflicts: ["asset.bin"] });
  });

  test("preserves executable modes", async () => {
    const result = await mergeNamedTrees(
      [file("run.sh", "echo base\n")],
      [file("run.sh", "echo base\n", "100755")],
      [file("other.txt", "upstream\n"), file("run.sh", "echo base\n")],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.find((entry) => entry.path === "run.sh")?.mode).toBe(
      "100755",
    );
  });

  test("converges identical changes and carries edits across a rename", async () => {
    const identical = await mergeNamedTrees(
      [file("value.txt", "base\n")],
      [file("value.txt", "same\n")],
      [file("value.txt", "same\n")],
    );
    expect(identical.ok).toBe(true);
    if (identical.ok) {
      expect(contents(identical.files)).toEqual({ "value.txt": "same\n" });
    }

    const renamed = await mergeNamedTrees(
      [file("old.txt", "one\ntwo\n")],
      [file("new.txt", "one\ntwo\n")],
      [file("old.txt", "one\nTWO\n")],
    );
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(contents(renamed.files)).toEqual({ "new.txt": "one\nTWO\n" });
    }
  });

  test("uses Git conflict behavior for add/add, delete/modify, and file/directory shapes", async () => {
    const addAdd = await mergeNamedTrees(
      [],
      [file("same.txt", "local\n")],
      [file("same.txt", "upstream\n")],
    );
    expect(addAdd).toEqual({ ok: false, conflicts: ["same.txt"] });

    const deleteModify = await mergeNamedTrees(
      [file("same.txt", "base\n")],
      [],
      [file("same.txt", "upstream\n")],
    );
    expect(deleteModify).toEqual({ ok: false, conflicts: ["same.txt"] });

    const fileDirectory = await mergeNamedTrees(
      [],
      [file("node", "local file\n")],
      [file("node/child.txt", "upstream child\n")],
    );
    expect(fileDirectory.ok).toBe(false);
    if (!fileDirectory.ok) {
      expect(fileDirectory.conflicts.length).toBeGreaterThan(0);
    }
  });

  test("removes temporary repositories on success, conflict, and validation errors", async () => {
    const parent = await mkdtemp(join(tmpdir(), "capshelf-merge-cleanup-"));
    await mergeNamedTrees(
      [file("value.txt", "base\n")],
      [file("local.txt", "local\n"), file("value.txt", "base\n")],
      [file("upstream.txt", "upstream\n"), file("value.txt", "base\n")],
      { temporaryParent: parent },
    );
    expect(await readdir(parent)).toEqual([]);

    await mergeNamedTrees(
      [file("value.txt", "base\n")],
      [file("value.txt", "local\n")],
      [file("value.txt", "upstream\n")],
      { temporaryParent: parent },
    );
    expect(await readdir(parent)).toEqual([]);

    await expect(
      mergeNamedTrees([], [file("../escape", "invalid\n")], [], {
        temporaryParent: parent,
      }),
    ).rejects.toThrow("invalid item-relative path");
    expect(await readdir(parent)).toEqual([]);
  });

  test("isolates every configured command and repository-redirection channel", async () => {
    const hostile = await mkdtemp(join(tmpdir(), "capshelf-hostile-git-"));
    const templateHooks = join(hostile, "template", "hooks");
    const configuredHooks = join(hostile, "configured-hooks");
    const environmentHooks = join(hostile, "environment-hooks");
    const globalConfig = join(hostile, "global-config");
    const systemConfig = join(hostile, "system-config");
    const sentinels: string[] = [];
    const command = async (name: string): Promise<string> => {
      const sentinel = join(hostile, `${name}.executed`);
      const path = join(hostile, `${name}.sh`);
      sentinels.push(sentinel);
      await writeFile(path, `#!/bin/sh\nprintf invoked > "${sentinel}"\ncat\n`);
      await chmod(path, 0o755);
      return path;
    };
    await Promise.all([
      mkdir(templateHooks, { recursive: true }),
      mkdir(configuredHooks),
      mkdir(environmentHooks),
    ]);
    const templateHook = await command("template-hook");
    const configuredHook = await command("configured-hook");
    const environmentHook = await command("environment-hook");
    const filter = await command("filter");
    const mergeDriver = await command("merge-driver");
    const fsmonitor = await command("fsmonitor");
    await writeFile(
      join(templateHooks, "pre-commit"),
      `#!/bin/sh\n"${templateHook}"\n`,
    );
    await chmod(join(templateHooks, "pre-commit"), 0o755);
    await writeFile(
      join(configuredHooks, "pre-commit"),
      `#!/bin/sh\n"${configuredHook}"\n`,
    );
    await chmod(join(configuredHooks, "pre-commit"), 0o755);
    await writeFile(
      join(environmentHooks, "pre-commit"),
      `#!/bin/sh\n"${environmentHook}"\n`,
    );
    await chmod(join(environmentHooks, "pre-commit"), 0o755);
    await writeFile(
      globalConfig,
      `[init]\n\ttemplateDir = ${join(hostile, "template")}\n[core]\n\thooksPath = ${configuredHooks}\n[filter "hostile"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n[merge "hostile"]\n\tdriver = ${mergeDriver}\n`,
    );
    await writeFile(systemConfig, `[core]\n\tfsmonitor = ${fsmonitor}\n`);
    const injectedEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: environmentHooks,
      GIT_DIR: join(hostile, "redirected.git"),
      GIT_WORK_TREE: join(hostile, "redirected-worktree"),
      GIT_INDEX_FILE: join(hostile, "redirected-index"),
      GIT_OBJECT_DIRECTORY: join(hostile, "redirected-objects"),
      GIT_COMMON_DIR: join(hostile, "redirected-common"),
      GIT_TEMPLATE_DIR: join(hostile, "template"),
    };
    const oldEnv = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(injectedEnv)) {
      oldEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const result = await mergeNamedTrees(
        [
          file(".gitattributes", "*.txt filter=hostile merge=hostile\n"),
          file("value.txt", "base\n"),
        ],
        [
          file(".gitattributes", "*.txt filter=hostile merge=hostile\n"),
          file("value.txt", "local\n"),
        ],
        [
          file(".gitattributes", "*.txt filter=hostile merge=hostile\n"),
          file("value.txt", "upstream\n"),
        ],
      );
      expect(result.ok).toBe(false);
      for (const sentinel of sentinels) {
        expect(existsSync(sentinel)).toBe(false);
      }
    } finally {
      for (const [key, value] of oldEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
