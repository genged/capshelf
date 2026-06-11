import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  emptyManifest,
  loadManifest,
  ManifestSchema,
  saveManifest,
} from "../src/manifest";
import {
  loadLocalConfig,
  ensureGitignored,
  localConfigPath,
  saveLocalConfig,
} from "../src/local-config";
import {
  claudeDir,
  claudeHomeDir,
  codexDir,
  DEFAULT_INSTALL_MODE,
  detectInstallMode,
  expandTilde,
  homeRelative,
  installBaseDir,
  lockPath,
  manifestPath,
  normalizePath,
  personalClaudeSkillPath,
  projectRoot,
  resolveDataRepo,
  resolveDataRepoOptional,
} from "../src/paths";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-paths-"));
}

describe("path normalization", () => {
  test("expands and compacts home-relative paths", () => {
    const home = homedir();
    expect(expandTilde("~")).toBe(home);
    expect(expandTilde("~/capshelf")).toBe(join(home, "capshelf"));
    expect(homeRelative(join(home, "capshelf"))).toBe("~/capshelf");
  });

  test("normalizes relative paths against an explicit base", () => {
    expect(normalizePath("../data", "/tmp/project/sub")).toBe(
      "/tmp/project/data",
    );
  });

  test("resolves relative local config dataRepo from the project root", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      localConfigPath(project),
      JSON.stringify({ dataRepo: "../data" }),
    );
    expect(
      await resolveDataRepo({
        manifest: emptyManifest(),
        project,
      }),
    ).toBe(normalizePath("../data", project));
  });

  test("uses data repo precedence override > local config > CAPSHELF_HOME", async () => {
    const oldCapshelfHome = process.env.CAPSHELF_HOME;
    const project = await tempDir();
    await saveLocalConfig(project, {
      dataRepo: "../local",
      skills: [],
      settings: [],
      mcp: [],
    });
    process.env.CAPSHELF_HOME = "/tmp/from-capshelf-env";
    try {
      expect(
        await resolveDataRepo({
          override: "../override",
          manifest: emptyManifest(),
          project,
        }),
      ).toBe(normalizePath("../override"));

      expect(
        await resolveDataRepo({
          manifest: emptyManifest(),
          project,
        }),
      ).toBe(normalizePath("../local", project));

      expect(await resolveDataRepo({ manifest: null })).toBe(
        "/tmp/from-capshelf-env",
      );
    } finally {
      if (oldCapshelfHome === undefined) delete process.env.CAPSHELF_HOME;
      else process.env.CAPSHELF_HOME = oldCapshelfHome;
    }
  });

  test("throws or returns null when no data repo is configured", async () => {
    const oldCapshelfHome = process.env.CAPSHELF_HOME;
    delete process.env.CAPSHELF_HOME;
    try {
      await expect(resolveDataRepo({ manifest: null })).rejects.toThrow(
        /no data repo configured/,
      );
      expect(await resolveDataRepoOptional({ manifest: null })).toBeNull();
    } finally {
      if (oldCapshelfHome === undefined) delete process.env.CAPSHELF_HOME;
      else process.env.CAPSHELF_HOME = oldCapshelfHome;
    }
  });

  test("projectRoot accepts only the current capshelf project root", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify(emptyManifest()),
    );

    expect(projectRoot(project)).toBe(project);
  });

  test("projectRoot rejects subdirectories of a capshelf project", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify(emptyManifest()),
    );
    const nested = join(project, "nested");
    await mkdir(nested, { recursive: true });

    expect(() => projectRoot(nested)).toThrow(/not a capshelf project root/);
  });

  test("projectRoot rejects the capshelf metadata directory itself", async () => {
    const project = await tempDir();
    const metadata = join(project, ".capshelf");
    await mkdir(metadata, { recursive: true });
    await writeFile(
      join(metadata, "capshelf.json"),
      JSON.stringify(emptyManifest()),
    );

    expect(() => projectRoot(metadata)).toThrow(/not a capshelf project root/);
  });

  test("projectRoot rejects git repos without capshelf metadata", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".git"), { recursive: true });

    expect(() => projectRoot(project)).toThrow(/not a capshelf project root/);
  });

  test("projectRoot rejects uninitialized directories", async () => {
    const dir = await tempDir();
    expect(() => projectRoot(dir)).toThrow(/not a capshelf project root/);
  });

  test("resolves root metadata and install mode directories", async () => {
    const project = await tempDir();

    expect(claudeDir(project)).toBe(join(project, ".claude"));
    expect(claudeHomeDir()).toBe(join(homedir(), ".claude"));
    expect(personalClaudeSkillPath("hello")).toBe(
      join(homedir(), ".claude", "skills", "hello"),
    );
    expect(codexDir(project)).toBe(join(project, ".agents"));
    expect(manifestPath(project)).toBe(
      join(project, ".capshelf", "capshelf.json"),
    );
    expect(lockPath(project)).toBe(
      join(project, ".capshelf", "capshelf.lock.json"),
    );
    expect(detectInstallMode(project)).toBe(DEFAULT_INSTALL_MODE);
    expect(installBaseDir(project)).toBe(join(project, ".agents"));
    expect(installBaseDir(project, "claude-only")).toBe(
      join(project, ".claude"),
    );

    await saveManifest(project, {
      installMode: "claude-only",
      skills: [],
      settings: [],
      mcp: [],
      codexConfig: [],
    });
    expect(detectInstallMode(project)).toBe("claude-only");
  });
});

