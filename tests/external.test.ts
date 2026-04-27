import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findSkillsShSkill,
  listClaudePlugins,
  listSkillsShSkills,
  readSkillsShLock,
  skillsShConflictMessage,
} from "../src/external";

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
    expect(skillsShConflictMessage({ name: "alpha", source: "acme/alpha" }))
      .toContain("skills.sh remove alpha");
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
});
