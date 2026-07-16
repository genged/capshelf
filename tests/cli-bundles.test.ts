import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, runIn, tempRepo } from "./cli-fixtures";

describe("cli integration", () => {
  /**
   * Data repo for the bundle tests: two skills, two settings fragments, one
   * mcp fragment, a conflicting skill, and bundles/go-backend.yml. Items are
   * committed in two separate commits so member sourceCommits can differ.
   */
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
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    const add = run(["add", "bundles/go-backend"]);
    expect(add.exitCode).toBe(0);
    const out = add.stdout.toString();
    expect(out).toContain("✓ bundle go-backend → 5 added, 0 already installed");
    expect(out).toMatch(/\+ skills\/security-review\s+@ [0-9a-f]{12}/);
    expect(out).toMatch(/\+ mcp\/github\s+@ [0-9a-f]{12}/);

    // N independent lock entries with their own sha + sourceCommit; the
    // bundle itself is traceless (no lock key, no manifest field).
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
    expect(new Set(memberKeys.map((k) => lock.items[k].sha)).size).toBe(5);
    // Separate commits produced distinct sourceCommits.
    expect(
      new Set(memberKeys.map((k) => lock.items[k].sourceCommit)).size,
    ).toBe(2);
    expect(JSON.stringify(lock)).not.toContain("go-backend");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["security-review", "go-test-writer"]);
    // Bundle-file order flows into the manifest (fragment merge order).
    expect(manifest.settings).toEqual(["permissions-base", "permissions-go"]);
    expect(JSON.stringify(manifest)).not.toContain("go-backend");
    const settings = await file(
      join(project, ".claude", "settings.json"),
    ).json();
    expect(settings.env).toEqual({ BASE: "1", GO: "1" });
    expect(run(["status", "--strict"]).exitCode).toBe(0);

    // Re-run: all already-installed, exit 0, lock byte-identical (no pin
    // bump, no appliedAt rewrite) — the skip lives in the bundle executor.
    const before = await readFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      "utf-8",
    );
    const rerun = run(["add", "bundles/go-backend"]);
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

    // …while standalone add of the same installed item still re-applies
    // (fresh appliedAt) — the pair pins the skip gate to the executor.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const single = run(["add", "skills/security-review"]);
    expect(single.exitCode).toBe(0);
    expect(single.stdout.toString()).toContain("re-applied");
    expect(
      await readFile(join(project, ".capshelf", "capshelf.lock.json"), "utf-8"),
    ).not.toBe(before);

    // Bundle grows upstream → re-run adds only the new member.
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
    // The bundle file itself may stay uncommitted: nothing pins it.
    const grown = run(["add", "bundles/go-backend", "--json"]);
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
    expect(extra.sha).toMatch(/^[0-9a-f]{12}$/);
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
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);
    expect(run(["add", "skills/security-review"]).exitCode).toBe(0);

    // A second bundle with a conflicting member and a missing member.
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
    const refused = run(["add", "bundles/broken-set"]);
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
    // The all-or-nothing assertion: manifest, both locks, and project
    // outputs are byte-identical.
    expect(await capshelfState(project)).toBe(before);

    // Same refusal as JSON: one envelope for both outcomes.
    const json = run(["add", "bundles/broken-set", "--json"]);
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
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    // A local scalar in .claude/settings.json colliding with a bundle
    // settings member (env.GO is contributed by settings/permissions-go).
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ env: { GO: "local-value" } }, null, 2),
    );

    const before = await capshelfState(project);
    const refused = run(["add", "bundles/go-backend"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toMatch(/✗ settings\/permissions-go\s+cannot reconcile/);
    expect(out).toContain("unmanaged local value");
    expect(await capshelfState(project)).toBe(before);
  });

  test("add bundles --local is skills-only with one aggregated error", async () => {
    const project = await tempRepo("capshelf-bundle-local-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    const refused = run(["add", "bundles/go-backend", "--local"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    expect(out).toContain(
      "✗ not installing bundle go-backend --local — local scope is skills-only",
    );
    // ONE aggregated line naming all fragment members, not just the first.
    expect(out).toContain(
      "fragment members: settings/permissions-base, settings/permissions-go, mcp/github",
    );
    expect(out).toContain(
      "install the bundle at project scope instead: capshelf add bundles/go-backend",
    );

    // A skills-only bundle installs fine with --local.
    await writeFile(
      join(dataRepo, "bundles", "skills-only.yml"),
      "includes:\n  skills: [security-review, go-test-writer]\n",
    );
    const local = run(["add", "bundles/skills-only", "--local"]);
    expect(local.exitCode).toBe(0);
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/security-review"]?.source).toBe("data");
    expect(localLock.items["data/skills/go-test-writer"]?.source).toBe("data");
  });

  test("mixed --local refusal prints one headline counting every failure", async () => {
    const project = await tempRepo("capshelf-bundle-mixed-local-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    // One fragment member (local-scope violation) plus one missing member.
    await writeFile(
      join(dataRepo, "bundles", "mixed-local.yml"),
      [
        "includes:",
        "  skills:   [security-review, nope]",
        "  settings: [permissions-base]",
        "",
      ].join("\n"),
    );

    const refused = run(["add", "bundles/mixed-local", "--local"]);
    expect(refused.exitCode).toBe(3);
    const out = refused.stdout.toString();
    // A single headline whose count covers the fragment member AND the
    // missing member — not a second header with a reduced count.
    expect(out).toContain(
      "✗ not installing bundle mixed-local — 2 of 3 members failed preflight",
    );
    expect(out).not.toContain("not installing bundle mixed-local --local");
    expect(out).toContain("✗ local scope is skills-only");
    expect(out).toContain("fragment members: settings/permissions-base");
    expect(out).toMatch(/✗ skills\/nope\s+not found in data repo/);
  });

  test("missing, empty, and malformed bundles on the install path", async () => {
    const project = await tempRepo("capshelf-bundle-errors-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    const missing = run(["add", "bundles/nope"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain("bundle not found");

    await writeFile(join(dataRepo, "bundles", "empty.yml"), "includes:\n");
    const empty = run(["add", "bundles/empty"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout.toString()).toContain(
      "✓ bundle empty → nothing to install (bundle has no members)",
    );

    await writeFile(join(dataRepo, "bundles", "bad.yml"), "[broken\n");
    const malformed = run(["add", "bundles/bad"]);
    expect(malformed.exitCode).toBe(3);
    expect(malformed.stderr.toString()).toContain("invalid YAML");

    await writeFile(
      join(dataRepo, "bundles", "newer.yml"),
      "includes:\n  skills: [security-review]\n  agents: [b]\n",
    );
    const unknownKind = run(["add", "bundles/newer"]);
    expect(unknownKind.exitCode).toBe(3);
    expect(unknownKind.stderr.toString()).toContain(
      "upgrade capshelf or edit the bundle",
    );
  });

  test("show bundles/<x> previews membership and install state", async () => {
    const project = await tempRepo("capshelf-bundle-show-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);
    expect(run(["add", "settings/permissions-base"]).exitCode).toBe(0);
    // A member missing from the data repo is previewed, not fatal.
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

    const human = run(["show", "bundles/go-backend"]);
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

    const json = run(["show", "bundles/go-backend", "--json"]);
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
        lockedSha: expect.stringMatching(/^[0-9a-f]{12}$/),
      },
      { ref: "mcp/postgres-local", available: false, installed: false },
    ]);

    expect(run(["show", "bundles/nope"]).exitCode).toBe(2);
    const target = run(["show", "bundles/go-backend", "--target", "claude"]);
    expect(target.exitCode).toBe(3);
    const noContent = run(["show", "bundles/go-backend", "--no-content"]);
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
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    // Snapshot before any bundles/ dir exists.
    const before = JSON.parse(run(["ls", "--json"]).stdout.toString());
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

    const ls = run(["ls"]);
    expect(ls.exitCode).toBe(0);
    const out = ls.stdout.toString();
    expect(out).toContain("bundles/  (from");
    expect(out).toMatch(
      /go-backend\s+1 skills\s+Everything a Go backend service needs\.\s+#go #backend/,
    );
    expect(out).toMatch(/frontend\s+1 skills/);
    // Malformed bundles stay visible name-only; warnings go to stderr.
    expect(out).toMatch(/^ {2}bad$/m);
    expect(ls.stderr.toString()).toContain("bundles/bad: invalid YAML");
    expect(ls.stderr.toString()).toContain(
      "bundles/legacy.yaml ignored — rename to legacy.yml",
    );

    // Append-only: the system/data arrays are deep-equal pre/post.
    const after = JSON.parse(run(["ls", "--json"]).stdout.toString());
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

    // Suppressed under --kind (bundles are not a kind) and filtered by --tag.
    const kinded = run(["ls", "--kind", "skills"]);
    expect(kinded.stdout.toString()).not.toContain("bundles/");
    expect(
      JSON.parse(run(["ls", "--kind", "skills", "--json"]).stdout.toString())
        .bundles,
    ).toBeUndefined();
    const tagged = run(["ls", "--tag", "go"]);
    expect(tagged.stdout.toString()).toContain("go-backend");
    expect(tagged.stdout.toString()).not.toContain("frontend");

    // ls --here is lock-derived and bundles are traceless.
    expect(run(["add", "bundles/go-backend"]).exitCode).toBe(0);
    const here = run(["ls", "--here"]);
    expect(here.stdout.toString()).not.toContain("go-backend");
    expect(
      JSON.stringify(
        JSON.parse(run(["ls", "--here", "--json"]).stdout.toString()),
      ),
    ).not.toContain("go-backend");
  });

  test("search ranks bundles alongside items with an appended JSON key", async () => {
    const project = await tempRepo("capshelf-bundle-search-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    // Name hits rank the bundle; the detail line carries description and
    // member counts.
    const search = run(["search", "go", "backend"]);
    expect(search.exitCode).toBe(0);
    const out = search.stdout.toString();
    expect(out).toMatch(/bundles\/go-backend\s+bundle\s+matched: name/);
    expect(out).toContain("Everything a Go backend service needs.");
    expect(out).toContain("2 skills · 2 settings · 1 mcp");

    // Tag-only hits match through the tags field.
    const tagHit = run(["search", "needs", "backend", "--json"]);
    expect(tagHit.exitCode).toBe(0);
    expect(JSON.parse(tagHit.stdout.toString()).bundles[0].matches).toEqual([
      { term: "needs", field: "description" },
      { term: "backend", field: "name" },
    ]);

    // Member refs score through the content field at weight 1.
    const member = run(["search", "permissions-go", "--json"]);
    expect(member.exitCode).toBe(0);
    const parsed = JSON.parse(member.stdout.toString());
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0].name).toBe("go-backend");
    expect(parsed.bundles[0].matches).toEqual([
      { term: "permissions-go", field: "content" },
    ]);
    expect(parsed.bundles[0].members).toContain("settings/permissions-go");
    // results stays items-only with its existing shape.
    expect(
      parsed.results.every(
        (row: { source: string }) =>
          row.source === "data" || row.source === "system",
      ),
    ).toBe(true);

    // --kind narrows to items only.
    const kinded = run(["search", "go", "--kind", "skills", "--json"]);
    expect(JSON.parse(kinded.stdout.toString()).bundles).toBeUndefined();

    // A bundle-only hit still counts as a match.
    const only = run(["search", "backend"]);
    expect(only.exitCode).toBe(0);
    expect(only.stdout.toString()).toContain("1 match in");
  });

  test("bundle refs stay rejected by every other item command", async () => {
    const project = await tempRepo("capshelf-bundle-reject-project-");
    const dataRepo = await bundleDataRepo();
    const run = runIn(project);
    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    for (const args of [
      ["rm", "bundles/go-backend"],
      ["status", "bundles/go-backend"],
      ["get-path", "bundles/go-backend"],
      ["update", "bundles/go-backend"],
      ["promote", "bundles/go-backend"],
    ]) {
      const result = run(args);
      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toContain('invalid item kind "bundles"');
      expect(stderr).toContain("capshelf add bundles/go-backend");
      expect(stderr).toContain("capshelf show bundles/go-backend");
    }
  });
});
