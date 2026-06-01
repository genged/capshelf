import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureInstallAliases,
  findInstallConflict,
  installedPath,
  isInstalled,
  parseLockKey,
  removeInstallAliases,
  shaOfInstalled,
} from "../src/installed";
import {
  assertDataRepoExists,
  findMasterItem,
  listMasterItems,
  shaOfItem,
} from "../src/master";
import type { MasterItem } from "../src/master";
import { copyItemIntoProject, targetDir } from "../src/sync";
import {
  findSystemItem,
  installSystemItem,
  isSystemItemName,
  shaOfSystemItem,
  systemTargetDir,
  SYSTEM_ITEMS,
} from "../src/bundled";
import type { SystemItem } from "../src/bundled";

async function tempDir(prefix = "capshelf-installed-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(prefix = "capshelf-installed-repo-"): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

function isExecutable(path: string): boolean {
  return (lstatSync(path).mode & 0o111) !== 0;
}

describe("installed item paths and hashes", () => {
  test("maps supported item kinds to project paths", () => {
    const project = "/tmp/project";

    expect(installedPath(project, "skills", "hello")).toBe(
      "/tmp/project/.agents/skills/hello",
    );
    expect(installedPath(project, "settings", "base")).toBe(
      "/tmp/project/.claude/settings.json",
    );
    expect(installedPath(project, "mcp", "server")).toBe(
      "/tmp/project/.mcp.json",
    );
    expect(installedPath(project, "codex-config", "defaults")).toBe(
      "/tmp/project/.codex/config.toml",
    );
    expect(installedPath(project, "skills", "hello", "claude-only")).toBe(
      "/tmp/project/.claude/skills/hello",
    );
  });

  test("follows Claude skill symlinks to their real path", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".agents", "skills", "hello"), {
      recursive: true,
    });
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await symlink(
      "../../.agents/skills/hello",
      join(project, ".claude", "skills", "hello"),
      "dir",
    );

    expect(installedPath(project, "skills", "hello")).toBe(
      join(project, ".agents", "skills", "hello"),
    );
  });

  test("reports missing and present installed items", async () => {
    const project = await tempDir();
    expect(isInstalled(project, "skills", "hello")).toBe(false);
    expect(await shaOfInstalled(project, "skills", "hello")).toBeNull();

    await mkdir(join(project, ".agents", "skills", "hello"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello\n",
    );

    expect(isInstalled(project, "skills", "hello")).toBe(true);
    expect(await shaOfInstalled(project, "skills", "hello")).toMatch(
      /^[0-9a-f]{12}$/,
    );
  });

  test("installed hashes ignore gitignored files", async () => {
    const project = await tempRepo("capshelf-installed-project-");
    const skill = join(project, ".agents", "skills", "hello");
    await mkdir(skill, { recursive: true });
    await writeFile(join(project, ".gitignore"), "*.local\n");
    await writeFile(join(skill, "SKILL.md"), "hello\n");
    await $`git -C ${project} add .`.quiet();
    await $`git -C ${project} commit -qm baseline`.quiet();

    const before = await shaOfInstalled(project, "skills", "hello");
    await writeFile(join(skill, ".env.local"), "secret\n");

    expect(await shaOfInstalled(project, "skills", "hello")).toBe(before);
  });

  test("detects untracked Claude compatibility paths before default install", async () => {
    const project = await tempDir();
    const localOnly = join(project, ".claude", "skills", "hello");
    await mkdir(localOnly, { recursive: true });
    await writeFile(join(localOnly, "SKILL.md"), "local\n");

    expect(findInstallConflict(project, "skills", "hello")).toBe(localOnly);
  });

  test("refuses to replace non-symlink compatibility paths", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".agents", "skills", "hello"), {
      recursive: true,
    });
    await mkdir(join(project, ".claude", "skills", "hello"), {
      recursive: true,
    });

    await expect(
      ensureInstallAliases(project, "skills", "hello"),
    ).rejects.toThrow(/not a symlink/);
  });

  test("removes broken managed compatibility symlinks", async () => {
    const project = await tempDir();
    const realPath = join(project, ".agents", "skills", "hello");
    const linkPath = join(project, ".claude", "skills", "hello");
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await symlink("../../.agents/skills/hello", linkPath, "dir");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(
      await removeInstallAliases(project, "skills", "hello", realPath),
    ).toBe(true);
    expect(() => lstatSync(linkPath)).toThrow();
  });
});

