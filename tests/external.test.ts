import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findClaudePlugin,
  findSkillsShSkill,
  listClaudePlugins,
  listSkillsShSkills,
  listUserSkills,
  readSkillsShLock,
  skillsShConflictMessage,
  withUserSkillShadows,
} from "../src/external";
import type { ExternalUserSkill } from "../src/external";
import type { LockEntry } from "../src/lock";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-external-"));
}

describe("skills.sh lock reader", () => {
  test("returns an empty set when skills-lock.json is absent", async () => {
    const project = await tempDir();

    expect(await listSkillsShSkills(project)).toEqual([]);
    expect(await readSkillsShLock(project)).toEqual(new Set());
  });

  test("lists skills.sh-managed skills by name and source", async () => {
    const project = await tempDir();
    await writeFile(
      join(project, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          beta: { source: "acme/beta", sourceType: "github" },
          alpha: { source: "acme/alpha", sourceType: "github" },
        },
      }),
    );

    expect(await listSkillsShSkills(project)).toEqual([
      { name: "alpha", source: "acme/alpha" },
      { name: "beta", source: "acme/beta" },
    ]);
    expect(await readSkillsShLock(project)).toEqual(new Set(["alpha", "beta"]));
    expect(await findSkillsShSkill(project, "alpha")).toEqual({
      name: "alpha",
      source: "acme/alpha",
    });
    expect(
      skillsShConflictMessage({ name: "alpha", source: "acme/alpha" }),
    ).toContain("skills.sh remove alpha");
  });
});

describe("Claude plugin settings reader", () => {
  test("returns no plugins when scoped settings files are absent", async () => {
    const project = await tempDir();
    const home = await tempDir();

    expect(
      await listClaudePlugins(project, {
        managed: [],
        user: join(home, "settings.json"),
      }),
    ).toEqual([]);
  });

  test("lists enabledPlugins from managed, user, project, and local settings", async () => {
    const project = await tempDir();
    const home = await tempDir();
    const managed = join(home, "managed-settings.json");
    const user = join(home, "settings.json");
    const projectSettings = join(project, ".claude", "settings.json");
    const localSettings = join(project, ".claude", "settings.local.json");
    await mkdir(join(project, ".claude"), { recursive: true });

    await writeFile(
      managed,
      JSON.stringify({
        enabledPlugins: {
          "admin-tools@company": true,
        },
      }),
    );
    await writeFile(
      user,
      JSON.stringify({
        enabledPlugins: {
          "formatter@personal": true,
          "disabled-user@personal": false,
        },
      }),
    );
    await writeFile(
      projectSettings,
      JSON.stringify({
        enabledPlugins: {
          "review@company": true,
        },
      }),
    );
    await writeFile(
      localSettings,
      JSON.stringify({
        enabledPlugins: ["local-helper@dev"],
      }),
    );

    expect(
      await listClaudePlugins(project, {
        managed: [managed],
        user,
        project: projectSettings,
        local: localSettings,
      }),
    ).toEqual([
      {
        id: "admin-tools@company",
        name: "admin-tools",
        marketplace: "company",
        scope: "managed",
        enabled: true,
        settingsPath: managed,
      },
      {
        id: "disabled-user@personal",
        name: "disabled-user",
        marketplace: "personal",
        scope: "user",
        enabled: false,
        settingsPath: user,
      },
      {
        id: "formatter@personal",
        name: "formatter",
        marketplace: "personal",
        scope: "user",
        enabled: true,
        settingsPath: user,
      },
      {
        id: "review@company",
        name: "review",
        marketplace: "company",
        scope: "project",
        enabled: true,
        settingsPath: projectSettings,
      },
      {
        id: "local-helper@dev",
        name: "local-helper",
        marketplace: "dev",
        scope: "local",
        enabled: true,
        settingsPath: localSettings,
      },
    ]);
  });

  test("treats ids without a usable marketplace separator as bare names", async () => {
    const project = await tempDir();
    const home = await tempDir();
    const user = join(home, "settings.json");
    await writeFile(
      user,
      JSON.stringify({
        enabledPlugins: ["plain", "@scoped", "trailing@", "@scope/tool@market"],
      }),
    );

    const plugins = await listClaudePlugins(project, { managed: [], user });
    // Keyed by id so the assertion does not depend on sort order.
    expect(
      Object.fromEntries(
        plugins.map((p) => [
          p.id,
          { name: p.name, marketplace: p.marketplace },
        ]),
      ),
    ).toEqual({
      // No '@' at all: the whole id is the name.
      plain: { name: "plain", marketplace: undefined },
      // Leading '@' is part of the name, not a marketplace separator.
      "@scoped": { name: "@scoped", marketplace: undefined },
      // Trailing '@' would leave an empty marketplace; keep the full id.
      "trailing@": { name: "trailing@", marketplace: undefined },
      // The last '@' splits, even when the name itself starts with '@'.
      "@scope/tool@market": { name: "@scope/tool", marketplace: "market" },
    });
  });

  // findClaudePlugin offers no settings-path injection, so it also scans the
  // real user/managed settings. Unique names keep this isolated in practice.
  test("findClaudePlugin matches by short name or full id", async () => {
    const project = await tempDir();
    const projectSettings = join(project, ".claude", "settings.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      projectSettings,
      JSON.stringify({
        enabledPlugins: { "capshelf-test-finder@capshelf-test-market": true },
      }),
    );

    const byName = await findClaudePlugin(project, "capshelf-test-finder");
    expect(byName).toEqual({
      id: "capshelf-test-finder@capshelf-test-market",
      name: "capshelf-test-finder",
      marketplace: "capshelf-test-market",
      scope: "project",
      enabled: true,
      settingsPath: projectSettings,
    });

    expect(
      await findClaudePlugin(
        project,
        "capshelf-test-finder@capshelf-test-market",
      ),
    ).toEqual(byName);

    expect(
      await findClaudePlugin(project, "capshelf-test-no-such-plugin"),
    ).toBeNull();
  });
});

