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
    // 60-char truncation plus ellipsis; tags render as #tag suffixes.
    expect(out).toContain(
      "Deep multi-pass security audit of changed files, with extend…  #Security #review",
    );
    expect(out).toContain("Baseline permission allowlist.  #security");
    // A metadata-less row stays exactly kind/name + sha.
    expect(out).toMatch(/^ {2}skills\/hello {2,}[0-9a-f]{12}$/m);

    // --tag is AND and case-insensitive, and combines with --kind.
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
    // The bundled system skill carries its frontmatter description.
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

    // With no data repo bound, ls --here still works; fields are omitted.
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

    // metadata is always present, even for items without any metadata.
    const bare = JSON.parse(
      (await run(["show", "skills/hello", "--json"])).stdout.toString(),
    );
    expect(bare.metadata).toEqual({
      tags: [],
      requires: [],
      conflictsWith: [],
      needs: { network: [], env: [], bin: [] },
    });

    // System items report frontmatter metadata the same way.
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

    // Name hit (8) outranks the description hit (2).
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

    // Content matching annotates the first matching file.
    const content = await run(["search", "injection"]);
    expect(content.stdout.toString()).toContain("matched: content(SKILL.md)");

    // Multi-word queries are AND; quoted and unquoted forms both work.
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

    // --kind narrows the searched population.
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

    // Bundled system items are searched too.
    const system = await run(["search", "capshelf", "--json"]);
    const systemRows = JSON.parse(system.stdout.toString()).results;
    expect(
      systemRows.some(
        (row: { source: string; name: string }) =>
          row.source === "system" && row.name === "capshelf",
      ),
    ).toBe(true);

    // Zero matches: friendly output, empty results, exit 0.
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

    // Missing requires warn with exact fix commands, install succeeds, and
    // --json appends missingRequires. A conflict ref pointing at an item
    // that exists nowhere (skills/deleted-upstream) is ignored.
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

    // Installing a declared requirement shrinks the warning on re-add.
    expect((await run(["add", "settings/permissions-base"])).exitCode).toBe(0);
    const readd = await run(["add", "skills/security-review", "--json"]);
    expect(readd.exitCode).toBe(0);
    expect(readd.stderr.toString()).not.toContain("settings/permissions-base");
    expect(JSON.parse(readd.stdout.toString()).missingRequires).toEqual([
      "mcp/github",
    ]);

    // Forward conflict: the new item declares it.
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

    // An unrelated item still installs.
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
    // Only quick-review declares the conflict; the check is symmetric.
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

    // A malformed sidecar warns but never blocks the install.
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
    // A NUL byte marks the file as binary; its needle must not match.
    await writeFile(
      join(skill, "blob.bin"),
      Buffer.concat([
        Buffer.from("nulneedle "),
        Buffer.from([0x00, 0x01, 0x02]),
      ]),
    );
    // Over the 256 KiB content cap; its needle must not match either.
    await writeFile(
      join(skill, "big.txt"),
      `${"x".repeat(256 * 1024)} hugeneedle\n`,
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    // The fixture is searchable through its text file…
    const text = await run(["search", "textneedle", "--json"]);
    expect(text.exitCode).toBe(0);
    expect(
      JSON.parse(text.stdout.toString()).results.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["mixed"]);

    // …but binary and oversize files are skipped, still exiting 0.
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

    // A metadata-only commit upstream: sha unchanged AND sourceCommit
    // computed sidecar-blind, so the lock must stay byte-identical.
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
});