describe("manifest commands migration", () => {
  test("emptyManifest returns the current no-commands shape", () => {
    expect(emptyManifest()).toEqual({
      installMode: "codex-compatible",
      skills: [],
      settings: [],
      mcp: [],
      codexConfig: [],
    });
  });

  test("loadManifest returns empty when no file exists", async () => {
    const project = await tempDir();
    expect(await loadManifest(project)).toEqual(emptyManifest());
  });

  test("local config loads null when absent and expands tilde", async () => {
    const project = await tempDir();
    expect(await loadLocalConfig(project)).toBeNull();

    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      localConfigPath(project),
      JSON.stringify({ dataRepo: "~/capshelf-data" }),
    );
    expect(await loadLocalConfig(project)).toEqual({
      dataRepo: join(homedir(), "capshelf-data"),
      skills: [],
      settings: [],
      mcp: [],
    });
  });

  test("saveLocalConfig writes file and metadata gitignore entry once", async () => {
    const project = await tempDir();
    await saveLocalConfig(project, {
      dataRepo: "/tmp/data",
      skills: [],
      settings: [],
      mcp: [],
    });
    await saveLocalConfig(project, {
      dataRepo: "/tmp/data",
      skills: [],
      settings: [],
      mcp: [],
    });

    expect(await loadLocalConfig(project)).toEqual({
      dataRepo: "/tmp/data",
      skills: [],
      settings: [],
      mcp: [],
    });
    const gitignore = await readFile(
      join(project, ".capshelf", ".gitignore"),
      "utf-8",
    );
    expect(gitignore.match(/^local\.json$/gm)?.length).toBe(1);
    expect(gitignore.match(/^local\.lock\.json$/gm)?.length).toBe(1);
  });

  test("ensureGitignored appends entries without rewriting existing lines", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(join(project, ".capshelf", ".gitignore"), "# local state");

    await ensureGitignored(project, "local.json");

    expect(
      await readFile(join(project, ".capshelf", ".gitignore"), "utf-8"),
    ).toBe("# local state\nlocal.json\n");
  });

  test("drops empty legacy commands arrays on parse and save", async () => {
    const parsed = ManifestSchema.parse({
      skills: [],
      commands: [],
      settings: [],
      mcp: [],
      codexConfig: [],
    });

    expect("commands" in parsed).toBe(false);

    const project = await tempDir();
    await saveManifest(project, parsed);

    const raw = await readFile(manifestPath(project), "utf-8");
    expect(raw).not.toContain('"commands"');
    expect(await loadManifest(project)).toEqual({
      ...parsed,
      installMode: "codex-compatible",
    });
    expect(existsSync(manifestPath(project))).toBe(true);
  });

  test("rejects non-empty legacy commands arrays", () => {
    expect(() =>
      ManifestSchema.parse({
        skills: [],
        commands: ["deploy"],
        settings: [],
        mcp: [],
        codexConfig: [],
      }),
    ).toThrow(/commands are no longer managed/);
  });

  test("loadManifest parses existing files", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      manifestPath(project),
      JSON.stringify({
        installMode: "claude-only",
        dataRepoUpstream: "https://github.com/mg/agent-shared",
        skills: ["hello"],
        settings: [],
        mcp: [],
        codexConfig: [],
      }),
    );

    expect(await loadManifest(project)).toEqual({
      installMode: "claude-only",
      dataRepoUpstream: "https://github.com/mg/agent-shared",
      skills: ["hello"],
      settings: [],
      mcp: [],
      codexConfig: [],
    });
  });

  // "shelves" is reserved for multi-shelf federation; see
  // local/specs/multi-shelf-federation-spec.md (Group 2b).
  test("loadManifest fails loudly on a reserved shelves key", async () => {
    for (const shelves of [[], null, "team"]) {
      const project = await tempDir();
      await mkdir(join(project, ".capshelf"), { recursive: true });
      const raw = JSON.stringify({
        shelves,
        skills: [],
        settings: [],
        mcp: [],
        codexConfig: [],
      });
      await writeFile(manifestPath(project), raw);

      await expect(loadManifest(project)).rejects.toThrow(
        /multi-shelf federation, which this capshelf version does not support; upgrade capshelf/,
      );
      // The error names the manifest path and is distinct from the legacy
      // dataRepo message.
      const err = await loadManifest(project).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(manifestPath(project));
      expect(err?.message).not.toMatch(/legacy dataRepo/);
      // Nothing was written: the file is byte-identical.
      expect(await readFile(manifestPath(project), "utf-8")).toBe(raw);
    }
  });

  test("loadLocalConfig fails loudly on a reserved shelves key", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    const raw = JSON.stringify({ dataRepo: "/tmp/data", shelves: [] });
    await writeFile(localConfigPath(project), raw);

    await expect(loadLocalConfig(project)).rejects.toThrow(
      /multi-shelf federation, which this capshelf version does not support; upgrade capshelf/,
    );
    await expect(loadLocalConfig(project)).rejects.toThrow(
      localConfigPath(project),
    );
    expect(await readFile(localConfigPath(project), "utf-8")).toBe(raw);
  });

  test("manifests and local configs without shelves round-trip unchanged", async () => {
    const project = await tempDir();
    const manifest = emptyManifest();
    manifest.skills.push("hello");
    await saveManifest(project, manifest);
    expect(await loadManifest(project)).toEqual(manifest);

    await saveLocalConfig(project, {
      dataRepo: "/tmp/data",
      skills: ["hello"],
      settings: [],
      mcp: [],
    });
    expect(await loadLocalConfig(project)).toEqual({
      dataRepo: "/tmp/data",
      skills: ["hello"],
      settings: [],
      mcp: [],
    });
  });

  test("loadManifest rejects legacy dataRepo with manual fix guidance", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      manifestPath(project),
      JSON.stringify({
        dataRepo: "/tmp/data",
        skills: [],
        settings: [],
        mcp: [],
        codexConfig: [],
      }),
    );

    await expect(loadManifest(project)).rejects.toThrow(/fix it manually/);
  });

  test("ManifestSchema rejects unsupported dataRepoUpstream values", () => {
    expect(() =>
      ManifestSchema.parse({
        dataRepoUpstream: "not a remote",
        skills: [],
        settings: [],
        mcp: [],
        codexConfig: [],
      }),
    ).toThrow(/dataRepoUpstream/);
  });

  test("ManifestSchema rejects legacy dataRepo on direct parse", () => {
    expect(() =>
      ManifestSchema.parse({
        dataRepo: "/tmp/data",
        skills: [],
        settings: [],
        mcp: [],
        codexConfig: [],
      }),
    ).toThrow();
  });
});