describe("sync materialization", () => {
  test("replaces managed target directories and removes stale files", async () => {
    const project = await tempDir();
    const source = await tempDir("capshelf-sync-src-");
    const item: MasterItem = {
      kind: "skills",
      name: "hello",
      path: source,
      repoRelPath: "skills/hello",
    };
    const dst = targetDir(project, item);

    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "hello\n");
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(join(source, "scripts", "run.sh"), 0o755);
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "stale.txt"), "stale\n");

    await copyItemIntoProject(project, item);

    expect(existsSync(join(dst, "SKILL.md"))).toBe(true);
    expect(isExecutable(join(dst, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(dst, "stale.txt"))).toBe(false);
    expect(
      lstatSync(join(project, ".claude", "skills", "hello")).isSymbolicLink(),
    ).toBe(true);
  });

  test("copies tracked dotfiles as item content", async () => {
    const project = await tempDir();
    const source = await tempDir("capshelf-sync-src-");
    const item: MasterItem = {
      kind: "skills",
      name: "hello",
      path: source,
      repoRelPath: "skills/hello",
    };

    await writeFile(join(source, "SKILL.md"), "hello\n");
    await writeFile(join(source, ".gitignore"), "generated/\n");
    await writeFile(join(source, ".env.1password"), "API_KEY=op://vault/key\n");
    await writeFile(join(source, ".secret"), "secret\n");
    await mkdir(join(source, "nested", ".gitignore"), { recursive: true });
    await writeFile(join(source, "nested", ".gitignore", "ignored.txt"), "x\n");

    await copyItemIntoProject(project, item);

    const dst = targetDir(project, item);
    expect(existsSync(join(dst, ".gitignore"))).toBe(true);
    expect(existsSync(join(dst, ".env.1password"))).toBe(true);
    expect(existsSync(join(dst, ".secret"))).toBe(true);
    expect(existsSync(join(dst, "nested", ".gitignore", "ignored.txt"))).toBe(
      true,
    );
  });

  test("copies unignored git-visible files and skips gitignored files", async () => {
    const project = await tempDir();
    const dataRepo = await tempRepo();
    const source = join(dataRepo, "skills", "hello");
    const item: MasterItem = {
      kind: "skills",
      name: "hello",
      path: source,
      repoRelPath: "skills/hello",
    };

    await mkdir(source, { recursive: true });
    await writeFile(join(dataRepo, ".gitignore"), "*.local\nignored-dir/\n");
    await writeFile(join(source, "SKILL.md"), "hello\n");
    await writeFile(join(source, ".env.1password"), "op\n");
    await writeFile(join(source, ".env.local"), "secret\n");
    await mkdir(join(source, "ignored-dir"), { recursive: true });
    await writeFile(join(source, "ignored-dir", "x"), "x\n");
    await $`git -C ${dataRepo} add .`.quiet();
    await $`git -C ${dataRepo} commit -qm baseline`.quiet();

    await copyItemIntoProject(project, item);

    const dst = targetDir(project, item);
    expect(existsSync(join(dst, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dst, ".env.1password"))).toBe(true);
    expect(existsSync(join(dst, ".env.local"))).toBe(false);
    expect(existsSync(join(dst, "ignored-dir", "x"))).toBe(false);
  });

  test("system materialization replaces managed targets and removes stale files", async () => {
    const project = await tempDir();
    const item: SystemItem = {
      kind: "skills",
      name: "system-hello",
      files: [{ relPath: "SKILL.md", content: "system hello\n" }],
    };
    const dst = systemTargetDir(project, item);

    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "stale.txt"), "stale\n");

    await installSystemItem(project, item);

    expect(existsSync(join(dst, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dst, "stale.txt"))).toBe(false);
    expect(
      lstatSync(
        join(project, ".claude", "skills", "system-hello"),
      ).isSymbolicLink(),
    ).toBe(true);
  });
});

