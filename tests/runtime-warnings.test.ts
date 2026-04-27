import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeWarningsForItem } from "../src/runtime-warnings";

async function tempDir(prefix = "capshelf-runtime-warnings-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

describe("runtime warnings", () => {
  test("warns when a personal Claude skill shadows a project skill", async () => {
    const project = await tempDir();
    const personal = await tempDir();
    const personalSkill = join(personal, ".claude", "skills", "review");
    await mkdir(personalSkill, { recursive: true });
    await writeFile(join(personalSkill, "SKILL.md"), "personal\n");

    const warnings = runtimeWarningsForItem(project, "skills", "review", {
      personalSkillPath: personalSkill,
    });

    expect(warnings).toEqual([
      {
        type: "shadowed_by_personal_claude_skill",
        path: personalSkill,
        message: expect.stringContaining("before this project skill"),
      },
    ]);
  });

  test("does not warn for non-skills or missing personal skills", async () => {
    const project = await tempDir();
    const personalSkill = join(project, "missing", "review");

    expect(
      runtimeWarningsForItem(project, "settings", "review", {
        personalSkillPath: personalSkill,
      }),
    ).toEqual([]);
    expect(
      runtimeWarningsForItem(project, "skills", "review", {
        personalSkillPath: personalSkill,
      }),
    ).toEqual([]);
  });

  test("does not warn when the personal path is the project skill path", async () => {
    const project = await tempDir();
    const projectSkill = join(project, ".claude", "skills", "review");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, "SKILL.md"), "project\n");

    expect(
      runtimeWarningsForItem(project, "skills", "review", {
        personalSkillPath: projectSkill,
      }),
    ).toEqual([]);
  });

  test("does not warn when the personal path resolves to the project skill", async () => {
    const project = await tempDir();
    const personal = await tempDir();
    const projectSkill = join(project, ".agents", "skills", "review");
    const personalSkill = join(personal, ".claude", "skills", "review");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, "SKILL.md"), "project\n");
    await mkdir(join(personal, ".claude", "skills"), { recursive: true });
    await symlink(projectSkill, personalSkill, "dir");

    expect(existsSync(personalSkill)).toBe(true);
    expect(
      runtimeWarningsForItem(project, "skills", "review", {
        personalSkillPath: personalSkill,
      }),
    ).toEqual([]);
  });
});
