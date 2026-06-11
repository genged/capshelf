import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codexProjectTrustWarnings,
  runtimeWarningsForItem,
} from "../src/runtime-warnings";

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

describe("codexProjectTrustWarnings", () => {
  async function withCodexEnv<T>(
    opts: { codexOnPath: boolean; codexHome: string },
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const binDir = await tempDir();
    if (opts.codexOnPath) {
      const stub = join(binDir, "codex");
      await writeFile(stub, "#!/bin/sh\nexit 0\n");
      await chmod(stub, 0o755);
    }
    const previousPath = process.env.PATH;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.PATH = binDir;
    process.env.CODEX_HOME = opts.codexHome;
    try {
      return await fn();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }

  const untrustedWarning = (project: string) => [
    {
      type: "codex_project_untrusted" as const,
      path: join(project, ".codex"),
      message: expect.stringContaining("until this project is trusted"),
    },
  ];

  test("does not warn when the codex CLI is not installed", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    // Even with no trust entry at all, an absent codex binary means silence.
    const warnings = await withCodexEnv({ codexOnPath: false, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual([]);
  });

  test("does not warn for a trusted project", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, "config.toml"),
      `[projects."${project}"]\ntrust_level = "trusted"\n`,
    );
    const warnings = await withCodexEnv({ codexOnPath: true, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual([]);
  });

  test("warns when the project trust entry is absent", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, "config.toml"),
      '[projects."/some/other/project"]\ntrust_level = "trusted"\n',
    );
    const warnings = await withCodexEnv({ codexOnPath: true, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual(untrustedWarning(project));
  });

  test("warns when the project entry exists but is not trusted", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, "config.toml"),
      `[projects."${project}"]\ntrust_level = "untrusted"\n`,
    );
    const warnings = await withCodexEnv({ codexOnPath: true, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual(untrustedWarning(project));
  });

  test("warns when the codex config.toml is missing entirely", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    const warnings = await withCodexEnv({ codexOnPath: true, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual(untrustedWarning(project));
  });

  test("treats a malformed config.toml as untrusted instead of throwing", async () => {
    const project = await tempDir();
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, "config.toml"),
      "[projects\nthis is not toml =\n",
    );
    const warnings = await withCodexEnv({ codexOnPath: true, codexHome }, () =>
      codexProjectTrustWarnings(project),
    );
    expect(warnings).toEqual(untrustedWarning(project));
  });
});
