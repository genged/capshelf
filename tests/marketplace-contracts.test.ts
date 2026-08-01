import { describe, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeDeterministicZip,
  publishClaudePackage,
} from "../src/plugin-package";
import type { ProjectionFile } from "../src/plugin-projection";
import {
  type CliResult,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

async function seedSkill(repo: string, name: string): Promise<void> {
  const root = join(repo, "skills", name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

async function fixture(): Promise<{
  repo: string;
  run: ReturnType<typeof runInProcess>;
}> {
  const repo = await tempRepo("capshelf-marketplace-contract-", {
    origin: null,
  });
  await seedSkill(repo, "review");
  await seedSkill(repo, "testing");
  await commitAll(repo, "skills");
  return { repo, run: runInProcess(repo) };
}

function json(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

async function init(
  run: ReturnType<typeof runInProcess>,
  repo: string,
  target: "claude" | "codex",
): Promise<CliResult> {
  return run([
    "--data",
    repo,
    "marketplace",
    "init",
    "--target",
    target,
    "--name",
    `${target}-tools`,
    "--owner",
    "Engineering",
    "--json",
  ]);
}

async function create(
  run: ReturnType<typeof runInProcess>,
  repo: string,
  target: "claude" | "codex",
  name: string,
  skill: string,
): Promise<CliResult> {
  return run([
    "--data",
    repo,
    "marketplace",
    "plugin",
    "create",
    name,
    "--target",
    target,
    "--skill",
    skill,
    "--json",
  ]);
}

function zipEntryMetadata(
  archive: Buffer,
): Array<{ path: string; date: number; time: number; mode: number }> {
  const entries = [];
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = archive.indexOf(signature);
  while (offset >= 0 && archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      path: archive.subarray(offset + 46, offset + 46 + nameLength).toString(),
      time: archive.readUInt16LE(offset + 12),
      date: archive.readUInt16LE(offset + 14),
      mode: archive.readUInt32LE(offset + 38) >>> 16,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("marketplace observable contracts", () => {
  test("read commands and mutations expose stable target-specific JSON", async () => {
    const { repo, run } = await fixture();
    for (const target of ["claude", "codex"] as const) {
      const result = await init(run, repo, target);
      expect(result.exitCode).toBe(0);
      expect(json(result)).toMatchObject({
        verb: "marketplace-init",
        action: "updated",
        target,
        dataRepoHasOrigin: false,
      });
    }
    expect(
      (await create(run, repo, "claude", "engineering", "review")).exitCode,
    ).toBe(0);
    expect(
      (await create(run, repo, "codex", "engineering", "testing")).exitCode,
    ).toBe(0);

    const listing = await run(["--data", repo, "marketplace", "ls", "--json"]);
    expect(listing.exitCode).toBe(0);
    const targets = json(listing).targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      target: "claude",
      sourcePath: join(repo, ".claude-plugin/marketplace.json"),
    });
    expect(targets[1]).toMatchObject({
      target: "codex",
      projection: "current",
      sourcePath: join(repo, "codex/plugin-definitions/marketplace.json"),
      nativeMarketplacePath: join(repo, ".agents/plugins/marketplace.json"),
    });

    const shown = await run([
      "--data",
      repo,
      "marketplace",
      "show",
      "engineering",
      "--json",
    ]);
    const matches = json(shown).plugins as Array<Record<string, unknown>>;
    expect(matches.map((entry) => [entry.target, entry.skills])).toEqual([
      ["claude", ["skills/review"]],
      ["codex", ["skills/testing"]],
    ]);

    const added = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "add-skill",
      "engineering",
      "review",
      "--target",
      "codex",
      "--json",
    ]);
    expect(json(added)).toMatchObject({
      verb: "marketplace-plugin-add-skill",
      action: "updated",
      target: "codex",
      plugin: "engineering",
      skillsAdded: ["skills/review"],
      dataRepoHasOrigin: false,
    });
    const noOp = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "add-skill",
      "engineering",
      "review",
      "--target",
      "codex",
      "--json",
    ]);
    expect(json(noOp)).toMatchObject({
      verb: "marketplace-plugin-add-skill",
      action: "unchanged",
      skillsAdded: [],
      committed: false,
    });
    const removed = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "remove-skill",
      "engineering",
      "testing",
      "--target",
      "codex",
      "--json",
    ]);
    expect(json(removed)).toMatchObject({
      verb: "marketplace-plugin-remove-skill",
      skillsRemoved: ["skills/testing"],
    });
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "remove-skill",
          "engineering",
          "review",
          "--target",
          "codex",
        ])
      ).exitCode,
    ).toBe(3);
  });

  test("validation reports configured target details, projection state, and accounting", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "codex")).exitCode).toBe(0);
    expect(
      (await create(run, repo, "codex", "engineering", "review")).exitCode,
    ).toBe(0);
    const result = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "codex",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toMatchObject({
      valid: true,
      target: "codex",
      targets: {
        claude: { configured: false },
        codex: {
          configured: true,
          valid: true,
          projection: "current",
          sourcePath: join(repo, "codex/plugin-definitions/marketplace.json"),
          nativeMarketplacePath: join(repo, ".agents/plugins/marketplace.json"),
        },
      },
    });
    const codex = (
      json(result).targets as Record<string, Record<string, unknown>>
    ).codex!;
    expect(Number(codex.canonicalFiles)).toBeGreaterThan(0);
    expect(Number(codex.canonicalBytes)).toBeGreaterThan(0);
    expect(Number(codex.generatedFiles)).toBeGreaterThan(0);
    expect(Number(codex.generatedBytes)).toBeGreaterThan(0);
    expect(Number(codex.projectionDuplicateBytes)).toBeGreaterThan(0);

    const missingClaude = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--distribution",
      "--cowork-url",
      "https://git.example.test/company/plugins",
      "--json",
    ]);
    expect(missingClaude.exitCode).toBe(4);
    expect(json(missingClaude)).toMatchObject({
      distributionReady: true,
      distributionSupport: "user_asserted",
      targets: { claude: { configured: false, valid: false } },
    });
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "validate",
          "--cowork-url",
          "https://git.example.test/company/plugins",
        ])
      ).exitCode,
    ).toBe(3);

    expect((await init(run, repo, "claude")).exitCode).toBe(0);
    const distribution = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--distribution",
      "--cowork-url",
      "https://git.example.test/company/plugins",
      "--json",
    ]);
    expect(distribution.exitCode).toBe(0);
    expect(json(distribution)).toMatchObject({
      coworkMarketplaceUrl: "https://git.example.test/company/plugins",
      distributionReady: true,
      distributionSupport: "user_asserted",
      targets: {
        claude: {
          configured: true,
          valid: true,
        },
      },
    });
    const claude = (
      json(distribution).targets as Record<string, Record<string, unknown>>
    ).claude!;
    expect(Number(claude.repositoryFiles)).toBeGreaterThan(0);
    expect(Number(claude.repositoryBytes)).toBeGreaterThan(0);
    expect(claude.limits).toEqual({
      maxFiles: 5000,
      maxUncompressedBytes: 200 * 1024 * 1024,
    });
    const distributionWarnings = json(distribution).warnings as Array<
      Record<string, unknown>
    >;
    expect(
      distributionWarnings.find(
        (warning) => warning.code === "distribution_support_user_asserted",
      ),
    ).toMatchObject({
      code: "distribution_support_user_asserted",
      target: "claude",
      url: "https://git.example.test/company/plugins",
    });
    const strictDistribution = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--distribution",
      "--cowork-url",
      "https://git.example.test/company/plugins",
      "--strict",
      "--json",
    ]);
    expect(strictDistribution.exitCode).toBe(4);
    expect(json(strictDistribution)).toMatchObject({
      valid: true,
      strict: true,
      warnings: [
        {
          code: "empty_marketplace",
          target: "claude",
        },
        {
          code: "distribution_support_user_asserted",
          target: "claude",
          url: "https://git.example.test/company/plugins",
        },
      ],
    });

    const claudeOnly = await fixture();
    expect(
      (await init(claudeOnly.run, claudeOnly.repo, "claude")).exitCode,
    ).toBe(0);
    expect(
      (
        await create(
          claudeOnly.run,
          claudeOnly.repo,
          "claude",
          "engineering",
          "review",
        )
      ).exitCode,
    ).toBe(0);
    const claudeOnlyDistribution = await claudeOnly.run([
      "--data",
      claudeOnly.repo,
      "marketplace",
      "validate",
      "--distribution",
      "--cowork-url",
      "https://git.example.test/company/plugins",
      "--json",
    ]);
    expect(claudeOnlyDistribution.exitCode).toBe(0);
    expect(json(claudeOnlyDistribution)).toMatchObject({
      targets: {
        claude: { configured: true, valid: true },
        codex: { configured: false, valid: true },
      },
      errors: [],
    });
    const invalidUrl = await claudeOnly.run([
      "--data",
      claudeOnly.repo,
      "marketplace",
      "validate",
      "--distribution",
      "--cowork-url",
      "not-a-url",
      "--json",
    ]);
    expect(invalidUrl.exitCode).toBe(4);
    expect(json(invalidUrl)).toMatchObject({
      valid: false,
      targets: {
        claude: { configured: true, valid: true },
        codex: { configured: false, valid: true },
      },
      errors: [
        {
          code: "invalid_distribution_url",
          target: "claude",
          message: "--cowork-url must be a valid HTTPS URL",
        },
      ],
    });
  });

  test("overlap warnings are structured and strict validation fails on them", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "claude")).exitCode).toBe(0);
    expect((await create(run, repo, "claude", "zeta", "review")).exitCode).toBe(
      0,
    );
    expect(
      (await create(run, repo, "claude", "alpha", "review")).exitCode,
    ).toBe(0);

    const validation = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "claude",
      "--json",
    ]);
    expect(validation.exitCode).toBe(0);
    const overlaps = (
      json(validation).warnings as Array<Record<string, unknown>>
    ).filter((warning) => warning.code === "skill_in_multiple_plugins");
    expect(overlaps).toEqual([
      {
        code: "skill_in_multiple_plugins",
        target: "claude",
        skill: "skills/review",
        plugins: ["alpha", "zeta"],
        message:
          "skills/review belongs to multiple Claude plugins: zeta, alpha",
      },
    ]);

    const strict = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "claude",
      "--strict",
      "--json",
    ]);
    expect(strict.exitCode).toBe(4);
  });

  test("sync detects missing, changed, extra, and stale projection files without committing", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "codex")).exitCode).toBe(0);
    expect(
      (await create(run, repo, "codex", "engineering", "review")).exitCode,
    ).toBe(0);
    const root = join(repo, "codex/generated/plugins/engineering");
    const copied = join(root, "skills/review/SKILL.md");
    const manifest = join(root, ".codex-plugin/plugin.json");
    const missing = join(repo, "codex/generated/README.md");
    const extra = join(root, "extra.txt");
    await unlink(missing);
    await writeFile(copied, "manually changed");
    await writeFile(manifest, "{}\n");
    await writeFile(extra, "extra");

    const validation = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "codex",
      "--json",
    ]);
    expect(validation.exitCode).toBe(4);
    expect(
      (
        (json(validation).targets as Record<string, Record<string, unknown>>)
          .codex as Record<string, unknown>
      ).projection,
    ).toBe("drifted");

    const beforeHead = (
      await Bun.$`git -C ${repo} rev-parse HEAD`.text()
    ).trim();
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
    expect(json(dryRun)).toMatchObject({
      verb: "marketplace-sync",
      action: "updated",
      projection: "drifted",
      committed: false,
      dryRun: true,
    });
    expect(await readFile(copied, "utf8")).toBe("manually changed");
    expect(await readFile(extra, "utf8")).toBe("extra");

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
    expect(json(synced)).toMatchObject({
      action: "updated",
      projection: "current",
      committed: false,
    });
    expect(await readFile(copied, "utf8")).toContain("name: review");
    expect(await readFile(manifest, "utf8")).toContain("0.0.0+codex.");
    expect(await readFile(missing, "utf8")).toContain("Generated by Capshelf");
    expect(Bun.file(extra).size).toBe(0);
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      beforeHead,
    );
  });

  test("pack distinguishes current and HEAD, is reproducible, and refuses private inputs and overwrite", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "claude")).exitCode).toBe(0);
    expect(
      (await create(run, repo, "claude", "engineering", "review")).exitCode,
    ).toBe(0);
    await writeFile(
      join(repo, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: dirty\n---\n",
    );
    const artifacts = await tempDir("capshelf-marketplace-artifacts-");
    const currentOutput = join(artifacts, "current.plugin");
    const headOutput = join(artifacts, "head.plugin");
    const current = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "pack",
      "engineering",
      "--target",
      "claude",
      "--output",
      currentOutput,
      "--json",
    ]);
    const fromHead = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "pack",
      "engineering",
      "--target",
      "claude",
      "--output",
      headOutput,
      "--from-head",
      "--json",
    ]);
    expect(current.exitCode).toBe(0);
    expect(fromHead.exitCode).toBe(0);
    expect(json(current).contentSha256).not.toBe(json(fromHead).contentSha256);
    const identical = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "pack",
      "engineering",
      "--target",
      "claude",
      "--output",
      currentOutput,
      "--json",
    ]);
    expect(json(identical).action).toBe("already-built");
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
          "claude",
          "--output",
          headOutput,
        ])
      ).exitCode,
    ).toBe(3);

    await writeFile(join(repo, "skills/review/.env"), "SECRET=nope");
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
          "claude",
          "--output",
          join(artifacts, "private.plugin"),
        ])
      ).exitCode,
    ).toBe(3);
  });

  test("dirty dry-run is read-only, real mutation refuses, and successful mutation commits exact roots", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "codex")).exitCode).toBe(0);
    expect(
      (await create(run, repo, "codex", "engineering", "review")).exitCode,
    ).toBe(0);
    const source = join(repo, "codex/plugin-definitions/engineering.json");
    const beforeSource = await readFile(source, "utf8");
    const beforeHead = (
      await Bun.$`git -C ${repo} rev-parse HEAD`.text()
    ).trim();
    await writeFile(join(repo, "unrelated"), "dirty");
    const dryRun = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "add-skill",
      "engineering",
      "testing",
      "--target",
      "codex",
      "--dry-run",
      "--json",
    ]);
    expect(json(dryRun)).toMatchObject({
      action: "planned",
      dryRun: true,
      dirty: true,
      skillsAdded: ["skills/testing"],
    });
    expect(await readFile(source, "utf8")).toBe(beforeSource);
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      beforeHead,
    );
    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "add-skill",
          "engineering",
          "testing",
          "--target",
          "codex",
        ])
      ).exitCode,
    ).toBe(3);
    expect(await readFile(source, "utf8")).toBe(beforeSource);
    await unlink(join(repo, "unrelated"));

    expect(
      (
        await run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "add-skill",
          "engineering",
          "testing",
          "--target",
          "codex",
        ])
      ).exitCode,
    ).toBe(0);
    const committed = (
      await Bun.$`git -C ${repo} show --pretty=format: --name-only HEAD`.text()
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(committed).toEqual([
      "codex/generated/plugins/engineering/.codex-plugin/plugin.json",
      "codex/generated/plugins/engineering/skills/testing/SKILL.md",
      "codex/plugin-definitions/engineering.json",
    ]);
  });

  test("Codex rename and delete atomically replace exact source and generated paths", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "codex")).exitCode).toBe(0);
    expect(
      (await create(run, repo, "codex", "engineering", "review")).exitCode,
    ).toBe(0);
    const renamed = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "rename",
      "engineering",
      "core-engineering",
      "--target",
      "codex",
      "--json",
    ]);
    expect(json(renamed)).toMatchObject({
      verb: "marketplace-plugin-rename",
      oldName: "engineering",
      newName: "core-engineering",
    });
    expect(
      Bun.file(join(repo, "codex/plugin-definitions/engineering.json")).size,
    ).toBe(0);
    expect(
      Bun.file(join(repo, "codex/plugin-definitions/core-engineering.json"))
        .size,
    ).toBeGreaterThan(0);
    expect(
      Bun.file(join(repo, "codex/generated/plugins/engineering")).size,
    ).toBe(0);
    expect(
      Bun.file(join(repo, "codex/generated/plugins/core-engineering")).size,
    ).toBeGreaterThan(0);

    const deleted = await run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "delete",
      "core-engineering",
      "--target",
      "codex",
      "--json",
    ]);
    expect(json(deleted)).toMatchObject({
      verb: "marketplace-plugin-delete",
      action: "updated",
    });
    expect(
      Bun.file(join(repo, "codex/plugin-definitions/core-engineering.json"))
        .size,
    ).toBe(0);
    expect(
      Bun.file(join(repo, "codex/generated/plugins/core-engineering")).size,
    ).toBe(0);
    const catalog = await readFile(
      join(repo, ".agents/plugins/marketplace.json"),
      "utf8",
    );
    expect(catalog).not.toContain("core-engineering");
  });

  test("Claude package enforces the current file-count limit before writing", async () => {
    const repo = await tempRepo("capshelf-marketplace-limit-", {
      origin: null,
    });
    const output = join(
      await tempDir("capshelf-marketplace-limit-output-"),
      "too-large.plugin",
    );
    const files: ProjectionFile[] = Array.from(
      { length: 5001 },
      (_, index) => ({
        path: `skills/large/file-${index}`,
        bytes: Buffer.from("x"),
        executable: false,
      }),
    );
    await expect(publishClaudePackage(repo, output, files)).rejects.toThrow(
      "exceeds Cowork limits",
    );
    expect(Bun.file(output).size).toBe(0);
  });

  test("Claude ZIP entries use fixed timestamps and normalized executable modes", () => {
    const files: ProjectionFile[] = [
      {
        path: ".claude-plugin/plugin.json",
        bytes: Buffer.from("{}\n"),
        executable: false,
      },
      {
        path: "skills/review/check.sh",
        bytes: Buffer.from("#!/bin/sh\n"),
        executable: true,
      },
    ];
    const archive = encodeDeterministicZip(files);
    expect(encodeDeterministicZip(files)).toEqual(archive);
    expect(zipEntryMetadata(archive)).toEqual([
      {
        path: ".claude-plugin/plugin.json",
        time: 0,
        date: 0x21,
        mode: 0o100644,
      },
      {
        path: "skills/review/check.sh",
        time: 0,
        date: 0x21,
        mode: 0o100755,
      },
    ]);
  });

  test("Claude identities follow kebab-case and current reserved-name rules", async () => {
    for (const name of [
      "bad_name",
      "Bad-Name",
      "claude-code-marketplace",
      "claude-plugins-community",
      "anthropic-tools-v2",
      "official-claude-plugins",
      "inline",
    ]) {
      const repo = await tempRepo("capshelf-marketplace-name-", {
        origin: null,
      });
      await seedSkill(repo, "review");
      await commitAll(repo, "baseline");
      expect(
        (
          await runInProcess(repo)([
            "--data",
            repo,
            "marketplace",
            "init",
            "--target",
            "claude",
            "--name",
            name,
            "--owner",
            "Engineering",
          ])
        ).exitCode,
      ).toBe(3);
    }
  });

  test("attempted managed Claude entries with malformed membership are invalid, while external entries remain visible", async () => {
    const { repo, run } = await fixture();
    expect((await init(run, repo, "claude")).exitCode).toBe(0);
    const path = join(repo, ".claude-plugin/marketplace.json");
    const marketplace = JSON.parse(await readFile(path, "utf8")) as {
      plugins: unknown[];
    };
    marketplace.plugins.push(
      {
        name: "broken-managed",
        source: "./",
        strict: false,
        skills: [],
      },
      {
        name: "vendor-tool",
        source: { source: "github", repo: "vendor/tool" },
      },
      {
        name: "versioned-root-tool",
        source: "./",
        strict: false,
        version: "1.0.0",
        skills: [],
      },
    );
    await writeFile(path, `${JSON.stringify(marketplace, null, 2)}\n`);
    const listing = await run([
      "--data",
      repo,
      "marketplace",
      "ls",
      "--target",
      "claude",
      "--json",
    ]);
    const plugins = (
      json(listing).targets as Array<Record<string, unknown>>
    )[0]!.plugins as Array<Record<string, unknown>>;
    expect(
      plugins.find((plugin) => plugin.name === "vendor-tool"),
    ).toMatchObject({ managed: false });
    expect(
      plugins.find((plugin) => plugin.name === "versioned-root-tool"),
    ).toMatchObject({ managed: false });
    const result = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "claude",
      "--json",
    ]);
    expect(result.exitCode).toBe(4);
    expect(json(result)).toMatchObject({
      valid: false,
      targets: { claude: { configured: true, valid: false } },
      errors: [
        {
          code: "target_invalid",
          target: "claude",
        },
      ],
    });
    expect(
      (json(result).errors as Array<Record<string, unknown>>)[0]!
        .message as string,
    ).toContain("non-empty array");

    marketplace.plugins = marketplace.plugins.filter(
      (plugin) => (plugin as { name?: string }).name !== "broken-managed",
    );
    await writeFile(path, `${JSON.stringify(marketplace, null, 2)}\n`);
    const externalOnly = await run([
      "--data",
      repo,
      "marketplace",
      "validate",
      "--target",
      "claude",
      "--json",
    ]);
    expect(externalOnly.exitCode).toBe(0);
    expect(json(externalOnly)).toMatchObject({ valid: true });
    const externalWarnings = (
      json(externalOnly).warnings as Array<Record<string, unknown>>
    ).filter((warning) => warning.code === "external_plugin");
    expect(externalWarnings.map((warning) => warning.plugin)).toEqual([
      "vendor-tool",
      "versioned-root-tool",
    ]);
  });
});
