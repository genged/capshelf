import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeStoredZip, encodeDeterministicZip } from "../src/plugin-package";
import {
  canonicalSkillRef,
  type ProjectionFile,
} from "../src/plugin-projection";
import { commitAll, runIn, tempDir, tempRepo } from "./cli-fixtures";

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

function stdout(result: ReturnType<ReturnType<typeof runIn>>): string {
  return result.stdout.toString();
}

function stderr(result: ReturnType<ReturnType<typeof runIn>>): string {
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
    const run = runIn(repo);

    const claudeInit = run([
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

    const codexInit = run([
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

    const claudeCreate = run([
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
    const invalidDryRun = run([
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

    const codexCreate = run([
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

    const validate = run([
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
    const run = runIn(repo);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(0);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(0);
    const canonical = join(repo, "skills/review/SKILL.md");
    await writeFile(
      canonical,
      "---\nname: review\ndescription: changed\n---\n",
    );
    const before = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
    const sync = run([
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

  test("missing selected skills block validate, sync, pack, and mutations", async () => {
    const repo = await tempRepo("capshelf-marketplace-missing-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runIn(repo);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(0);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(0);
    await Bun.$`git -C ${repo} rm -qr skills/review`;
    await Bun.$`git -C ${repo} commit -qm "remove skill"`;

    const validate = run([
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
      run(["--data", repo, "marketplace", "sync", "--target", "codex"])
        .exitCode,
    ).toBe(3);
    const output = join(await tempDir("capshelf-pack-"), "engineering");
    expect(
      run([
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
      ]).exitCode,
    ).toBe(3);
    const edit = run([
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
    const run = runIn(repo);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(0);
    const before = await readFile(
      join(repo, ".claude-plugin/marketplace.json"),
      "utf8",
    );
    const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
    const hook = join(repo, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const result = run([
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
    const runData = runIn(repo);
    expect(
      runData([
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
      ]).exitCode,
    ).toBe(0);
    expect(
      runData([
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
      ]).exitCode,
    ).toBe(0);

    const project = await tempRepo("capshelf-marketplace-project-", {
      origin: null,
    });
    const runProject = runIn(project);
    expect(runProject(["init", "--data", repo, "--no-upstream"]).exitCode).toBe(
      0,
    );
    expect(runProject(["add", "skills/review"]).exitCode).toBe(0);
    await writeFile(
      join(project, ".agents/skills/review/SKILL.md"),
      "---\nname: review\ndescription: promoted\n---\n",
    );
    expect(
      runProject(["promote", "skills/review", "-m", "promote review"]).exitCode,
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
    const run = runIn(repo);
    expect(
      run([
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
      ]).exitCode,
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
      run([
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
      ]).exitCode,
    ).toBe(0);
    expect(
      run([
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
      ]).exitCode,
    ).toBe(3);
    for (const [oldName, newName] of [
      ["engineering", "core"],
      ["core", "platform"],
    ] as const) {
      expect(
        run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "rename",
          oldName,
          newName,
          "--target",
          "claude",
        ]).exitCode,
      ).toBe(0);
    }
    expect(
      run([
        "--data",
        repo,
        "marketplace",
        "plugin",
        "delete",
        "platform",
        "--target",
        "claude",
      ]).exitCode,
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
