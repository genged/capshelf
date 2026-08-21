import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("apply destructive-change preflight", () => {
  test("reports managed drift, refuses non-interactively, and accepts --yes", async () => {
    const project = await tempRepo("capshelf-apply-consent-project-");
    const dataRepo = await tempRepo("capshelf-apply-consent-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "locked content\n");
    await commitAll(dataRepo, "hello");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    await writeFile(installed, "local edit\n");
    const lockBefore = await file(lockPath).text();

    const dryRun = await run(["apply", "skills/hello", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{
        scope: string;
        item?: string;
        path: string;
        reason: string;
        detail?: string;
        reviewCommand?: string;
      }>;
    };
    expect(dryReport.destructiveChanges).toContainEqual({
      scope: "project",
      item: "project/data/skills/hello",
      path: ".agents/skills/hello/SKILL.md",
      reason: "managed_content",
      detail: "content edit",
      reviewCommand: "capshelf status skills/hello --diff-view installed",
    });
    expect(await file(installed).text()).toBe("local edit\n");

    const refused = await run(["apply", "skills/hello", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      ".agents/skills/hello/SKILL.md",
    );
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(lockPath).text()).toBe(lockBefore);

    expect(
      (await run(["apply", "skills/hello", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(installed).text()).toBe("locked content\n");
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("preflights every target before recreating an earlier missing item", async () => {
    const project = await tempRepo("capshelf-apply-batch-project-");
    const dataRepo = await tempRepo("capshelf-apply-batch-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "first", "first\n");
    await addSkill(dataRepo, "second", "second\n");
    await commitAll(dataRepo, "skills");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/first"])).exitCode).toBe(0);
    expect((await run(["add", "skills/second"])).exitCode).toBe(0);

    const firstRoot = join(project, ".agents", "skills", "first");
    const second = join(project, ".agents", "skills", "second", "SKILL.md");
    await rm(firstRoot, { recursive: true });
    await writeFile(second, "second local edit\n");

    const refused = await run(["apply", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(await file(firstRoot).exists()).toBe(false);
    expect(await file(second).text()).toBe("second local edit\n");
  });

  test("recreates missing managed files while preserving ignored local state", async () => {
    const project = await tempRepo("capshelf-apply-ignored-project-");
    const dataRepo = await tempRepo("capshelf-apply-ignored-data-");
    const run = runInProcess(project);
    const skill = join(dataRepo, "skills", "cached");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, ".gitignore"), "cache/\n");
    await writeFile(join(skill, "SKILL.md"), "managed\n");
    await commitAll(dataRepo, "cached skill");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/cached"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "cached");
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(join(installed, "cache", "state.db"), "local state\n");
    await rm(join(installed, "SKILL.md"));

    const applied = await run(["apply", "skills/cached", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("managed\n");
    expect(await file(join(installed, "cache", "state.db")).text()).toBe(
      "local state\n",
    );
  });

  test(
    "dry-run agrees with apply for item-gitignored managed content",
    async () => {
      const project = await tempRepo("capshelf-apply-hidden-project-");
      const dataRepo = await tempRepo("capshelf-apply-hidden-data-");
      const run = runInProcess(project);
      const skill = join(dataRepo, "skills", "cached");
      await mkdir(join(skill, "cache"), { recursive: true });
      await writeFile(join(skill, ".gitignore"), "cache/\n");
      await writeFile(join(skill, "SKILL.md"), "managed\n");
      // Force-added: the item ignores `cache/`, but the data repo tracks this
      // file, so it is managed content the project's own ignore rules hide.
      await writeFile(join(skill, "cache", "state.db"), "shipped\n");
      await $`git -C ${dataRepo} add -A -f`.quiet();
      await commitAll(dataRepo, "cached skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/cached"])).exitCode).toBe(0);

      // Convergence is decided by byte-comparing every expected and preserved
      // path, not by comparing the Git-visible installed sha to the lock sha —
      // that comparison can never converge for an item of this shape.
      expect(
        (await run(["apply", "skills/cached", "--dry-run"])).stdout.toString(),
      ).toContain("already-current");
      expect(
        (await run(["apply", "skills/cached"])).stdout.toString(),
      ).toContain("already-current");
      expect(
        (await run(["status", "skills/cached"])).stdout.toString(),
      ).toContain("up-to-date");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a project-authored sidecar is neither drift nor managed content",
    async () => {
      const project = await tempRepo("capshelf-apply-sidecar-project-");
      const dataRepo = await tempRepo("capshelf-apply-sidecar-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "locked v1\n");
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "hello");
      // Git-visible (the project commits it) but row 5: excluded from hashing
      // and materialization everywhere, so it must be carried across instead of
      // reported as drift or silently deleted.
      await writeFile(join(installed, ".capshelf.yml"), "tags: [local]\n");
      await writeFile(join(installed, "sub-notes.md"), "extra\n");
      await commitAll(project, "authored sidecar");

      // A non-sidecar Git-visible extra is still row 3 drift.
      const dryRun = await run([
        "apply",
        "skills/hello",
        "--dry-run",
        "--json",
      ]);
      expect(dryRun.exitCode).toBe(0);
      const report = JSON.parse(dryRun.stdout.toString()) as {
        items: Array<{ action: string }>;
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
        item: "project/data/skills/hello",
        path: ".agents/skills/hello/sub-notes.md",
        reason: "extra_local_path",
        detail: "not part of the item — reconciliation removes it",
        reviewCommand: "capshelf status skills/hello --diff-view installed",
      });
      expect(
        report.destructiveChanges.some((change) =>
          change.path.endsWith(".capshelf.yml"),
        ),
      ).toBe(false);

      expect((await run(["apply", "skills/hello", "--yes"])).exitCode).toBe(0);
      expect(await file(join(installed, ".capshelf.yml")).text()).toBe(
        "tags: [local]\n",
      );
      expect(await file(join(installed, "sub-notes.md")).exists()).toBe(false);

      // status, dry-run, and apply now agree, and apply converges.
      expect(
        (await run(["apply", "skills/hello", "--dry-run"])).stdout.toString(),
      ).toContain("already-current");
      expect(
        (await run(["apply", "skills/hello"])).stdout.toString(),
      ).toContain("already-current");
      expect(
        (await run(["status", "skills/hello"])).stdout.toString(),
      ).toContain("up-to-date");

      // It survives an update that changes managed content.
      await writeFile(
        join(dataRepo, "skills", "hello", "SKILL.md"),
        "locked v2\n",
      );
      await commitAll(dataRepo, "hello v2");
      expect((await run(["update", "skills/hello"])).exitCode).toBe(0);
      expect(await file(join(installed, "SKILL.md")).text()).toBe(
        "locked v2\n",
      );
      expect(await file(join(installed, ".capshelf.yml")).text()).toBe(
        "tags: [local]\n",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("reports fragment contribution drift before writing", async () => {
    const project = await tempRepo("capshelf-apply-fragment-project-");
    const dataRepo = await tempRepo("capshelf-apply-fragment-data-");
    const run = runInProcess(project);
    const fragment = join(dataRepo, "settings", "security");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Read(.env)", "Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/security"])).exitCode).toBe(0);
    const output = join(project, ".claude", "settings.json");
    await writeFile(
      output,
      '// local rationale\n{"permissions":{"deny":["Read(.env)"]}}\n',
    );

    const dryRun = await run([
      "apply",
      "settings/security",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{ reason: string }>;
    };
    // Comment loss in a strict-JSON target is repair, not destruction: only
    // the edited managed contribution reaches the consent boundary.
    expect(report.destructiveChanges.map((change) => change.reason)).toEqual([
      "fragment_contribution",
    ]);
    expect((await run(["apply", "settings/security", "--json"])).exitCode).toBe(
      3,
    );
    expect(await file(output).text()).toContain("// local rationale");
  });

  test(
    "gates TOML comment loss in .codex/config.toml",
    async () => {
      const project = await tempRepo("capshelf-apply-toml-project-");
      const dataRepo = await tempRepo("capshelf-apply-toml-data-");
      const run = runInProcess(project);
      const fragment = join(dataRepo, "codex", "config", "defaults");
      await mkdir(fragment, { recursive: true });
      await writeFile(join(fragment, "config.toml"), 'model = "gpt-5"\n');
      await commitAll(dataRepo, "codex defaults");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "codex-config/defaults"])).exitCode).toBe(0);
      const output = join(project, ".codex", "config.toml");
      await writeFile(output, '# why this exists\nmodel = "gpt-4"\n');

      const dryRun = await run([
        "apply",
        "codex-config/defaults",
        "--dry-run",
        "--json",
      ]);
      expect(dryRun.exitCode).toBe(0);
      const report = JSON.parse(dryRun.stdout.toString()) as {
        destructiveChanges: Array<{ reason: string }>;
      };
      expect(
        report.destructiveChanges.map((change) => change.reason),
      ).toContain("config_comments");
      expect(
        (await run(["apply", "codex-config/defaults", "--json"])).exitCode,
      ).toBe(3);
      expect(await file(output).text()).toContain("# why this exists");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "converges healthy items when an unrelated copy item cannot resolve",
    async () => {
      const project = await tempRepo("capshelf-apply-partial-project-");
      const dataRepo = await tempRepo("capshelf-apply-partial-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "good", "locked\n");
      await addSkill(dataRepo, "broken", "locked\n");
      await commitAll(dataRepo, "two skills");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/good"])).exitCode).toBe(0);
      expect((await run(["add", "skills/broken"])).exitCode).toBe(0);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lock = await file(lockPath).json();
      lock.items["data/skills/broken"].sourceCommit = "0".repeat(40);
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const good = join(project, ".agents", "skills", "good", "SKILL.md");
      await writeFile(good, "local edit\n");

      // Independent copy items share no output, so one unreachable pin must not
      // cost the project `apply` — including self-healing of the system item.
      const applied = await run(["apply", "--yes"]);
      expect(applied.exitCode).toBe(1);
      expect(await file(good).text()).toBe("locked\n");
      expect(applied.stdout.toString()).toContain(
        "data/skills/good reconciled",
      );
      expect(applied.stdout.toString()).toContain("data/skills/broken error");
      // A real apply reports outcomes, never a dry-run preview label.
      expect(applied.stdout.toString()).not.toContain("would reconcile");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "writes no fragment output when one fragment target fails preflight",
    async () => {
      const project = await tempRepo("capshelf-apply-fragment-gate-project-");
      const dataRepo = await tempRepo("capshelf-apply-fragment-gate-data-");
      const run = runInProcess(project);
      const fragment = join(dataRepo, "settings", "theme");
      await mkdir(fragment, { recursive: true });
      await writeFile(
        join(fragment, "settings.json"),
        `${JSON.stringify({ theme: "dark" })}\n`,
      );
      await addSkill(dataRepo, "helper", "locked\n");
      await commitAll(dataRepo, "theme and helper");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/theme"])).exitCode).toBe(0);
      expect((await run(["add", "skills/helper"])).exitCode).toBe(0);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lock = await file(lockPath).json();
      lock.items["data/settings/theme"].sourceCommit = "0".repeat(40);
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const helper = join(project, ".agents", "skills", "helper", "SKILL.md");
      await writeFile(helper, "local edit\n");
      const output = join(project, ".claude", "settings.json");
      const outputBefore = await file(output).text();

      const applied = await run(["apply", "--yes"]);
      expect(applied.exitCode).toBe(1);
      expect(await file(output).text()).toBe(outputBefore);
      expect(await file(helper).text()).toBe("local edit\n");
      expect(applied.stdout.toString()).toContain("no changes were written");
      expect(applied.stdout.toString()).not.toContain("would reconcile");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