describe("system item registry", () => {
  test("finds bundled items and hashes them like directory content", async () => {
    const item = findSystemItem("capshelf");

    expect(item).not.toBeNull();
    expect(isSystemItemName("capshelf")).toBe(true);
    expect(isSystemItemName("missing")).toBe(false);
    expect(SYSTEM_ITEMS.map((i) => `${i.kind}/${i.name}`)).toContain(
      "skills/capshelf",
    );
    expect(await shaOfSystemItem(item!)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("parseLockKey", () => {
  test("parses source/kind/name keys", () => {
    expect(parseLockKey("data/skills/hello")).toEqual({
      source: "data",
      kind: "skills",
      name: "hello",
    });
  });

  test("preserves slashful lock names", () => {
    expect(parseLockKey("data/skills/foo/bar")).toEqual({
      source: "data",
      kind: "skills",
      name: "foo/bar",
    });
  });

  test("rejects invalid lock key shapes", () => {
    expect(() => parseLockKey("skills/hello")).toThrow(/invalid lock key/);
    expect(() => parseLockKey("other/skills/hello")).toThrow(
      /invalid lock key source/,
    );
    expect(() => parseLockKey("data/commands/hello")).toThrow(
      /unsupported lock key kind/,
    );
  });
});

describe("master item discovery and hashing", () => {
  test("lists visible item directories and ignores dot entries", async () => {
    const dataRepo = await tempDir("capshelf-master-");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "skills", ".hidden"), { recursive: true });
    await mkdir(join(dataRepo, "skills", ".gitignore"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "base"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "base", "settings.json"),
      "{}\n",
    );
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await writeFile(join(dataRepo, "mcp", "github", "claude.json"), "{}\n");
    await mkdir(join(dataRepo, "mcp", "ignored"), { recursive: true });
    await writeFile(join(dataRepo, "mcp", "ignored", "fragment.json"), "{}\n");
    await mkdir(join(dataRepo, "codex", "config", "defaults"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "codex", "config", "defaults", "config.toml"),
      'model = "gpt-5"\n',
    );

    const items = await listMasterItems(dataRepo);

    expect(items.map((i) => `${i.kind}/${i.name}`).sort()).toEqual([
      "codex-config/defaults",
      "mcp/github",
      "settings/base",
      "skills/hello",
    ]);
  });

  test("findMasterItem resolves unique names and rejects ambiguity", async () => {
    const dataRepo = await tempDir("capshelf-master-");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "skills", "auth"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "auth"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "auth", "settings.json"),
      "{}\n",
    );

    expect((await findMasterItem(dataRepo, "hello"))?.kind).toBe("skills");
    expect(await findMasterItem(dataRepo, "missing")).toBeNull();
    await expect(findMasterItem(dataRepo, "auth")).rejects.toThrow(
      /ambiguous name/,
    );
  });

  test("shaOfItem is stable across directory entry order and includes dotfiles", async () => {
    const first = await tempDir("capshelf-sha-");
    const second = await tempDir("capshelf-sha-");

    await mkdir(join(first, "nested"), { recursive: true });
    await writeFile(join(first, "b.txt"), "b\n");
    await writeFile(join(first, "nested", "a.txt"), "a\n");
    await writeFile(join(first, ".env.1password"), "API_KEY=op://vault/key\n");

    await mkdir(join(second, "nested"), { recursive: true });
    await writeFile(join(second, "nested", "a.txt"), "a\n");
    await writeFile(join(second, ".env.1password"), "different\n");
    await writeFile(join(second, "b.txt"), "b\n");

    expect(await shaOfItem(first)).not.toBe(await shaOfItem(second));
  });

  test("shaOfItem includes .gitignore", async () => {
    const first = await tempDir("capshelf-sha-");
    const second = await tempDir("capshelf-sha-");

    await writeFile(join(first, "SKILL.md"), "same\n");
    await writeFile(join(first, ".gitignore"), "generated/\n");
    await writeFile(join(second, "SKILL.md"), "same\n");
    await writeFile(join(second, ".gitignore"), "other-generated/\n");

    expect(await shaOfItem(first)).not.toBe(await shaOfItem(second));
  });

  test("shaOfItem includes single-file basenames", async () => {
    const root = await tempDir("capshelf-sha-");
    await writeFile(join(root, "one.md"), "same\n");
    await writeFile(join(root, "two.md"), "same\n");

    expect(await shaOfItem(join(root, "one.md"))).not.toBe(
      await shaOfItem(join(root, "two.md")),
    );
  });

  test("assertDataRepoExists returns existing paths and rejects missing paths", async () => {
    const root = await tempDir("capshelf-master-");

    expect(assertDataRepoExists(root)).toBe(root);
    expect(() => assertDataRepoExists(join(root, "missing"))).toThrow(
      /data repo not found/,
    );
  });
});
