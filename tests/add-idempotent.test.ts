import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("standalone add convergence", () => {
  test("already-installed add is byte- and lock-stable even with drift and newer upstream", async () => {
    const project = await tempRepo("capshelf-add-idempotent-project-");
    const dataRepo = await tempRepo("capshelf-add-idempotent-data-");
    const run = runInProcess(project);
    const skill = await addSkill(dataRepo, "hello", "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const originalLock = await file(lockPath).text();
    await writeFile(installed, "local edit\n");
    await writeFile(join(skill, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");
    await writeFile(join(skill, "SKILL.md"), "dirty v3\n");
    const manifestBefore = await file(manifestPath).text();
    const lockBefore = await file(lockPath).text();

    const addedAgain = await run(["add", "skills/hello", "--json"]);
    expect(addedAgain.exitCode).toBe(0);
    const report = JSON.parse(addedAgain.stdout.toString());
    expect(report.action).toBe("already-installed");
    expect(report.wasAlreadyInstalled).toBe(true);
    expect(report.guidance.join("\n")).toContain(
      "capshelf status skills/hello --diff",
    );
    expect(report.guidance.join("\n")).toContain(
      "capshelf update skills/hello",
    );
    expect(report.guidance.join("\n")).toContain(
      "capshelf revert skills/hello",
    );
    expect(report.guidance.join("\n")).toContain(
      "capshelf promote skills/hello",
    );
    expect(report.guidance.join("\n")).toContain(
      "capshelf keep-local skills/hello",
    );
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(manifestPath).text()).toBe(manifestBefore);
    expect(await file(lockPath).text()).toBe(lockBefore);
    expect(await file(lockPath).text()).toBe(originalLock);
  });

  test(
    "new codex-config add requires consent before removing TOML comments",
    async () => {
      const project = await tempRepo("capshelf-add-toml-project-");
      const dataRepo = await tempRepo("capshelf-add-toml-data-");
      const run = runInProcess(project);
      const base = join(dataRepo, "codex", "config", "base");
      const extra = join(dataRepo, "codex", "config", "extra");
      await mkdir(base, { recursive: true });
      await mkdir(extra, { recursive: true });
      await writeFile(join(base, "config.toml"), 'model = "gpt-5"\n');
      await writeFile(join(extra, "config.toml"), 'approval = "never"\n');
      await commitAll(dataRepo, "codex fragments");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "codex-config/base"])).exitCode).toBe(0);
      const output = join(project, ".codex", "config.toml");
      const current = await file(output).text();
      await writeFile(output, `# local rationale\n${current}`);
      const manifestPath = join(project, ".capshelf", "capshelf.json");
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const before = await Promise.all([
        file(output).text(),
        file(manifestPath).text(),
        file(lockPath).text(),
      ]);

      // `#` is standard TOML and Codex reads these comments, so losing them is
      // real destruction the user has to authorize.
      const refused = await run(["add", "codex-config/extra", "--json"]);
      expect(refused.exitCode).toBe(3);
      const refusedStderr = refused.stderr.toString();
      expect(refusedStderr).toContain("remove config comments");
      // A comment does not change parsed values, so the tracked contribution
      // still reads "ok" and `status --diff` would print no diff for it. The
      // prompt must not name a review command that shows nothing.
      expect(refusedStderr).not.toContain("capshelf status --diff");
      expect(refusedStderr).toContain(
        "Review the affected paths before continuing.",
      );
      expect(
        await Promise.all([
          file(output).text(),
          file(manifestPath).text(),
          file(lockPath).text(),
        ]),
      ).toEqual(before);

      const accepted = await run([
        "add",
        "codex-config/extra",
        "--yes",
        "--json",
      ]);
      expect(accepted.exitCode).toBe(0);
      expect(await file(output).text()).toContain('approval = "never"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "first fragment add onto an unmanaged commented config names no status command",
    async () => {
      const project = await tempRepo("capshelf-add-toml-first-project-");
      const dataRepo = await tempRepo("capshelf-add-toml-first-data-");
      const run = runInProcess(project);
      const base = join(dataRepo, "codex", "config", "base");
      await mkdir(base, { recursive: true });
      await writeFile(join(base, "config.toml"), 'model = "gpt-5"\n');
      await commitAll(dataRepo, "codex fragment");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      await mkdir(join(project, ".codex"), { recursive: true });
      const output = join(project, ".codex", "config.toml");
      await writeFile(output, '# local rationale\nsandbox = "strict"\n');

      // Nothing contributes to this target yet, so `status` has no row that
      // could show the loss; the prompt falls back to naming the path.
      const refused = await run(["add", "codex-config/base", "--json"]);
      expect(refused.exitCode).toBe(3);
      const stderr = refused.stderr.toString();
      expect(stderr).toContain("remove config comments");
      expect(stderr).not.toContain("capshelf status --diff");
      expect(stderr).toContain("Review the affected paths before continuing.");

      const accepted = await run(["add", "codex-config/base", "--yes"]);
      expect(accepted.exitCode).toBe(0);
      const merged = await file(output).text();
      expect(merged).toContain('model = "gpt-5"');
      expect(merged).toContain('sandbox = "strict"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "add onto a drifted managed contribution keeps the status review command",
    async () => {
      const project = await tempRepo("capshelf-add-toml-drift-project-");
      const dataRepo = await tempRepo("capshelf-add-toml-drift-data-");
      const run = runInProcess(project);
      const base = join(dataRepo, "codex", "config", "base");
      const extra = join(dataRepo, "codex", "config", "extra");
      await mkdir(base, { recursive: true });
      await mkdir(extra, { recursive: true });
      await writeFile(join(base, "config.toml"), 'model = "gpt-5"\n');
      await writeFile(join(extra, "config.toml"), 'approval = "never"\n');
      await commitAll(dataRepo, "codex fragments");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "codex-config/base"])).exitCode).toBe(0);
      const output = join(project, ".codex", "config.toml");
      // Drop the managed key: the tracked contribution now reads "drifted",
      // which is the one state that gives `status --diff` a diff to print.
      await writeFile(output, 'retain = "local"\n');

      const refused = await run(["add", "codex-config/extra", "--json"]);
      expect(refused.exitCode).toBe(3);
      const stderr = refused.stderr.toString();
      expect(stderr).toContain("replace a managed config contribution");
      expect(stderr).toContain("capshelf status --diff");

      // The named command shows the loss the prompt asks about.
      const status = await run(["status", "--diff"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toContain('-model = "gpt-5"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "comments in a strict-JSON target are repaired, not gated",
    async () => {
      const project = await tempRepo("capshelf-add-fragment-project-");
      const dataRepo = await tempRepo("capshelf-add-fragment-data-");
      const run = runInProcess(project);
      const base = join(dataRepo, "settings", "base");
      const extra = join(dataRepo, "settings", "extra");
      await mkdir(base, { recursive: true });
      await mkdir(extra, { recursive: true });
      await writeFile(
        join(base, "settings.json"),
        `${JSON.stringify({ env: { BASE: "1" } })}\n`,
      );
      await writeFile(
        join(extra, "settings.json"),
        `${JSON.stringify({ env: { EXTRA: "1" } })}\n`,
      );
      await commitAll(dataRepo, "settings fragments");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/base"])).exitCode).toBe(0);
      const output = join(project, ".claude", "settings.json");
      const current = await file(output).text();
      await writeFile(output, `// local context\n${current}`);

      // Claude Code will not load a settings.json containing comments, so the
      // rewrite is what repairs the file. Gating on it would be asking the user
      // to authorize keeping a config the tool silently ignores.
      const added = await run(["add", "settings/extra"]);
      expect(added.exitCode).toBe(0);
      expect(added.stderr.toString()).toContain("comments removed");
      expect(added.stderr.toString()).toContain("repairs that");
      const merged = await file(output).json();
      expect(merged.env).toEqual({ BASE: "1", EXTRA: "1" });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
