import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

/**
 * Drive the production consent path — the one `apply`, `update`, `rm`, and
 * `revert` actually call — with a scripted TTY, and restore the default
 * afterwards.
 */
async function withTty<T>(
  answer: string,
  body: (recorded: { prompts: string[]; stderr: string[] }) => Promise<T>,
): Promise<T> {
  const recorded = { prompts: [] as string[], stderr: [] as string[] };
  setDestructiveConfirmationContext({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (message: string) => {
      recorded.prompts.push(message);
      return answer;
    },
    stderr: {
      write(text: string) {
        recorded.stderr.push(text);
      },
    },
  });
  try {
    return await body(recorded);
  } finally {
    setDestructiveConfirmationContext(null);
  }
}

describe("interactive destructive-change consent", () => {
  async function driftedProject(prefix: string): Promise<{
    run: ReturnType<typeof runInProcess>;
    installed: string;
    dataRepo: string;
  }> {
    const project = await tempRepo(`${prefix}-project-`);
    const dataRepo = await tempRepo(`${prefix}-data-`);
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "locked v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await writeFile(installed, "local edit\n");
    return { run, installed, dataRepo };
  }

  test(
    "y at the prompt authorizes the write for a real update",
    async () => {
      const { run, installed, dataRepo } = await driftedProject(
        "capshelf-consent-yes",
      );
      await writeFile(
        join(dataRepo, "skills", "hello", "SKILL.md"),
        "locked v2\n",
      );
      await commitAll(dataRepo, "hello v2");

      await withTty("y", async ({ prompts, stderr }) => {
        expect((await run(["update", "skills/hello"])).exitCode).toBe(0);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Update would destroy local state");
        expect(prompts[0]).toContain(".agents/skills/hello/SKILL.md");
        expect(prompts[0]).toContain("capshelf status skills/hello --diff");
        expect(prompts[0]).toContain("Continue? [y/N]");
        expect(stderr).toEqual([]);
      });
      expect(await file(installed).text()).toBe("locked v2\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "N at the prompt cancels a real apply and leaves state byte-identical",
    async () => {
      const { run, installed } = await driftedProject("capshelf-consent-no");

      await withTty("N", async ({ prompts, stderr }) => {
        expect((await run(["apply", "skills/hello"])).exitCode).toBe(0);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("Apply would destroy local state");
        expect(stderr.join("")).toContain(
          "Apply cancelled; no changes were written",
        );
      });
      expect(await file(installed).text()).toBe("local edit\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a non-TTY invocation refuses with the rerun hint instead of prompting",
    async () => {
      const { run, installed } = await driftedProject("capshelf-consent-notty");

      await withTty("y", async ({ prompts }) => {
        setDestructiveConfirmationContext({
          stdinIsTTY: false,
          stderrIsTTY: false,
          prompt: async () => {
            throw new Error("must not prompt without a TTY");
          },
          stderr: { write: () => true },
        });
        const refused = await run(["apply", "skills/hello"]);
        expect(refused.exitCode).toBe(3);
        expect(refused.stderr.toString()).toContain(
          "capshelf apply skills/hello --yes",
        );
        expect(prompts).toEqual([]);
      });
      expect(await file(installed).text()).toBe("local edit\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

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
        detail?: string;
        reviewCommand?: string;
      }>;
    };
    expect(report.destructiveChanges).toContainEqual({
      scope: "project",
      item: "project/data/skills/extra",
      path: ".agents/skills/extra/notes.txt",
      reason: "extra_local_path",
      detail: "not part of the item — reconciliation removes it",
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

  test(
    "gates TOML comment loss but repairs a strict-JSON target",
    async () => {
      const project = await tempRepo("capshelf-update-comments-project-");
      const dataRepo = await tempRepo("capshelf-update-comments-data-");
      const run = runInProcess(project);
      const settings = join(dataRepo, "settings", "theme");
      const codex = join(dataRepo, "codex", "config", "defaults");
      await mkdir(settings, { recursive: true });
      await mkdir(codex, { recursive: true });
      await writeFile(
        join(settings, "settings.json"),
        `${JSON.stringify({ theme: "dark" })}\n`,
      );
      await writeFile(join(codex, "config.toml"), 'model = "gpt-5"\n');
      await commitAll(dataRepo, "fragments v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/theme"])).exitCode).toBe(0);
      expect((await run(["add", "codex-config/defaults"])).exitCode).toBe(0);
      const settingsOutput = join(project, ".claude", "settings.json");
      const codexOutput = join(project, ".codex", "config.toml");
      await writeFile(
        settingsOutput,
        `// local context\n${await file(settingsOutput).text()}`,
      );
      await writeFile(
        codexOutput,
        `# local rationale\n${await file(codexOutput).text()}`,
      );
      await writeFile(
        join(settings, "settings.json"),
        `${JSON.stringify({ theme: "light" })}\n`,
      );
      await writeFile(join(codex, "config.toml"), 'model = "gpt-5-codex"\n');
      await commitAll(dataRepo, "fragments v2");

      const dryRun = await run(["update", "--dry-run", "--json"]);
      expect(dryRun.exitCode).toBe(0);
      const report = JSON.parse(dryRun.stdout.toString()) as {
        destructiveChanges: Array<{
          scope: string;
          item?: string;
          path: string;
          reason: string;
          detail?: string;
          reviewCommand?: string;
        }>;
      };
      // `#` is standard TOML and Codex reads it, so this is real loss.
      expect(report.destructiveChanges).toContainEqual({
        scope: "project",
        path: ".codex/config.toml",
        reason: "config_comments",
        reviewCommand: "capshelf status codex-config/defaults --diff",
      });
      // Claude Code will not load a settings.json with comments, so removing
      // them repairs the file rather than destroying anything.
      expect(
        report.destructiveChanges.filter(
          (change) =>
            change.path === ".claude/settings.json" &&
            change.reason === "config_comments",
        ),
      ).toEqual([]);

      const refused = await run(["update", "--json"]);
      expect(refused.exitCode).toBe(3);
      expect(await file(codexOutput).text()).toContain("# local rationale");
      expect(await file(settingsOutput).text()).toContain("// local context");

      const accepted = await run(["update", "--yes"]);
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stderr.toString()).toContain("comments removed");
      expect(await file(settingsOutput).json()).toMatchObject({
        theme: "light",
      });
      expect(await file(codexOutput).text()).toContain('model = "gpt-5-codex"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
