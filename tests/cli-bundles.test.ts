import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("cli integration", () => {
  async function bundleDataRepo(): Promise<string> {
    const dataRepo = await tempRepo("capshelf-bundle-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nbody\n",
    );
    await commitAll(dataRepo, "first item");

    await mkdir(join(dataRepo, "skills", "go-test-writer"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "go-test-writer", "SKILL.md"),
      "write go tests\n",
    );
    await mkdir(join(dataRepo, "skills", "quick-review"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "quick-review", "SKILL.md"),
      "quick review\n",
    );
    await writeFile(
      join(dataRepo, "skills", "quick-review", ".capshelf.yml"),
      "conflicts-with: [skills/security-review]\n",
    );
    for (const [name, env] of [
      ["permissions-base", "BASE"],
      ["permissions-go", "GO"],
    ] as const) {
      await mkdir(join(dataRepo, "settings", name), { recursive: true });
      await writeFile(
        join(dataRepo, "settings", name, "settings.json"),
        JSON.stringify({ env: { [env]: "1" } }),
      );
    }
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "github", "claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "github-mcp" } } }),
    );
    await mkdir(join(dataRepo, "pi", "extensions", "path-guard"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "pi", "extensions", "path-guard", "index.ts"),
      "export default function pathGuard() {}\n",
    );
    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(
      join(dataRepo, "bundles", "go-backend.yml"),
      [
        "description: Everything a Go backend service needs.",
        "tags: [go, backend]",
        "includes:",
        "  skills:   [security-review, go-test-writer]",
        "  settings: [permissions-base, permissions-go]",
        "  mcp:      [github]",
        "",
      ].join("\n"),
    );
    await commitAll(dataRepo, "rest of the shelf");
    return dataRepo;
  }

  async function capshelfState(project: string): Promise<string> {
    const reads = await Promise.all(
      [
        join(project, ".capshelf", "capshelf.json"),
        join(project, ".capshelf", "capshelf.lock.json"),
        join(project, ".capshelf", "local.lock.json"),
        join(project, ".claude", "settings.json"),
        join(project, ".mcp.json"),
      ].map((path) => readFile(path, "utf-8").catch(() => "(absent)")),
    );
    return reads.join("\n---\n");
  }

  test("add bundles/<x> expands members traceless and converges on re-run", async () => {
    const project = await tempRepo("capshelf-bundle-add-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const add = await run(["add", "bundles/go-backend"]);
    expect(add.exitCode).toBe(0);
    const out = add.stdout.toString();
    expect(out).toContain("✓ bundle go-backend → 5 added, 0 already installed");
    expect(out).toMatch(/\+ skills\/security-review\s+@ [0-9a-f]{12}/);
    expect(out).toMatch(/\+ mcp\/github\s+@ [0-9a-f]{12}/);

    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    const memberKeys = [
      "data/skills/security-review",
      "data/skills/go-test-writer",
      "data/settings/permissions-base",
      "data/settings/permissions-go",
      "data/mcp/github",
    ];
    for (const key of memberKeys) {
      expect(lock.items[key]?.source).toBe("data");
    }
    expect(
      new Set(memberKeys.map((k) => lock.items[k].sourcePinDigest)).size,
    ).toBe(5);
    expect(
      new Set(memberKeys.map((k) => lock.items[k].sourceCommit)).size,
    ).toBe(2);
    expect(JSON.stringify(lock)).not.toContain("go-backend");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["security-review", "go-test-writer"]);
    expect(manifest.settings).toEqual(["permissions-base", "permissions-go"]);
    expect(JSON.stringify(manifest)).not.toContain("go-backend");
    const settings = await file(
      join(project, ".claude", "settings.json"),
    ).json();
    expect(settings.env).toEqual({ BASE: "1", GO: "1" });
    expect((await run(["status", "--strict"])).exitCode).toBe(0);

    const before = await readFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      "utf-8",
    );
    const rerun = await run(["add", "bundles/go-backend"]);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout.toString()).toContain(
      "✓ bundle go-backend → 0 added, 5 already installed",
    );
    expect(rerun.stdout.toString()).toMatch(
      /= skills\/security-review\s+already installed/,
    );
    expect(
      await readFile(join(project, ".capshelf", "capshelf.lock.json"), "utf-8"),
    ).toBe(before);

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const single = await run(["add", "skills/security-review"]);
    expect(single.exitCode).toBe(0);
    expect(single.stdout.toString()).toContain("already installed");
    expect(
      await readFile(join(project, ".capshelf", "capshelf.lock.json"), "utf-8"),
    ).toBe(before);

    await mkdir(join(dataRepo, "skills", "extra"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "extra", "SKILL.md"), "extra\n");
    await commitAll(dataRepo, "extra skill");
    await writeFile(
      join(dataRepo, "bundles", "go-backend.yml"),
      [
        "includes:",
        "  skills:   [security-review, go-test-writer, extra]",
        "  settings: [permissions-base, permissions-go]",
        "  mcp:      [github]",
        "",
      ].join("\n"),
    );
    // The bundle file is not pinned, so it may stay uncommitted.
    const grown = await run(["add", "bundles/go-backend", "--json"]);
    expect(grown.exitCode).toBe(0);
    const report = JSON.parse(grown.stdout.toString());
    expect(report.bundle).toBe("go-backend");
    expect(report.applied).toBe(true);
    expect(report.added).toBe(1);
    expect(report.alreadyInstalled).toBe(5);
    const extra = report.members.find(
      (m: { ref: string }) => m.ref === "skills/extra",
    );
    expect(extra.status).toBe("added");
    expect(extra.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(extra.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(extra.dst).toBe(".agents/skills/extra");
    expect(
      report.members.filter(
        (m: { status: string }) => m.status === "already-installed",
      ),
    ).toHaveLength(5);
    expect(report.runtimeWarnings).toEqual([]);
    expect(report.missingRequires).toEqual([]);
  });

  test("bundle preflight refusals are all-or-nothing with exit 3", async () => {
    const project = await tempRepo("capshelf-bundle-refuse-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/security-review"])).exitCode).toBe(0);

    await writeFile(
      join(dataRepo, "bundles", "broken-set.yml"),
      [
        "includes:",
        "  skills: [quick-review, go-test-writer]",
        "  mcp:    [postgres-local]",
        "",
      ].join("\n"),
    );

    const before = await capshelfState(project);
    const refused = await run(["add", "bundles/broken-set"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toContain(
      "✗ not installing bundle broken-set — 2 of 3 members failed preflight",
    );
    expect(out).toMatch(
      /✗ skills\/quick-review\s+conflicts with installed skills\/security-review/,
    );
    expect(out).toContain("declared by: skills/quick-review/.capshelf.yml");
    expect(out).toMatch(/✗ mcp\/postgres-local\s+not found in data repo/);
    expect(out).toContain("no changes were made (1 member was ready)");
    expect(out).toContain("re-run: capshelf add bundles/broken-set");
    expect(await capshelfState(project)).toBe(before);

    const json = await run(["add", "bundles/broken-set", "--json"]);
    expect(json.exitCode).toBe(3);
    const report = JSON.parse(json.stdout.toString());
    expect(report.applied).toBe(false);
    expect(report.added).toBe(0);
    const statuses = Object.fromEntries(
      report.members.map((m: { ref: string; status: string }) => [
        m.ref,
        m.status,
      ]),
    );
    expect(statuses).toEqual({
      "skills/quick-review": "refused",
      "skills/go-test-writer": "blocked",
      "mcp/postgres-local": "missing",
    });
    expect(
      report.members.find(
        (m: { ref: string }) => m.ref === "skills/quick-review",
      ).reason,
    ).toContain("conflicts with installed skills/security-review");
    expect(await capshelfState(project)).toBe(before);
  });

  test("bundle preflight catches unmanaged fragment collisions without writes", async () => {
    const project = await tempRepo("capshelf-bundle-collision-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ env: { GO: "local-value" } }, null, 2),
    );

    const before = await capshelfState(project);
    const refused = await run(["add", "bundles/go-backend"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toMatch(/✗ settings\/permissions-go\s+cannot reconcile/);
    expect(out).toContain("unmanaged local value");
    expect(await capshelfState(project)).toBe(before);
  });

  test(
    "bundle expansion reaches the destructive-consent boundary",
    async () => {
      const project = await tempRepo("capshelf-bundle-consent-project-");
      const dataRepo = await bundleDataRepo();
      const run = runInProcess(project);
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      // Strict, comment-free JSON ensures the refusal cannot be attributed to
      // JSONC handling.
      expect((await run(["add", "settings/permissions-base"])).exitCode).toBe(
        0,
      );
      const output = join(project, ".claude", "settings.json");
      await writeFile(
        output,
        `${JSON.stringify({ env: { BASE: "EDITED" } })}\n`,
      );

      const before = await capshelfState(project);
      const refused = await run(["add", "bundles/go-backend"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        "replace a managed config contribution",
      );
      expect(refused.stderr.toString()).toContain(
        "capshelf add bundles/go-backend --yes",
      );
      expect(await capshelfState(project)).toBe(before);
      expect((await file(output).json()).env.BASE).toBe("EDITED");

      const accepted = await run(["add", "bundles/go-backend", "--yes"]);
      expect(accepted.exitCode).toBe(0);
      expect((await file(output).json()).env.BASE).toBe("1");
      expect((await file(output).json()).env.GO).toBe("1");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "bundle comment loss in .codex/config.toml requires consent",
    async () => {
      const project = await tempRepo("capshelf-bundle-toml-project-");
      const dataRepo = await tempRepo("capshelf-bundle-toml-data-");
      const run = runInProcess(project);
      await mkdir(join(dataRepo, "codex", "config", "defaults"), {
        recursive: true,
      });
      await writeFile(
        join(dataRepo, "codex", "config", "defaults", "config.toml"),
        'model = "gpt-5"\n',
      );
      await mkdir(join(dataRepo, "bundles"), { recursive: true });
      await writeFile(
        join(dataRepo, "bundles", "codex.yml"),
        "includes:\n  codex-config: [defaults]\n",
      );
      await commitAll(dataRepo, "codex defaults");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      const output = join(project, ".codex", "config.toml");
      await mkdir(join(project, ".codex"), { recursive: true });
      await writeFile(output, '# why this exists\napproval = "never"\n');

      const refused = await run(["add", "bundles/codex"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain("remove config comments");
      expect(await file(output).text()).toContain("# why this exists");

      expect((await run(["add", "bundles/codex", "--yes"])).exitCode).toBe(0);
      expect(await file(output).text()).toContain('model = "gpt-5"');
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a bundle with no fragment members installs without a prompt",
    async () => {
      const project = await tempRepo("capshelf-bundle-nofrag-project-");
      const dataRepo = await bundleDataRepo();
      const run = runInProcess(project);
      await writeFile(
        join(dataRepo, "bundles", "skills-only.yml"),
        "includes:\n  skills: [security-review]\n",
      );
      await commitAll(dataRepo, "skills-only bundle");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

      const added = await run(["add", "bundles/skills-only"]);
      expect(added.exitCode).toBe(0);
      expect(added.stdout.toString()).toContain("1 added");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("add bundles --local accepts copy items and aggregates fragments", async () => {
    const project = await tempRepo("capshelf-bundle-local-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const refused = await run(["add", "bundles/go-backend", "--local"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toContain(
      "✗ not installing bundle go-backend --local — local scope supports copy-directory items only",
    );
    expect(out).toContain(
      "fragment members: settings/permissions-base, settings/permissions-go, mcp/github",
    );
    expect(out).toContain(
      "install the bundle at project scope instead: capshelf add bundles/go-backend",
    );

    await writeFile(
      join(dataRepo, "bundles", "copy-items.yml"),
      [
        "includes:",
        "  skills: [security-review, go-test-writer]",
        "  pi-extensions: [path-guard]",
        "",
      ].join("\n"),
    );
    const local = await run(["add", "bundles/copy-items", "--local"]);
    expect(local.exitCode).toBe(0);
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/security-review"]?.source).toBe("data");
    expect(localLock.items["data/skills/go-test-writer"]?.source).toBe("data");
    expect(localLock.items["data/pi-extensions/path-guard"]?.source).toBe(
      "data",
    );
    expect(
      await file(
        join(project, ".pi", "extensions", "path-guard", "index.ts"),
      ).exists(),
    ).toBe(true);
    expect(
      await readFile(join(project, ".git", "info", "exclude"), "utf-8"),
    ).toContain(".pi/extensions/path-guard/");
  });

  test("mixed --local refusal prints one headline counting every failure", async () => {
    const project = await tempRepo("capshelf-bundle-mixed-local-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    await writeFile(
      join(dataRepo, "bundles", "mixed-local.yml"),
      [
        "includes:",
        "  skills:   [security-review, nope]",
        "  settings: [permissions-base]",
        "",
      ].join("\n"),
    );

    const refused = await run(["add", "bundles/mixed-local", "--local"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toContain(
      "✗ not installing bundle mixed-local — 2 of 3 members failed preflight",
    );
    expect(out).not.toContain("not installing bundle mixed-local --local");
    expect(out).toContain("✗ local scope supports copy-directory items only");
    expect(out).toContain("fragment members: settings/permissions-base");
    expect(out).toMatch(/✗ skills\/nope\s+not found in data repo/);
  });

  test("missing, empty, and malformed bundles on the install path", async () => {
    const project = await tempRepo("capshelf-bundle-errors-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const missing = await run(["add", "bundles/nope"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain("bundle not found");

    await writeFile(join(dataRepo, "bundles", "empty.yml"), "includes:\n");
    const empty = await run(["add", "bundles/empty"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout.toString()).toContain(
      "✓ bundle empty → nothing to install (bundle has no members)",
    );

    await writeFile(join(dataRepo, "bundles", "bad.yml"), "[broken\n");
    const malformed = await run(["add", "bundles/bad"]);
    expect(malformed.exitCode).toBe(3);
    expect(malformed.stderr.toString()).toContain("invalid YAML");

    await writeFile(
      join(dataRepo, "bundles", "newer.yml"),
      "includes:\n  skills: [security-review]\n  agents: [b]\n",
    );
    const unknownKind = await run(["add", "bundles/newer"]);
    expect(unknownKind.exitCode).toBe(3);
    expect(unknownKind.stderr.toString()).toContain(
      "upgrade capshelf or edit the bundle",
    );
  });

  test("show bundles/<x> previews membership and install state", async () => {
    const project = await tempRepo("capshelf-bundle-show-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/permissions-base"])).exitCode).toBe(0);
    await writeFile(
      join(dataRepo, "bundles", "go-backend.yml"),
      [
        "description: Everything a Go backend service needs.",
        "tags: [go, backend]",
        "includes:",
        "  skills:   [security-review]",
        "  settings: [permissions-base]",
        "  mcp:      [postgres-local]",
        "",
      ].join("\n"),
    );

    const human = await run(["show", "bundles/go-backend"]);
    expect(human.exitCode).toBe(0);
    const out = human.stdout.toString();
    expect(out).toContain("bundles/go-backend");
    expect(out).toContain(
      "description: Everything a Go backend service needs.",
    );
    expect(out).toContain("tags:        go, backend");
    expect(out).toMatch(/skills\/security-review\s+not installed/);
    expect(out).toMatch(
      /settings\/permissions-base\s+installed \(project\) @ [0-9a-f]{12}/,
    );
    expect(out).toMatch(/mcp\/postgres-local\s+MISSING from data repo/);
    expect(out).toContain("install:     capshelf add bundles/go-backend");

    const json = await run(["show", "bundles/go-backend", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    expect(parsed.bundle).toBe("go-backend");
    expect(parsed.path).toBe(join(dataRepo, "bundles", "go-backend.yml"));
    expect(parsed.tags).toEqual(["go", "backend"]);
    expect(parsed.members).toEqual([
      { ref: "skills/security-review", available: true, installed: false },
      {
        ref: "settings/permissions-base",
        available: true,
        installed: true,
        scope: "project",
        lockedSha: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      { ref: "mcp/postgres-local", available: false, installed: false },
    ]);

    expect((await run(["show", "bundles/nope"])).exitCode).toBe(2);
    const target = await run([
      "show",
      "bundles/go-backend",
      "--target",
      "claude",
    ]);
    expect(target.exitCode).toBe(3);
    const noContent = await run(["show", "bundles/go-backend", "--no-content"]);
    expect(noContent.exitCode).toBe(3);
  });

  test("ls surfaces bundles append-only and never in --here", async () => {
    const project = await tempRepo("capshelf-bundle-ls-project-");
    const dataRepo = await tempRepo("capshelf-bundle-ls-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "audit\n",
    );
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const before = JSON.parse((await run(["ls", "--json"])).stdout.toString());
    expect(before.bundles).toBeUndefined();

    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(
      join(dataRepo, "bundles", "go-backend.yml"),
      [
        "description: Everything a Go backend service needs.",
        "tags: [go, backend]",
        "includes:",
        "  skills: [security-review]",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dataRepo, "bundles", "frontend.yml"),
      "includes:\n  skills: [security-review]\n",
    );
    await writeFile(join(dataRepo, "bundles", "bad.yml"), "[broken\n");
    await writeFile(
      join(dataRepo, "bundles", "legacy.yaml"),
      "includes:\n  skills: [security-review]\n",
    );

    const ls = await run(["ls"]);
    expect(ls.exitCode).toBe(0);
    const out = ls.stdout.toString();
    expect(out).toContain("bundles/  (from");
    expect(out).toMatch(
      /go-backend\s+1 skills\s+Everything a Go backend service needs\.\s+#go #backend/,
    );
    expect(out).toMatch(/frontend\s+1 skills/);
    expect(out).toMatch(/^ {2}bad$/m);
    expect(ls.stderr.toString()).toContain("bundles/bad: invalid YAML");
    expect(ls.stderr.toString()).toContain(
      "bundles/legacy.yaml ignored — rename to legacy.yml",
    );

    const after = JSON.parse((await run(["ls", "--json"])).stdout.toString());
    expect(after.system).toEqual(before.system);
    expect(after.data).toEqual(before.data);
    expect(after.bundles.map((b: { name: string }) => b.name)).toEqual([
      "bad",
      "frontend",
      "go-backend",
    ]);
    const goBackend = after.bundles.find(
      (b: { name: string }) => b.name === "go-backend",
    );
    expect(goBackend).toEqual({
      name: "go-backend",
      path: join(dataRepo, "bundles", "go-backend.yml"),
      description: "Everything a Go backend service needs.",
      tags: ["go", "backend"],
      members: ["skills/security-review"],
    });

    const kinded = await run(["ls", "--kind", "skills"]);
    expect(kinded.stdout.toString()).not.toContain("bundles/");
    expect(
      JSON.parse(
        (await run(["ls", "--kind", "skills", "--json"])).stdout.toString(),
      ).bundles,
    ).toBeUndefined();
    const tagged = await run(["ls", "--tag", "go"]);
    expect(tagged.stdout.toString()).toContain("go-backend");
    expect(tagged.stdout.toString()).not.toContain("frontend");

    expect((await run(["add", "bundles/go-backend"])).exitCode).toBe(0);
    const here = await run(["ls", "--here"]);
    expect(here.stdout.toString()).not.toContain("go-backend");
    expect(
      JSON.stringify(
        JSON.parse((await run(["ls", "--here", "--json"])).stdout.toString()),
      ),
    ).not.toContain("go-backend");
  });

  test("search ranks bundles alongside items with an appended JSON key", async () => {
    const project = await tempRepo("capshelf-bundle-search-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const search = await run(["search", "go", "backend"]);
    expect(search.exitCode).toBe(0);
    const out = search.stdout.toString();
    expect(out).toMatch(/bundles\/go-backend\s+bundle\s+matched: name/);
    expect(out).toContain("Everything a Go backend service needs.");
    expect(out).toContain("2 skills · 2 settings · 1 mcp");

    const tagHit = await run(["search", "needs", "backend", "--json"]);
    expect(tagHit.exitCode).toBe(0);
    expect(JSON.parse(tagHit.stdout.toString()).bundles[0].matches).toEqual([
      { term: "needs", field: "description" },
      { term: "backend", field: "name" },
    ]);

    const member = await run(["search", "permissions-go", "--json"]);
    expect(member.exitCode).toBe(0);
    const parsed = JSON.parse(member.stdout.toString());
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0].name).toBe("go-backend");
    expect(parsed.bundles[0].matches).toEqual([
      { term: "permissions-go", field: "content" },
    ]);
    expect(parsed.bundles[0].members).toContain("settings/permissions-go");
    expect(
      parsed.results.every(
        (row: { source: string }) =>
          row.source === "data" || row.source === "system",
      ),
    ).toBe(true);

    const kinded = await run(["search", "go", "--kind", "skills", "--json"]);
    expect(JSON.parse(kinded.stdout.toString()).bundles).toBeUndefined();

    const only = await run(["search", "backend"]);
    expect(only.exitCode).toBe(0);
    expect(only.stdout.toString()).toContain("1 match in");
  });

  test("bundle refs stay rejected by every other item command", async () => {
    const project = await tempRepo("capshelf-bundle-reject-project-");
    const dataRepo = await bundleDataRepo();
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    for (const args of [
      ["rm", "bundles/go-backend"],
      ["status", "bundles/go-backend"],
      ["get-path", "bundles/go-backend"],
      ["update", "bundles/go-backend"],
      ["promote", "bundles/go-backend"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toContain('invalid item kind "bundles"');
      expect(stderr).toContain("capshelf add bundles/go-backend");
      expect(stderr).toContain("capshelf show bundles/go-backend");
    }
  });
});
