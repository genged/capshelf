import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  confirmUpdateOverwrite,
  type UpdateConfirmationContext,
} from "../src/commands/update";
import { commitAll, runInProcess, tempRepo } from "./cli-fixtures";

function confirmationContext(answer: string): {
  context: UpdateConfirmationContext;
  prompts: string[];
  stderr: string[];
} {
  const prompts: string[] = [];
  const stderr: string[] = [];
  return {
    context: {
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async (message) => {
        prompts.push(message);
        return answer;
      },
      stderr: {
        write(text) {
          stderr.push(text);
        },
      },
    },
    prompts,
    stderr,
  };
}

describe("update overwrite confirmation", () => {
  test("lists every drifted item and accepts explicit interactive consent", async () => {
    const { context, prompts, stderr } = confirmationContext("yes");

    expect(
      await confirmUpdateOverwrite(
        ["project/data/skills/first", "local/data/skills/second"],
        { json: false },
        context,
      ),
    ).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Update would destroy local state");
    expect(prompts[0]).toContain("project/data/skills/first");
    expect(prompts[0]).toContain("local/data/skills/second");
    expect(prompts[0]).toContain("capshelf status <item> --diff");
    expect(prompts[0]).toContain("Continue? [y/N]");
    expect(stderr).toEqual([]);
  });

  test("declining consent cancels without authorization", async () => {
    const { context, prompts, stderr } = confirmationContext("n");

    expect(
      await confirmUpdateOverwrite(
        ["project/data/skills/hello"],
        { json: false },
        context,
      ),
    ).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(stderr.join("")).toContain(
      "Update cancelled; no changes were written",
    );
  });

  test("guards drifted managed fragment output and preserves it on refusal", async () => {
    const project = await tempRepo("capshelf-update-fragment-project-");
    const dataRepo = await tempRepo("capshelf-update-fragment-data-");
    const run = runInProcess(project);
    const fragment = join(dataRepo, "settings", "security");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/security"])).exitCode).toBe(0);

    const outputPath = join(project, ".claude", "settings.json");
    await writeFile(
      outputPath,
      `${JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } })}\n`,
    );
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security v2");

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const outputBefore = await file(outputPath).text();
    const lockBefore = await file(lockPath).text();
    const refused = await run(["update", "settings/security", "--json"]);

    expect(refused.exitCode).toBe(3);
    expect(await file(outputPath).text()).toBe(outputBefore);
    expect(await file(lockPath).text()).toBe(lockBefore);

    const accepted = await run([
      "update",
      "settings/security",
      "--yes",
      "--json",
    ]);
    expect(accepted.exitCode).toBe(0);
    const output = await file(outputPath).json();
    expect(output.permissions.allow).toEqual(["Bash(git status *)"]);
    expect(output.permissions.deny).toEqual(["Bash(curl *)"]);
  });

  test("guards drifted subagent targets before applying an upstream update", async () => {
    const project = await tempRepo("capshelf-update-subagent-project-");
    const dataRepo = await tempRepo("capshelf-update-subagent-data-");
    const run = runInProcess(project);
    const sourcePath = join(dataRepo, "subagents", "reviewer", "claude.md");
    await mkdir(join(dataRepo, "subagents", "reviewer"), { recursive: true });
    await writeFile(
      sourcePath,
      "---\nname: reviewer\ndescription: Review changes\n---\n\nReview carefully.\n",
    );
    await commitAll(dataRepo, "reviewer v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    const outputPath = join(project, ".claude", "agents", "reviewer.md");
    await writeFile(
      outputPath,
      "---\nname: reviewer\ndescription: Review changes\n---\n\nLocal review rules.\n",
    );
    await writeFile(
      sourcePath,
      "---\nname: reviewer\ndescription: Review changes\n---\n\nReview thoroughly.\n",
    );
    await commitAll(dataRepo, "reviewer v2");

    const outputBefore = await file(outputPath).text();
    const refused = await run(["update", "subagents/reviewer", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(await file(outputPath).text()).toBe(outputBefore);

    const accepted = await run([
      "update",
      "subagents/reviewer",
      "--yes",
      "--json",
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(await file(outputPath).text()).toContain("Review thoroughly");
  });

  test("preserves ignored local-only files without requiring consent", async () => {
    const project = await tempRepo("capshelf-update-ignored-project-");
    const dataRepo = await tempRepo("capshelf-update-ignored-data-");
    const run = runInProcess(project);
    const skill = join(dataRepo, "skills", "cached");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, ".gitignore"), "cache/\n");
    await writeFile(join(skill, "SKILL.md"), "cached v1\n");
    await commitAll(dataRepo, "cached v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/cached"])).exitCode).toBe(0);
    const installed = join(project, ".agents", "skills", "cached");
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(join(installed, "cache", "state.db"), "local state\n");

    await writeFile(join(skill, "SKILL.md"), "cached v2\n");
    await commitAll(dataRepo, "cached v2");
    const updated = await run(["update", "skills/cached", "--json"]);

    expect(updated.exitCode).toBe(0);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("cached v2\n");
    expect(await file(join(installed, "cache", "state.db")).text()).toBe(
      "local state\n",
    );
  });

  test("reports visible extra paths in dry-run and requires consent to remove them", async () => {
    const project = await tempRepo("capshelf-update-extra-project-");
    const dataRepo = await tempRepo("capshelf-update-extra-data-");
    const run = runInProcess(project);
    const skill = join(dataRepo, "skills", "extra");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "extra v1\n");
    await commitAll(dataRepo, "extra v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/extra"])).exitCode).toBe(0);
    const installed = join(project, ".agents", "skills", "extra");
    const localPath = join(installed, "notes.txt");
    await writeFile(localPath, "unique notes\n");
    await writeFile(join(skill, "SKILL.md"), "extra v2\n");
    await commitAll(dataRepo, "extra v2");

    const dryRun = await run(["update", "skills/extra", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{
        scope: string;
        item?: string;
        path: string;
        reason: string;
        reviewCommand?: string;
      }>;
    };
    expect(report.destructiveChanges).toContainEqual({
      scope: "project",
      item: "project/data/skills/extra",
      path: ".agents/skills/extra/notes.txt",
      reason: "extra_local_path",
      reviewCommand: "capshelf status skills/extra --diff",
    });

    const refused = await run(["update", "skills/extra", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(await file(localPath).text()).toBe("unique notes\n");
    expect(
      (await run(["update", "skills/extra", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("extra v2\n");
    expect(await file(localPath).exists()).toBe(false);
  });

  test("reports config comment loss before updating a fragment output", async () => {
    const project = await tempRepo("capshelf-update-comments-project-");
    const dataRepo = await tempRepo("capshelf-update-comments-data-");
    const run = runInProcess(project);
    const fragment = join(dataRepo, "settings", "theme");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ theme: "dark" })}\n`,
    );
    await commitAll(dataRepo, "theme v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/theme"])).exitCode).toBe(0);
    const outputPath = join(project, ".claude", "settings.json");
    const current = await file(outputPath).text();
    await writeFile(outputPath, `// local context\n${current}`);
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ theme: "light" })}\n`,
    );
    await commitAll(dataRepo, "theme v2");

    const dryRun = await run([
      "update",
      "settings/theme",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{
        scope: string;
        item?: string;
        path: string;
        reason: string;
        reviewCommand?: string;
      }>;
    };
    expect(report.destructiveChanges).toContainEqual({
      scope: "project",
      path: ".claude/settings.json",
      reason: "config_comments",
      reviewCommand: "capshelf status settings/theme --diff",
    });
    expect((await run(["update", "settings/theme", "--json"])).exitCode).toBe(
      3,
    );
    expect(await file(outputPath).text()).toContain("// local context");
  });
});
