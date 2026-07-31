import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCodexProjection,
  loadCodexState,
  type CodexState,
} from "../src/codex-marketplace";
import { loadClaudeMarketplace } from "../src/claude-marketplace";
import { commitDataRepoMutation } from "../src/marketplace-files";
import {
  publishClaudePackage,
  publishCodexPackage,
} from "../src/plugin-package";
import {
  collectSelectedSkill,
  logicalContentHash,
} from "../src/plugin-projection";
import { commitAll, runIn, tempDir, tempRepo } from "./cli-fixtures";

async function seedSkill(repo: string, name: string): Promise<void> {
  const root = join(repo, "skills", name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

function stdout(result: ReturnType<ReturnType<typeof runIn>>): string {
  return result.stdout.toString();
}

describe("marketplace hardening", () => {
  test("canonical hashes ignore recursive JSON key order", () => {
    const first = logicalContentHash({ z: 1, nested: { b: 2, a: 1 } }, []);
    const second = logicalContentHash({ nested: { a: 1, b: 2 }, z: 1 }, []);
    const changed = logicalContentHash({ nested: { a: 1, b: 3 }, z: 1 }, []);
    expect(first).toBe(second);
    expect(changed).not.toBe(first);
  });

  test("Codex versions use tracked Git modes and untracked working modes", async () => {
    const repo = await tempRepo("capshelf-marketplace-modes-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    const tracked = join(repo, "skills/review/tracked.sh");
    const untracked = join(repo, "skills/review/untracked.sh");
    await writeFile(tracked, "#!/bin/sh\n");
    await chmod(tracked, 0o755);
    await commitAll(repo, "skill");
    await writeFile(untracked, "#!/bin/sh\n");
    await chmod(untracked, 0o644);
    const state: CodexState = {
      marketplace: {
        name: "company-tools",
        owner: { name: "Engineering" },
      },
      definitions: [
        {
          name: "engineering",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          skills: ["skills/review"],
        },
      ],
    };
    const cacheVersion = async (): Promise<string> => {
      const files = await buildCodexProjection(repo, state);
      const manifest = files.find((file) =>
        file.path.endsWith("/.codex-plugin/plugin.json"),
      );
      return (JSON.parse(manifest!.bytes.toString()) as { version: string })
        .version;
    };

    const initial = await cacheVersion();
    await chmod(tracked, 0o644);
    expect(await cacheVersion()).toBe(initial);
    let selected = await collectSelectedSkill(repo, "review");
    expect(
      selected.files.find((file) => file.path === "tracked.sh")?.executable,
    ).toBe(true);
    expect(
      selected.files.find((file) => file.path === "untracked.sh")?.executable,
    ).toBe(false);

    await Bun.$`git -C ${repo} update-index --chmod=-x skills/review/tracked.sh`;
    const indexModeChanged = await cacheVersion();
    expect(indexModeChanged).not.toBe(initial);
    selected = await collectSelectedSkill(repo, "review");
    expect(
      selected.files.find((file) => file.path === "tracked.sh")?.executable,
    ).toBe(false);

    await chmod(untracked, 0o755);
    expect(await cacheVersion()).not.toBe(indexModeChanged);
    selected = await collectSelectedSkill(repo, "review");
    expect(
      selected.files.find((file) => file.path === "untracked.sh")?.executable,
    ).toBe(true);
  });

  test("refuses symlink ancestors for source and projection roots without touching external bytes", async () => {
    for (const [target, relRoot] of [
      ["claude", ".claude-plugin"],
      ["codex", "codex"],
      ["codex", ".agents"],
    ] as const) {
      const repo = await tempRepo(`capshelf-marketplace-${target}-link-`, {
        origin: null,
      });
      const external = await tempDir("capshelf-marketplace-external-");
      const sentinel = join(external, "sentinel");
      await writeFile(sentinel, `${target}:${relRoot}`);
      await symlink(external, join(repo, relRoot));
      const result = runIn(repo)([
        "--data",
        repo,
        "marketplace",
        "init",
        "--target",
        target,
        "--name",
        "company-tools",
        "--owner",
        "Engineering",
      ]);
      expect(result.exitCode).toBe(3);
      expect(await readFile(sentinel, "utf8")).toBe(`${target}:${relRoot}`);
    }
  });

  test("refuses a selected skill through a symlinked parent", async () => {
    const repo = await tempRepo("capshelf-marketplace-skill-link-", {
      origin: null,
    });
    const external = await tempDir("capshelf-marketplace-skill-external-");
    await mkdir(join(external, "review"), { recursive: true });
    const sentinel = join(external, "sentinel");
    await writeFile(sentinel, "keep");
    await writeFile(
      join(external, "review/SKILL.md"),
      "---\nname: review\ndescription: review\n---\n",
    );
    await symlink(external, join(repo, "skills"));
    await expect(collectSelectedSkill(repo, "review")).rejects.toThrow(
      "symlink component",
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("Codex init refuses a pre-existing definition root without changing its bytes or HEAD", async () => {
    const repo = await tempRepo("capshelf-marketplace-init-collision-", {
      origin: null,
    });
    const sentinel = join(repo, "codex/plugin-definitions/notes.txt");
    await mkdir(join(repo, "codex/plugin-definitions"), { recursive: true });
    await writeFile(sentinel, "keep");
    await commitAll(repo, "existing definitions");
    const beforeHead = (
      await Bun.$`git -C ${repo} rev-parse HEAD`.text()
    ).trim();

    const result = runIn(repo)([
      "--data",
      repo,
      "marketplace",
      "init",
      "--target",
      "codex",
      "--name",
      "company-tools",
      "--owner",
      "Engineering",
    ]);

    expect(result.exitCode).toBe(3);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect((await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(
      beforeHead,
    );
    expect((await Bun.$`git -C ${repo} status --porcelain`.text()).trim()).toBe(
      "",
    );
  });

  test("loaders propagate I/O shape errors and reject non-regular Codex definitions", async () => {
    const claudeRepo = await tempRepo("capshelf-marketplace-loader-claude-", {
      origin: null,
    });
    await mkdir(join(claudeRepo, ".claude-plugin/marketplace.json"), {
      recursive: true,
    });
    await expect(loadClaudeMarketplace(claudeRepo)).rejects.toThrow();

    const codexRepo = await tempRepo("capshelf-marketplace-loader-codex-", {
      origin: null,
    });
    await mkdir(join(codexRepo, "codex/plugin-definitions/marketplace.json"), {
      recursive: true,
    });
    await expect(loadCodexState(codexRepo)).rejects.toThrow();

    const repo = await tempRepo("capshelf-marketplace-definition-link-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "baseline");
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
        "company-tools",
        "--owner",
        "Engineering",
      ]).exitCode,
    ).toBe(0);
    const external = await tempDir("capshelf-marketplace-definition-external-");
    const sentinel = join(external, "definition.json");
    await writeFile(sentinel, "{}");
    await symlink(sentinel, join(repo, "codex/plugin-definitions/linked.json"));
    await expect(loadCodexState(repo)).rejects.toThrow(
      "expected a regular .json file",
    );
    expect(await readFile(sentinel, "utf8")).toBe("{}");
  });

  test("refuses lexical outside package output that resolves into the data repo", async () => {
    const repo = await tempRepo("capshelf-marketplace-output-link-", {
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
        "company-tools",
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
        "claude",
        "--skill",
        "review",
      ]).exitCode,
    ).toBe(0);
    const outside = await tempDir("capshelf-marketplace-output-parent-");
    const link = join(outside, "repo-link");
    await symlink(repo, link);
    const sentinel = join(repo, "protected.plugin");
    await writeFile(sentinel, "keep");
    const result = run([
      "--data",
      repo,
      "marketplace",
      "plugin",
      "pack",
      "engineering",
      "--target",
      "claude",
      "--output",
      join(link, "protected.plugin"),
    ]);
    expect(result.exitCode).toBe(3);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("package primitives refuse traversal paths without changing outside sentinels", async () => {
    const repo = await tempRepo("capshelf-marketplace-projection-traversal-", {
      origin: null,
    });
    const outputParent = await tempDir(
      "capshelf-marketplace-projection-output-",
    );
    const sentinel = join(outputParent, "sentinel");
    await writeFile(sentinel, "keep");
    for (const [index, malicious] of [
      [
        {
          path: "../sentinel",
          bytes: Buffer.from("overwrite"),
          executable: false,
        },
      ],
      [
        {
          path: "C:/sentinel",
          bytes: Buffer.from("overwrite"),
          executable: false,
        },
      ],
      [
        {
          path: "C:sentinel",
          bytes: Buffer.from("overwrite"),
          executable: false,
        },
      ],
      [
        { path: "tree", bytes: Buffer.from("file"), executable: false },
        {
          path: "tree/child",
          bytes: Buffer.from("child"),
          executable: false,
        },
      ],
    ].entries()) {
      await expect(
        publishClaudePackage(
          repo,
          join(outputParent, `bad-${index}.plugin`),
          malicious,
        ),
      ).rejects.toThrow(/unsafe generated projection path|path collision/);
      await expect(
        publishCodexPackage(
          repo,
          join(outputParent, `bad-codex-${index}`),
          malicious,
        ),
      ).rejects.toThrow(/unsafe generated projection path|path collision/);
    }
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("preserves an unrelated concurrent HEAD instead of rolling it back", async () => {
    const repo = await tempRepo("capshelf-marketplace-concurrent-", {
      origin: null,
    });
    await mkdir(join(repo, "owned"), { recursive: true });
    await writeFile(join(repo, "owned/value"), "before");
    await commitAll(repo, "baseline");
    const expectedHead = (
      await Bun.$`git -C ${repo} rev-parse HEAD`.text()
    ).trim();

    await expect(
      commitDataRepoMutation({
        dataRepo: repo,
        expectedHead,
        ownedRoots: ["owned"],
        message: "our mutation",
        mutate: async () => {
          await writeFile(join(repo, "owned/value"), "ours");
          await writeFile(join(repo, "concurrent"), "theirs");
          await Bun.$`git -C ${repo} add concurrent`;
          await Bun.$`git -C ${repo} commit -qm "concurrent user commit"`;
        },
      }),
    ).rejects.toThrow("HEAD changed");

    const currentHead = (
      await Bun.$`git -C ${repo} rev-parse HEAD`.text()
    ).trim();
    expect(currentHead).not.toBe(expectedHead);
    expect(await Bun.$`git -C ${repo} show HEAD:concurrent`.text()).toBe(
      "theirs",
    );
    expect(await readFile(join(repo, "concurrent"), "utf8")).toBe("theirs");
    expect(await readFile(join(repo, "owned/value"), "utf8")).toBe("before");
    expect((await Bun.$`git -C ${repo} status --porcelain`.text()).trim()).toBe(
      "",
    );
  });

  test("requires skills and accepts only current Codex policy values", async () => {
    const repo = await tempRepo("capshelf-marketplace-policy-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const run = runIn(repo);
    for (const target of ["claude", "codex"]) {
      expect(
        run([
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
        ]).exitCode,
      ).toBe(0);
      expect(
        run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          `empty-${target}`,
          "--target",
          target,
        ]).exitCode,
      ).toBe(3);
    }

    for (const policy of [
      "NOT_AVAILABLE",
      "AVAILABLE",
      "INSTALLED_BY_DEFAULT",
    ]) {
      const result = run([
        "--data",
        repo,
        "marketplace",
        "plugin",
        "create",
        `plugin-${policy.toLowerCase().replaceAll("_", "-")}`,
        "--target",
        "codex",
        "--skill",
        "review",
        "--installation",
        policy,
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout(result)).action).toBe("updated");
    }
    for (const policy of ["RECOMMENDED", "REQUIRED"]) {
      expect(
        run([
          "--data",
          repo,
          "marketplace",
          "plugin",
          "create",
          `invalid-${policy.toLowerCase()}`,
          "--target",
          "codex",
          "--skill",
          "review",
          "--installation",
          policy,
        ]).exitCode,
      ).toBe(3);
    }
  });

  test("rejects target-inapplicable options", async () => {
    const cases = [
      ["claude", "--display-name", "Ignored"],
      ["codex", "--description", "Ignored"],
    ] as const;
    for (const [target, option, value] of cases) {
      const repo = await tempRepo(`capshelf-marketplace-option-${target}-`, {
        origin: null,
      });
      const result = runIn(repo)([
        "--data",
        repo,
        "marketplace",
        "init",
        "--target",
        target,
        "--name",
        "company-tools",
        "--owner",
        "Engineering",
        option,
        value,
      ]);
      expect(result.exitCode).toBe(3);
      expect(
        (await Bun.$`git -C ${repo} status --porcelain`.text()).trim(),
      ).toBe("");
    }

    const repo = await tempRepo("capshelf-marketplace-empty-option-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "baseline");
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
        "company-tools",
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
        "engineering",
        "--target",
        "claude",
        "--category",
        "",
      ]).exitCode,
    ).toBe(3);
  });

  test("effective metadata and content rotate Codex versions while unrelated commits do not", async () => {
    const repo = await tempRepo("capshelf-marketplace-version-", {
      origin: null,
    });
    await seedSkill(repo, "review");
    await commitAll(repo, "skill");
    const state: CodexState = {
      marketplace: {
        name: "company-tools",
        owner: { name: "Engineering" },
      },
      definitions: [
        {
          name: "engineering",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          skills: ["skills/review"],
        },
      ],
    };
    const version = async (current: CodexState): Promise<string> => {
      const files = await buildCodexProjection(repo, current);
      const manifest = files.find((file) =>
        file.path.endsWith("/.codex-plugin/plugin.json"),
      );
      return (JSON.parse(manifest!.bytes.toString()) as { version: string })
        .version;
    };
    const first = await version(state);
    await writeFile(join(repo, "unrelated"), "unrelated");
    await commitAll(repo, "unrelated");
    expect(await version(state)).toBe(first);
    state.definitions[0]!.description = "Changed metadata";
    const metadataChanged = await version(state);
    expect(metadataChanged).not.toBe(first);
    await writeFile(join(repo, "skills/review/SKILL.md"), "changed");
    expect(await version(state)).not.toBe(metadataChanged);
  });
});
