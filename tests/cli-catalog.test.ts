import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, runInProcess, tempDir, tempRepo } from "./cli-fixtures";

describe("cli integration", () => {
  test("ls renders metadata, filters by --tag, and keeps bare rows unchanged", async () => {
    const project = await tempRepo("capshelf-ls-meta-project-");
    const dataRepo = await tempRepo("capshelf-ls-meta-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: frontmatter fallback\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "description: Deep multi-pass security audit of changed files, with extended notes",
        "tags: [Security, review]",
        "",
      ].join("\n"),
    );
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", ".capshelf.yml"),
      "description: Baseline permission allowlist.\ntags: [security]\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const ls = await run(["ls"]);
    expect(ls.exitCode).toBe(0);
    const out = ls.stdout.toString();
    expect(out).toContain(
      "Deep multi-pass security audit of changed files, with extend…  #Security #review",
    );
    expect(out).toContain("Baseline permission allowlist.  #security");
    expect(out).toMatch(/^ {2}skills\/hello {2,}[0-9a-f]{12}$/m);

    const tagged = await run(["ls", "--tag", "SECURITY"]);
    expect(tagged.exitCode).toBe(0);
    expect(tagged.stdout.toString()).toContain("skills/security-review");
    expect(tagged.stdout.toString()).toContain("settings/permissions-base");
    expect(tagged.stdout.toString()).not.toContain("skills/hello");

    const narrowed = await run(["ls", "--tag", "security", "--tag", "review"]);
    expect(narrowed.stdout.toString()).toContain("skills/security-review");
    expect(narrowed.stdout.toString()).not.toContain(
      "settings/permissions-base",
    );

    const kinded = await run(["ls", "--tag", "security", "--kind", "settings"]);
    expect(kinded.stdout.toString()).not.toContain("skills/security-review");
    expect(kinded.stdout.toString()).toContain("settings/permissions-base");

    const json = await run(["ls", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    const review = parsed.data.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(review.description).toBe(
      "Deep multi-pass security audit of changed files, with extended notes",
    );
    expect(review.tags).toEqual(["Security", "review"]);
    const hello = parsed.data.find(
      (row: { name: string }) => row.name === "hello",
    );
    expect(hello.description).toBeUndefined();
    expect(hello.tags).toBeUndefined();
    expect(parsed.system[0].description).toContain("capshelf CLI");
  });

  test("ls --here enriches installed rows best-effort and filters by --tag", async () => {
    const project = await tempRepo("capshelf-ls-here-meta-project-");
    const dataRepo = await tempRepo("capshelf-ls-here-meta-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      "tags: [security]\n",
    );
    await commitAll(dataRepo, "baseline");

    const invoke = runInProcess(project);
    const run = (args: string[]) => invoke(args, { CAPSHELF_HOME: "" });

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/security-review"])).exitCode).toBe(0);

    const here = await run(["ls", "--here", "--json"]);
    expect(here.exitCode).toBe(0);
    const rows = JSON.parse(here.stdout.toString());
    const review = rows.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(review.description).toBe("Audit changed files.");
    expect(review.tags).toEqual(["security"]);

    const human = await run(["ls", "--here"]);
    expect(human.stdout.toString()).toContain(
      "Audit changed files.  #security",
    );

    const tagged = await run(["ls", "--here", "--tag", "security", "--json"]);
    expect(
      JSON.parse(tagged.stdout.toString()).map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["security-review"]);

    await rm(join(project, ".capshelf", "local.json"));
    const unbound = await run(["ls", "--here", "--json"]);
    expect(unbound.exitCode).toBe(0);
    const unboundRows = JSON.parse(unbound.stdout.toString());
    const unboundReview = unboundRows.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(unboundReview.description).toBeUndefined();
    expect(unboundReview.tags).toBeUndefined();
  });

  test("show prints a metadata block with relation install state", async () => {
    const project = await tempRepo("capshelf-show-meta-project-");
    const dataRepo = await tempRepo("capshelf-show-meta-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "tags: [security, review]",
        "requires: [settings/permissions-base]",
        "conflicts-with: [skills/quick-review]",
        "",
      ].join("\n"),
    );
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/permissions-base"])).exitCode).toBe(0);

    const human = await run(["show", "skills/security-review", "--no-content"]);
    expect(human.exitCode).toBe(0);
    const out = human.stdout.toString();
    expect(out).toContain("description: Audit changed files.");
    expect(out).toContain("tags:        security, review");
    expect(out).toContain("settings/permissions-base (installed)");
    expect(out).toContain("skills/quick-review (not installed)");

    const json = await run(["show", "skills/security-review", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    expect(parsed.metadata).toEqual({
      description: "Audit changed files.",
      tags: ["security", "review"],
      requires: [{ ref: "settings/permissions-base", installed: true }],
      conflictsWith: [{ ref: "skills/quick-review", installed: false }],
      needs: { network: [], env: [], bin: [] },
    });

    const bare = JSON.parse(
      (await run(["show", "skills/hello", "--json"])).stdout.toString(),
    );
    expect(bare.metadata).toEqual({
      tags: [],
      requires: [],
      conflictsWith: [],
      needs: { network: [], env: [], bin: [] },
    });

    const system = JSON.parse(
      (await run(["show", "capshelf", "--json"])).stdout.toString(),
    );
    expect(system.metadata.description).toContain("capshelf CLI");
    expect(system.metadata.requires).toEqual([]);
  });

  test("search ranks matches across fields and includes system items", async () => {
    const project = await tempRepo("capshelf-search-project-");
    const dataRepo = await tempRepo("capshelf-search-data-");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nCheck for SQL injection.\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      "tags: [security, review]\n",
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      '{ "permissions": { "deny": ["Bash(curl *)"] } }\n',
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", ".capshelf.yml"),
      "description: Baseline security allowlist.\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const search = await run(["search", "security"]);
    expect(search.exitCode).toBe(0);
    const out = search.stdout.toString();
    expect(out).toMatch(/^\d+ matches in .+ \(\+ system\)$/m);
    const reviewIndex = out.indexOf("skills/security-review");
    const baseIndex = out.indexOf("settings/permissions-base");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(baseIndex).toBeGreaterThan(reviewIndex);
    expect(out).toContain("matched: name");
    expect(out).toContain("Audit changed files.  #security #review");

    const content = await run(["search", "injection"]);
    expect(content.stdout.toString()).toContain("matched: content(SKILL.md)");

    const multi = await run(["search", "sql", "injection", "--json"]);
    expect(multi.exitCode).toBe(0);
    const parsed = JSON.parse(multi.stdout.toString());
    expect(parsed.query).toBe("sql injection");
    expect(parsed.dataRepo).toBe(dataRepo);
    const dataResults = parsed.results.filter(
      (row: { source: string }) => row.source === "data",
    );
    expect(dataResults).toHaveLength(1);
    expect(dataResults[0].name).toBe("security-review");
    expect(dataResults[0].score).toBeGreaterThan(0);
    expect(dataResults[0].tags).toEqual(["security", "review"]);
    expect(dataResults[0].matches).toEqual([
      { term: "sql", field: "content", file: "SKILL.md" },
      { term: "injection", field: "content", file: "SKILL.md" },
    ]);

    const kinded = await run([
      "search",
      "security",
      "--kind",
      "settings",
      "--json",
    ]);
    expect(
      JSON.parse(kinded.stdout.toString()).results.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["permissions-base"]);

    const system = await run(["search", "capshelf", "--json"]);
    const systemRows = JSON.parse(system.stdout.toString()).results;
    expect(
      systemRows.some(
        (row: { source: string; name: string }) =>
          row.source === "system" && row.name === "capshelf",
      ),
    ).toBe(true);

    const none = await run(["search", "definitely-not-on-the-shelf"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout.toString()).toContain("(no matches)");
    const noneJson = await run([
      "search",
      "definitely-not-on-the-shelf",
      "--json",
    ]);
    expect(noneJson.exitCode).toBe(0);
    expect(JSON.parse(noneJson.stdout.toString()).results).toEqual([]);
  });

  test("add warns about missing requires and refuses declared conflicts", async () => {
    const project = await tempRepo("capshelf-add-relations-project-");
    const dataRepo = await tempRepo("capshelf-add-relations-data-");
    for (const skill of ["security-review", "quick-review", "loner"]) {
      await mkdir(join(dataRepo, "skills", skill), { recursive: true });
      await writeFile(
        join(dataRepo, "skills", skill, "SKILL.md"),
        `${skill}\n`,
      );
    }
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "requires:",
        "  - settings/permissions-base",
        "  - mcp/github",
        "conflicts-with:",
        "  - skills/quick-review",
        "  - skills/deleted-upstream",
        "",
      ].join("\n"),
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const add = await run(["add", "skills/security-review", "--json"]);
    expect(add.exitCode).toBe(0);
    const stderr = add.stderr.toString();
    expect(stderr).toContain(
      "missing required items for skills/security-review:",
    );
    expect(stderr).toContain(
      "settings/permissions-base — install with: capshelf add settings/permissions-base",
    );
    expect(stderr).toContain(
      "mcp/github — install with: capshelf add mcp/github",
    );
    expect(JSON.parse(add.stdout.toString()).missingRequires).toEqual([
      "settings/permissions-base",
      "mcp/github",
    ]);

    expect((await run(["add", "settings/permissions-base"])).exitCode).toBe(0);
    const readd = await run(["add", "skills/security-review", "--json"]);
    expect(readd.exitCode).toBe(0);
    expect(readd.stderr.toString()).not.toContain("settings/permissions-base");
    expect(JSON.parse(readd.stdout.toString()).missingRequires).toEqual([
      "mcp/github",
    ]);

    const conflict = await run(["add", "skills/quick-review"]);
    expect(conflict.exitCode).toBe(3);
    const conflictErr = conflict.stderr.toString();
    expect(conflictErr).toContain(
      "not installing skills/quick-review — conflicts with installed skills/security-review",
    );
    expect(conflictErr).toContain(
      "declared by: skills/security-review/.capshelf.yml",
    );
    expect(conflictErr).toContain(
      "remove the conflicting item first: capshelf rm skills/security-review",
    );
    expect(conflictErr).toContain(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
    );

    expect((await run(["add", "skills/loner"])).exitCode).toBe(0);
  });

  test("add refuses the reverse conflict direction and tolerates malformed sidecars", async () => {
    const project = await tempRepo("capshelf-add-reverse-project-");
    const dataRepo = await tempRepo("capshelf-add-reverse-data-");
    for (const skill of ["quick-review", "security-review", "broken-meta"]) {
      await mkdir(join(dataRepo, "skills", skill), { recursive: true });
      await writeFile(
        join(dataRepo, "skills", skill, "SKILL.md"),
        `${skill}\n`,
      );
    }
    await writeFile(
      join(dataRepo, "skills", "quick-review", ".capshelf.yml"),
      "conflicts-with: [skills/security-review]\n",
    );
    await writeFile(
      join(dataRepo, "skills", "broken-meta", ".capshelf.yml"),
      "tags: [unclosed\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/quick-review"])).exitCode).toBe(0);

    const reverse = await run(["add", "skills/security-review"]);
    expect(reverse.exitCode).toBe(3);
    const err = reverse.stderr.toString();
    expect(err).toContain(
      "not installing skills/security-review — conflicts with installed skills/quick-review",
    );
    expect(err).toContain("declared by: skills/quick-review/.capshelf.yml");

    const malformed = await run(["add", "skills/broken-meta"]);
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stderr.toString()).toContain(
      "skills/broken-meta: invalid .capshelf.yml",
    );
  });

  test("search content scanning skips binary and oversize files in real repos", async () => {
    const project = await tempRepo("capshelf-search-skip-project-");
    const dataRepo = await tempRepo("capshelf-search-skip-data-");
    const skill = join(dataRepo, "skills", "mixed");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "contains textneedle marker\n");
    await writeFile(
      join(skill, "blob.bin"),
      Buffer.concat([
        Buffer.from("nulneedle "),
        Buffer.from([0x00, 0x01, 0x02]),
      ]),
    );
    await writeFile(
      join(skill, "big.txt"),
      `${"x".repeat(256 * 1024)} hugeneedle\n`,
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const text = await run(["search", "textneedle", "--json"]);
    expect(text.exitCode).toBe(0);
    expect(
      JSON.parse(text.stdout.toString()).results.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["mixed"]);

    for (const needle of ["nulneedle", "hugeneedle"]) {
      const skipped = await run(["search", needle, "--json"]);
      expect(skipped.exitCode).toBe(0);
      expect(JSON.parse(skipped.stdout.toString()).results).toEqual([]);
    }
  });

  test("update after a metadata-only data repo commit is a full no-op", async () => {
    const project = await tempRepo("capshelf-meta-noop-project-");
    const dataRepo = await tempRepo("capshelf-meta-noop-data-");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "---\nname: hello\n---\nhello v1\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await readFile(lockPath, "utf-8");

    // sourceCommit is computed sidecar-blind, so a metadata-only upstream
    // commit must leave the lock byte-identical.
    await writeFile(
      join(dataRepo, "skills", "hello", ".capshelf.yml"),
      "description: says hello\ntags: [greeting]\n",
    );
    await commitAll(dataRepo, "tag hello");

    const status = await run(["status", "skills/hello", "--strict", "--json"]);
    expect(status.exitCode).toBe(0);

    const update = await run(["update", "skills/hello", "--json"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout.toString()).toContain('"action": "already-current"');
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
  });

  test("status degrades a non-git data repo path to missing_upstream", async () => {
    const project = await tempRepo("capshelf-status-nongit-project-");
    const dataRepo = await tempRepo("capshelf-status-nongit-data-");
    const notARepo = await tempDir("capshelf-status-nongit-dir-");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "hello"])).exitCode).toBe(0);

    const localPath = join(project, ".capshelf", "local.json");
    const local = await file(localPath).json();
    await writeFile(
      localPath,
      JSON.stringify({ ...local, dataRepo: notARepo }, null, 2),
    );

    const status = await run(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const rows = JSON.parse(status.stdout.toString()).items;
    const hello = rows.find(
      (row: { name: string; kind: string }) =>
        row.kind === "skills" && row.name === "hello",
    );
    expect(hello.state).toBe("missing_upstream");

    expect((await run(["status", "--strict"])).exitCode).toBe(4);
  });

  test("ls marks a skills/<n> and plugins/<n> pair (D2 guard 2)", async () => {
    const project = await tempRepo("capshelf-ls-pair-project-");
    const dataRepo = await tempRepo("capshelf-ls-pair-data-");
    await mkdir(join(dataRepo, "skills", "rust-review"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "rust-review", "SKILL.md"),
      "---\nname: rust-review\ndescription: d\n---\nbody\n",
    );
    await mkdir(join(dataRepo, "plugins", "rust-review", "skills", "s"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "plugins", "rust-review", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nbody\n",
    );
    await mkdir(join(dataRepo, "plugins", "rust-review", ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "plugins", "rust-review", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "rust-review" }),
    );
    // An unrelated plugin serves as a control proving the marker is not printed
    // for plugins it does not apply to.
    await mkdir(join(dataRepo, "plugins", "lonely", "skills", "s"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "plugins", "lonely", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nbody\n",
    );
    await mkdir(join(dataRepo, "plugins", "lonely", ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "plugins", "lonely", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "lonely" }),
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const ls = await run(["ls"]);
    expect(ls.exitCode).toBe(0);
    const out = ls.stdout.toString();
    expect(out).toContain(
      "    ^ skills/rust-review and plugins/rust-review both install to .agents/skills/rust-review. A project uses one of them.",
    );
    const lonelyIndex = out.indexOf("plugins/lonely");
    const lonelyNextLine = out.slice(lonelyIndex).split("\n")[1] ?? "";
    expect(lonelyNextLine).not.toContain("^");

    const json = await run(["ls", "--json"]);
    const parsed = JSON.parse(json.stdout.toString());
    const pluginRow = parsed.data.find(
      (row: { kind: string; name: string }) =>
        row.kind === "plugins" && row.name === "rust-review",
    );
    expect(pluginRow.sharesTargetWith).toBe("skills/rust-review");
    const lonelyRow = parsed.data.find(
      (row: { kind: string; name: string }) =>
        row.kind === "plugins" && row.name === "lonely",
    );
    expect(lonelyRow.sharesTargetWith).toBeUndefined();
    const skillRow = parsed.data.find(
      (row: { kind: string; name: string }) =>
        row.kind === "skills" && row.name === "rust-review",
    );
    expect(skillRow.sharesTargetWith).toBeUndefined();

    const kinded = await run(["ls", "--kind", "plugins", "--json"]);
    const kindedRow = JSON.parse(kinded.stdout.toString()).data.find(
      (row: { name: string }) => row.name === "rust-review",
    );
    expect(kindedRow.sharesTargetWith).toBe("skills/rust-review");
  });
});