describe("user skill reader", () => {
  test("lists user-level skills from runtime roots and skips hidden directories", async () => {
    const home = await tempDir();
    const claudeRoot = join(home, ".claude", "skills");
    const codexRoot = join(home, ".agents", "skills");
    const codexHomeRoot = join(home, ".codex", "skills");

    await mkdir(join(claudeRoot, "alpha"), { recursive: true });
    await writeFile(join(claudeRoot, "alpha", "SKILL.md"), "alpha\n");
    await mkdir(join(codexRoot, "beta"), { recursive: true });
    await writeFile(join(codexRoot, "beta", "SKILL.md"), "beta\n");
    await mkdir(join(codexHomeRoot, ".system"), { recursive: true });
    await writeFile(join(codexHomeRoot, ".system", "SKILL.md"), "system\n");
    await mkdir(join(codexHomeRoot, "missing-skill-file"), {
      recursive: true,
    });

    expect(
      await listUserSkills({
        roots: [
          { surface: "claude", path: claudeRoot },
          { surface: "codex", path: codexRoot },
          { surface: "codex", path: codexHomeRoot },
        ],
      }),
    ).toEqual([
      {
        kind: "skills",
        name: "alpha",
        surface: "claude",
        path: join(claudeRoot, "alpha"),
        shadows: [],
      },
      {
        kind: "skills",
        name: "beta",
        surface: "codex",
        path: join(codexRoot, "beta"),
        shadows: [],
      },
    ]);
  });

  test("annotates user skills that shadow capshelf-managed project or local skills", async () => {
    const entry: LockEntry = {
      source: "data",
      sha: "abc",
      sourceCommit: "commit",
      appliedAt: "now",
    };
    const alpha: ExternalUserSkill = {
      kind: "skills",
      name: "alpha",
      surface: "claude",
      path: "/home/u/.claude/skills/alpha",
      shadows: [],
    };
    const beta: ExternalUserSkill = {
      kind: "skills",
      name: "beta",
      surface: "codex",
      path: "/home/u/.agents/skills/beta",
      shadows: [],
    };
    const skills = [
      {
        ...alpha,
      },
      { ...beta },
    ];

    expect(
      withUserSkillShadows(
        skills,
        { version: 2, items: { "data/skills/alpha": entry } },
        { version: 2, items: { "data/skills/beta": entry } },
      ),
    ).toEqual([
      {
        ...alpha,
        shadows: [{ scope: "project", source: "data" }],
      },
      {
        ...beta,
        shadows: [{ scope: "local", source: "data" }],
      },
    ]);
  });
});
