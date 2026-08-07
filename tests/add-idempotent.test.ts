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
      expect(refused.stderr.toString()).toContain("remove config comments");
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
