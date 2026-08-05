import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeStoredZip, encodeDeterministicZip } from "../src/plugin-package";
import {
  canonicalSkillRef,
  type ProjectionFile,
} from "../src/plugin-projection";
import {
  type CliResult,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

async function seedSkill(
  repo: string,
  name: string,
  body = "Use this skill.",
): Promise<void> {
  const root = join(repo, "skills", name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`,
  );
}

function stdout(result: CliResult): string {
  return result.stdout.toString();
}

function stderr(result: CliResult): string {
  return result.stderr.toString();
}

describe("marketplace projection primitives", () => {
  test("canonicalizes qualified skill refs and refuses traversal", () => {
    expect(canonicalSkillRef("review")).toBe("skills/review");
    expect(canonicalSkillRef("skills/review")).toBe("skills/review");
    expect(() => canonicalSkillRef("settings/review")).toThrow();
    expect(() => canonicalSkillRef("skills/../secret")).toThrow();
    expect(() => canonicalSkillRef("/skills/review")).toThrow();
  });

  test("writes a deterministic root-content ZIP and omits no path wrapper", () => {
    const files: ProjectionFile[] = [
      {
        path: "skills/review/SKILL.md",
        bytes: Buffer.from("review"),
        executable: false,
      },
      {
        path: ".claude-plugin/plugin.json",
        bytes: Buffer.from("{}\n"),
        executable: false,
      },
    ];
    const first = encodeDeterministicZip(files);
    const second = encodeDeterministicZip([...files].reverse());
    expect(first.equals(second)).toBe(true);
    expect(decodeStoredZip(first).map((file) => file.path)).toEqual([
      ".claude-plugin/plugin.json",
      "skills/review/SKILL.md",
    ]);
  });
});

describe("marketplace CLI", () => {
  test("initializes independent catalogs and builds a current Codex projection", async () => {
    const repo = await tempRepo("capshelf-marketplace-", { origin: null });
    await seedSkill(repo, "review");
    await seedSkill(repo, "test");
    await commitAll(repo, "skills");
    const run = runInProcess(repo);

    const claudeInit = await run([
      "--data",
      repo,
      "marketplace",
      "init",
      "--target",
      "claude",
      "--name",
      "company-workflows",
      "--owner",
      "Engineering",
      "--json",
    ]);
    expect(claudeInit.exitCode).toBe(0);

    const codexInit = await run([
      "--data",
      repo,
      "marketplace",
      "init",
      "--target",
      "codex",
      "--name",
      "company-codex",
      "--owner",
      "Engineering",
      "--json",
    ]);
    expect(codexInit.exitCode).toBe(0);

    const claudeCreate = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "create",
      "engineering",
      "--target",
      "claude",
      "--skill",
      "skills/review",
      "--json",
    ]);
    expect(claudeCreate.exitCode).toBe(0);
    const invalidDryRun = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "pack",
      "engineering",
      "--target",
      "claude",
      "--output",
      join(repo, "engineering.plugin"),
      "--dry-run",
    ]);
    expect(invalidDryRun.exitCode).toBe(3);
    expect(existsSync(join(repo, "engineering.plugin"))).toBe(false);

    const codexCreate = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "create",
      "engineering",
      "--target",
      "codex",
      "--skill",
      "skills/test",
      "--json",
    ]);
    expect(codexCreate.exitCode).toBe(0);
    expect(
      await readFile(
        join(repo, "codex/generated/plugins/engineering/skills/test/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: test");
    const manifest = JSON.parse(
      await readFile(
        join(
          repo,
          "codex/generated/plugins/engineering/.codex-plugin/plugin.json",
        ),
        "utf8",
      ),
    ) as { version: string };
    expect(manifest.version).toMatch(/^0\.0\.0\+codex\.[0-9a-f]{12}$/);

    const validate = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "codex",
      "--json",
    ]);
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(stdout(validate)).valid).toBe(true);
    expect((await Bun.$`git -C ${repo} status --porcelain`.text()).trim()).toBe(
      "",
    );
  });

  test("sync repairs dirty projection without staging or committing", async () => {
    const repo = await tempRepo("capshelf-marketplace-sync-", { origin: null });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "codex",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "codex",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);
    const canonical = join(repo, "skills/review/SKILL.md");
    await writeFile(
      canonical,
      "---\nname: review\ndescription: changed\n---\n",
    );
    const before = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
    const sync = await run([
      "--data",
      repo,
      "marketplace",
      "sync",
      "--target",
      "codex",
      "--json",
    ]);
    expect(sync.exitCode).toBe(0);
    expect(JSON.parse(stdout(sync)).committed).toBe(false);
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      before,
    );
    expect(
      (await Bun.$`git -C ${repo} diff --cached --name-only`.text()).trim(),
    ).toBe("");
    expect(
      await readFile(
        join(
          repo,
          "codex/generated/plugins/engineering/skills/review/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("description: changed");
  });

  test("sync reports and refuses dirty projection loss until --yes", async () => {
    const repo = await tempRepo("capshelf-marketplace-sync-consent-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "codex",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "codex",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);
    const projection =
      "codex/generated/plugins/engineering/skills/review/SKILL.md";
    const projectionPath = join(repo, ...projection.split("/"));
    await writeFile(projectionPath, "unique generated edit\n");

    const dryRun = await run([
      "--data",
      repo,
      "marketplace",
      "sync",
      "--target",
      "codex",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(stdout(dryRun));
    expect(report.dirtyProjectionPaths).toEqual([projection]);
    expect(report.destructiveChanges).toEqual([
      expect.objectContaining({
        scope: "data-repo",
        path: projection,
        reason: "dirty_projection",
      }),
    ]);

    const refused = await run([
      "--data",
      repo,
      "marketplace",
      "sync",
      "--target",
      "codex",
      "--json",
    ]);
    expect(refused.exitCode).toBe(3);
    expect(stderr(refused)).toContain(projection);
    expect(await readFile(projectionPath, "utf8")).toBe(
      "unique generated edit\n",
    );

    const accepted = await run([
      "--data",
      repo,
      "marketplace",
      "sync",
      "--target",
      "codex",
      "--yes",
      "--json",
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(await readFile(projectionPath, "utf8")).toContain("name: review");
  });

  test("sync repairs clean committed projection drift without consent", async () => {
    const repo = await tempRepo("capshelf-marketplace-sync-clean-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "codex",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "codex",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);
    const projectionPath = join(
      repo,
      "codex/generated/plugins/engineering/skills/review/SKILL.md",
    );
    await writeFile(projectionPath, "committed stale projection\n");
    await commitAll(repo, "commit stale projection");
    const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();

    const synced = await run([
      "--data",
      repo,
      "marketplace",
      "sync",
      "--target",
      "codex",
      "--json",
    ]);
    expect(synced.exitCode).toBe(0);
    expect(JSON.parse(stdout(synced)).dirtyProjectionPaths).toEqual([]);
    expect(await readFile(projectionPath, "utf8")).toContain("name: review");
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      head,
    );
  });

  test("missing selected skills block validate, sync, pack, and mutations", async () => {
    const repo = await tempRepo("capshelf-marketplace-missing-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "codex",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "codex",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);
    await Bun.$`git -C ${repo} rm -qr skills/review`;
    await Bun.$`git -C ${repo} commit -qm "remove skill"`;

    const validate = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "codex",
      "--json",
    ]);
    expect(validate.exitCode).toBe(4);
    expect(
      (await run(["--data", repo, "marketplace", "sync", "--target", "codex"]))
        .exitCode,
    ).toBe(3);
    const output = join(await tempDir("capshelf-pack-"), "engineering");
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "pack",
          "engineering",
          "--target",
          "codex",
          "--output",
          output,
        ])
      ).exitCode,
    ).toBe(3);
    const edit = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "edit",
      "engineering",
      "--target",
      "codex",
      "--display-name",
      "Changed",
    ]);
    expect(edit.exitCode).toBe(3);
  });

  test("failed Git commit restores source, projection, index, and HEAD", async () => {
    const repo = await tempRepo("capshelf-marketplace-rollback-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "claude",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    const before = await readFile(
      join(repo, ".claude-plugin/marketplace.json"),
      "utf8",
    );
    const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
    const hook = join(repo, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const result = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "create",
      "engineering",
      "--target",
      "claude",
      "--skill",
      "review",
    ]);
    expect(result.exitCode).toBe(1);
    expect(stderr(result)).toContain("commit -m");
    expect(
      await readFile(join(repo, ".claude-plugin/marketplace.json"), "utf8"),
    ).toBe(before);
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      head,
    );
    expect((await Bun.$`git -C ${repo} status --porcelain`.text()).trim()).toBe(
      "",
    );
  });

  test("skill promote commits canonical and selected Codex copies together", async () => {
    const repo = await tempRepo("capshelf-marketplace-promote-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const runData = runInProcess(repo);
    expect(
      (
        await runData([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "codex",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runData([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "codex",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);

    const project = await tempRepo("capshelf-marketplace-project-", {
      origin: null,
    });
    const runProject = runInProcess(project);
    expect(
      (await runProject(["init", "--data", repo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await runProject(["add", "skills/review"])).exitCode).toBe(0);
    await writeFile(
      join(project, ".agents/skills/review/SKILL.md"),
      "---\nname: review\ndescription: promoted\n---\n",
    );
    expect(
      (await runProject(["promote", "skills/review", "-m", "promote review"]))
        .exitCode,
    ).toBe(0);

    expect(
      await readFile(
        join(
          repo,
          "codex/generated/plugins/engineering/skills/review/SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("description: promoted");
    const committedPaths =
      await Bun.$`git -C ${repo} show --pretty=format: --name-only HEAD`.text();
    expect(committedPaths).toContain("skills/review/SKILL.md");
    expect(committedPaths).toContain(
      "codex/generated/plugins/engineering/skills/review/SKILL.md",
    );
    expect(await Bun.$`git -C ${repo} status --porcelain`.text()).toBe("");
  });

  test("preserves external Claude entries and keeps rename retirement history", async () => {
    const repo = await tempRepo("capshelf-marketplace-claude-history-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runInProcess(repo);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "init",
          "--target",
          "claude",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ])
      ).exitCode,
    ).toBe(0);
    const path = join(repo, ".claude-plugin/marketplace.json");
    const marketplace = JSON.parse(await readFile(path, "utf8")) as {
      plugins: unknown[];
    };
    const external = {
      name: "vendor",
      source: { source: "github", repo: "vendor/tool" },
      version: "1.2.3",
      future: { preserved: true },
    };
    marketplace.plugins.push(external);
    await writeFile(path, `${JSON.stringify(marketplace, null, 2)}\n`);
    await commitAll(repo, "external entry");

    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "claude",
          "--skill",
          "review",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "edit",
          "vendor",
          "--target",
          "claude",
          "--description",
          "no",
        ])
      ).exitCode,
    ).toBe(3);
    for (const [oldName, newName] of [
      ["engineering", "core"],
      ["core", "platform"],
    ] as const) {
      expect(
        (
          await run([
            "--data",
            repo,
            "marketplace",
            "plugin",
            "rename",
            oldName,
            newName,
            "--target",
            "claude",
          ])
        ).exitCode,
      ).toBe(0);
    }
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "delete",
          "platform",
          "--target",
          "claude",
        ])
      ).exitCode,
    ).toBe(0);

    const current = JSON.parse(await readFile(path, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
      renames: Record<string, string | null>;
    };
    expect(current.plugins.find((entry) => entry.name === "vendor")).toEqual(
      external,
    );
    expect(current.renames).toEqual({
      engineering: "core",
      core: "platform",
      platform: null,
    });
  });
});
