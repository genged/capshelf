import { $ } from "bun";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addSkill,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectItems,
  runInProcess,
} from "./cli-fixtures";
import {
  cacheRootOf,
  deleteUpstream,
  initRemoteProject,
  pushChange,
  recordGitInvocations,
  upstreamWith,
} from "./remote-fixtures";
import { remoteCachePath } from "../src/remote-cache";
import { parseRemoteSkillUrl } from "../src/remote-url";

async function installed() {
  const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
  const world = await initRemoteProject();
  const run = runInProcess(world.project);
  expect(
    (await run(["add", upstream.url, "--yes", "--json"], world.env)).exitCode,
  ).toBe(0);
  const lockPath = join(world.project, ".capshelf", "remotes.lock.json");
  const installPath = join(world.project, ".agents/skills/pdf");
  return { upstream, world, run, lockPath, installPath };
}

test(
  "apply reconciles a deleted remote install from the cache",
  async () => {
    const { world, run, installPath } = await installed();
    await rm(installPath, { recursive: true });
    const result = await run(["apply", "--yes", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toContain(
      "name: pdf",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "apply refuses a remote row whose cache is gone and names the check flag",
  async () => {
    const { world, run, installPath } = await installed();
    const before = await readFile(join(installPath, "SKILL.md"), "utf-8");
    await rm(cacheRootOf(world), { recursive: true });

    const result = await run(
      ["apply", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString() + result.stdout.toString()).toContain(
      "capshelf status --check-upstream",
    );
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update moves a remote pin from an already-fetched cache",
  async () => {
    const { upstream, world, run, lockPath, installPath } = await installed();
    const before = JSON.parse(await readFile(lockPath, "utf-8"));
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);

    const result = await run(
      ["update", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const after = JSON.parse(await readFile(lockPath, "utf-8"));
    expect(after.items["remote/skills/pdf"].sourceCommit).not.toBe(
      before.items["remote/skills/pdf"].sourceCommit,
    );
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toContain(
      "Extract text and tables",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update reports already current when the cache was never re-fetched",
  async () => {
    const { upstream, world, run, lockPath } = await installed();
    const before = await readFile(lockPath, "utf-8");
    await pushChange(upstream, "skills/pdf", "Extract text and tables");

    const result = await run(["update", "skills/pdf", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows[0]!.action).toBe("already-current");
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "bare update skips a remote row whose cache already holds newer content",
  async () => {
    // The cache must hold something newer than the pin, or this test cannot
    // fail: a fresh install leaves the cache head equal to the pin, so an
    // implementation that moved every remote pin would also leave it alone.
    const { upstream, world, run, lockPath } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const before = await readFile(lockPath, "utf-8");
    const installedBefore = await readFile(
      join(world.project, ".agents/skills/pdf/SKILL.md"),
      "utf-8",
    );

    const result = await run(["update", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    const row = rows.find((candidate) => candidate.key === "remote/skills/pdf");
    expect(row).toBeDefined();
    expect(row!.action).toBe("skipped");
    expect(await readFile(lockPath, "utf-8")).toBe(before);
    expect(
      await readFile(
        join(world.project, ".agents/skills/pdf/SKILL.md"),
        "utf-8",
      ),
    ).toBe(installedBefore);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "bare update opens no network connection while a remote row exists",
  async () => {
    // Exit 0 with the upstream deleted is not proof. `fetchOrigin` reports a
    // failure instead of throwing, so a command that fetched and swallowed the
    // error would pass that assertion. Count the invocations instead, and keep
    // the deleted upstream as a second signal.
    const { upstream, world, run, lockPath } = await installed();
    const before = await readFile(lockPath, "utf-8");
    const git = await recordGitInvocations(world);
    await deleteUpstream(upstream);

    const result = await run(["update", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    expect(await git.subcommands(["fetch", "clone", "ls-remote"])).toEqual([]);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows.some((row) => row.key === "remote/skills/pdf")).toBe(true);
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "apply opens no network connection while a remote row exists",
  async () => {
    const { upstream, world, run } = await installed();
    const git = await recordGitInvocations(world);
    await deleteUpstream(upstream);
    const result = await run(["apply", "--yes", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    expect(await git.subcommands(["fetch", "clone", "ls-remote"])).toEqual([]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update refuses a remote row with a cold cache and writes nothing",
  async () => {
    const { world, run, lockPath } = await installed();
    const before = await readFile(lockPath, "utf-8");
    await rm(cacheRootOf(world), { recursive: true });

    const result = await run(["update", "skills/pdf", "--json"], world.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString() + result.stdout.toString()).toContain(
      "capshelf status --check-upstream",
    );
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a named update without --yes refuses in a non-TTY run and writes nothing",
  async () => {
    // A9: consent covers a commit. `--json` names a scripted caller and does
    // not answer the question; `--yes` does.
    const { upstream, world, run, lockPath } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const before = await readFile(lockPath, "utf-8");

    const result = await run(["update", "skills/pdf", "--json"], world.env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("--yes");
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update --merge reconciles a local edit with a moved upstream",
  async () => {
    const { upstream, world, run, lockPath, installPath } = await installed();
    const before = JSON.parse(await readFile(lockPath, "utf-8"));
    await appendFile(join(installPath, "SKILL.md"), "\n- ask about rollback\n");
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);

    const result = await run(
      ["update", "skills/pdf", "--merge", "--yes"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const merged = await readFile(join(installPath, "SKILL.md"), "utf-8");
    expect(merged).toContain("ask about rollback");
    expect(merged).toContain("Extract text and tables");
    const out = result.stdout.toString();
    expect(out).toContain("capshelf share skills/pdf --adopt");
    expect(out).not.toContain("capshelf promote");
    // A merge reports as a merge. "updated" would hide that a local edit was
    // reconciled rather than overwritten, and drop the review command with it.
    expect(out).toContain("merged upstream into installed copy");
    expect(out).toContain("capshelf status skills/pdf --diff-view installed");
    expect(out).not.toContain("--local");
    // The merge moves the pin as well as the files. Asserting only the file
    // content would pass while the lock still named the old commit, and the
    // row would then read as drift the merge itself created.
    const lock = JSON.parse(
      await readFile(
        join(world.project, ".capshelf", "remotes.lock.json"),
        "utf-8",
      ),
    );
    expect(lock.items["remote/skills/pdf"].sourceCommit).not.toBe(
      before.items["remote/skills/pdf"].sourceCommit,
    );
    const status = await run(["status", "skills/pdf", "--json"], world.env);
    expect(
      objectItems(jsonOutput(status), "items").find(
        (row) => row.name === "pdf",
      )!.state,
    ).toBe("drifted_local");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update --dry-run writes nothing",
  async () => {
    const { upstream, world, run, lockPath, installPath } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const lockBefore = await readFile(lockPath, "utf-8");
    const fileBefore = await readFile(join(installPath, "SKILL.md"), "utf-8");

    const result = await run(
      ["update", "skills/pdf", "--dry-run", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      fileBefore,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a named update overwrites local drift only with --yes",
  async () => {
    const { upstream, world, run, installPath } = await installed();
    await appendFile(join(installPath, "SKILL.md"), "\n- local note\n");
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const drifted = await readFile(join(installPath, "SKILL.md"), "utf-8");

    const refused = await run(["update", "skills/pdf", "--json"], world.env);
    expect(refused.exitCode).toBe(3);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      drifted,
    );

    const accepted = await run(
      ["update", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(accepted.exitCode).toBe(0);
    const after = await readFile(join(installPath, "SKILL.md"), "utf-8");
    expect(after).toContain("Extract text and tables");
    expect(after).not.toContain("local note");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "rm removes the install, the compatibility symlink, and the remote row",
  async () => {
    const { world, run, lockPath, installPath } = await installed();
    const result = await run(
      ["rm", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(installPath)).toBe(false);
    expect(existsSync(join(world.project, ".claude/skills/pdf"))).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf-8")).items).toEqual({});
    const exclude = await readFile(
      join(world.project, ".git/info/exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".agents/skills/pdf/");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "rm with an extra local file lists it and refuses without consent",
  async () => {
    const { world, run, lockPath, installPath } = await installed();
    await writeFile(join(installPath, "notes.md"), "mine\n");
    const before = await readFile(lockPath, "utf-8");

    const result = await run(["rm", "skills/pdf", "--json"], world.env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString() + result.stdout.toString()).toContain(
      "notes.md",
    );
    expect(existsSync(installPath)).toBe(true);
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "rm works when the cache is gone, and names every path it would delete",
  async () => {
    // Task 1's degrade rule: with the locked file set unknown, every installed
    // path is possibly the user's, so each one is named and deleted only with
    // consent. `--yes` supplies it.
    const { world, run, installPath } = await installed();
    await rm(cacheRootOf(world), { recursive: true });
    const refused = await run(["rm", "skills/pdf", "--json"], world.env);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString() + refused.stdout.toString()).toContain(
      "SKILL.md",
    );
    expect(existsSync(installPath)).toBe(true);

    const result = await run(
      ["rm", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(installPath)).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "promote refuses a remote row and names share --adopt",
  async () => {
    const { world, run } = await installed();
    const result = await run(["promote", "skills/pdf", "--json"], world.env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "capshelf share skills/pdf --adopt",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "promote refuses a remote row before it resolves a data repo",
  async () => {
    // D7 allows a project that holds remote rows and no data-repo binding. The
    // refusal that names `share --adopt` has to come first, or that project
    // exits 6 with a message about a shelf it never had.
    const { world, run } = await installed();
    await rm(join(world.project, ".capshelf", "local.json"));
    const result = await run(["promote", "skills/pdf", "--json"], {
      ...world.env,
      CAPSHELF_HOME: undefined,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "capshelf share skills/pdf --adopt",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test.each([
  ["keep-local", ["keep-local", "skills/pdf", "--reason", "why"]],
  ["move", ["move", "skills/pdf", "--to", "project"]],
  ["revert", ["revert", "skills/pdf", "--yes"]],
])(
  "%s refuses a remote row and names the remotes lock",
  async (_verb, argv) => {
    const { world, run } = await installed();
    const result = await run([...argv, "--json"], world.env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("remotes.lock.json");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update --dry-run previews the pin a real run would move",
  async () => {
    // The earlier dry-run test only asserts that nothing changed, which a
    // command that does nothing at all passes trivially. This one asserts the
    // preview reports the row, so the dry run and the real run agree.
    const { upstream, world, run } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);

    const result = await run(
      ["update", "skills/pdf", "--dry-run", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    const row = rows.find((candidate) => candidate.key === "remote/skills/pdf");
    expect(row).toBeDefined();
    expect(row!.action).toBe("would-update");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a bare update --dry-run reports the remote rows the real sweep skips",
  async () => {
    const { world, run } = await installed();
    const result = await run(["update", "--dry-run", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows.some((row) => row.key === "remote/skills/pdf")).toBe(true);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a remote refusal after the shelf pass keeps the shelf lock in step with disk",
  async () => {
    // The shelf loop materializes new bytes for every target before the remote
    // pass starts, and the remote pass refuses a cold cache by throwing. A
    // shelf lock saved after that throw is never saved at all, so the item's
    // files sit ahead of its pin — drift the user never introduced, which the
    // next `apply` reverts.
    const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    expect(
      (await run(["add", "skills/placeholder", "--json"], world.env)).exitCode,
    ).toBe(0);
    expect(
      (await run(["add", upstream.url, "--yes", "--json"], world.env)).exitCode,
    ).toBe(0);
    await addSkill(world.dataRepo, "placeholder", "placeholder v2\n");
    await commitAll(world.dataRepo, "revise placeholder");
    await rm(cacheRootOf(world), { recursive: true });

    const result = await run(
      ["update", "skills/placeholder", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).not.toBe(0);
    expect(
      await readFile(
        join(world.project, ".agents/skills/placeholder/SKILL.md"),
        "utf-8",
      ),
    ).toContain("placeholder v2");
    const status = await run(
      ["status", "skills/placeholder", "--json"],
      world.env,
    );
    expect(
      objectItems(jsonOutput(status), "items").find(
        (row) => row.name === "placeholder",
      )!.state,
    ).toBe("ok");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "share --adopt --to project reads the excluded install and drops its exclude",
  async () => {
    // `--to project` is required: a skill shared without `--to` lands in local
    // scope, where the exclude is correct and stays.
    //
    // The exclude has to go before the adopt reads the item, not after it
    // commits. A project-scope adopt snapshots through project Git, and the
    // install path `add <url>` excluded reads there as an empty directory.
    const { world, run } = await installed();
    const excludePath = join(world.project, ".git/info/exclude");
    expect(await readFile(excludePath, "utf-8")).toContain(
      ".agents/skills/pdf/",
    );

    const result = await run(
      [
        "share",
        "skills/pdf",
        "--adopt",
        "--to",
        "project",
        "--json",
        "-m",
        "adopt pdf",
      ],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    // Exit 0 alone would pass on an adopt that committed an empty tree, so the
    // shelf copy is the assertion that can fail.
    expect(
      await readFile(join(world.dataRepo, "skills/pdf/SKILL.md"), "utf-8"),
    ).toContain("name: pdf");
    // A project-scope item still named in `.git/info/exclude` is skipped by
    // `git add -A`, and every unpinned extra under it is misclassified, because
    // the project scope reads Git's whole ignore stack.
    expect(await readFile(excludePath, "utf-8")).not.toContain(
      ".agents/skills/pdf/",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a cold cache reports an unreadable source, not a missing install",
  async () => {
    // The files are intact; only machine state is gone. Reporting
    // `missing_installed` sent the user to `capshelf apply`, which then refuses
    // with the cold-cache refusal — a dead end that also failed --strict.
    const { world, run, installPath } = await installed();
    await rm(cacheRootOf(world), { recursive: true });
    expect(existsSync(join(installPath, "SKILL.md"))).toBe(true);

    const result = await run(["status", "skills/pdf", "--json"], world.env);
    const row = objectItems(jsonOutput(result), "items").find(
      (candidate) => candidate.name === "pdf",
    );
    expect(row!.state).toBe("missing_source_commit");

    const text = await run(["status", "skills/pdf"], world.env);
    const out = text.stdout.toString();
    expect(out).toContain("capshelf status --check-upstream");
    expect(out).not.toContain("capshelf apply");
    expect(out).not.toContain("sync-data");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a check that finds the item gone upstream clears the digest it measured before",
  async () => {
    // The first check records a digest. The second must replace it, not merge
    // with it: a digest carried over from the run that still found the item
    // leaves a deleted skill reading `ok` forever.
    const { upstream, world, run, lockPath } = await installed();
    await run(["status", "--check-upstream", "--json"], world.env);
    expect(
      JSON.parse(await readFile(lockPath, "utf-8")).items["remote/skills/pdf"]
        .upstreamPinDigest,
    ).toBeDefined();

    await rm(join(upstream.work, "skills/pdf"), { recursive: true });
    await commitAll(upstream.work, "drop pdf");
    await $`git -C ${upstream.work} push -q origin main`.quiet();

    expect(
      (await run(["status", "--check-upstream", "--json"], world.env)).exitCode,
    ).toBe(0);
    expect(
      JSON.parse(await readFile(lockPath, "utf-8")).items["remote/skills/pdf"]
        .upstreamPinDigest,
    ).toBeUndefined();
    const status = await run(["status", "skills/pdf", "--json"], world.env);
    expect(
      objectItems(jsonOutput(status), "items").find(
        (row) => row.name === "pdf",
      )!.state,
    ).toBe("missing_upstream");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a bare apply sweep names the check flag when the cache is gone",
  async () => {
    // The named case refuses in the preflight. The sweep records that refusal
    // and carries on to the write loop, which built a source from a path
    // holding no repository and reported whatever git printed about it.
    const { world, run } = await installed();
    await rm(cacheRootOf(world), { recursive: true });

    const result = await run(["apply", "--yes", "--json"], world.env);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("capshelf status --check-upstream");
    expect(output).not.toContain("not a git repository");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a refusal on the second named row keeps the first row's moved pin recorded",
  async () => {
    // The same rule as the install loop: a row whose files were rewritten must
    // have its pin recorded before the next row can fail the command.
    const moving = await upstreamWith([["skills/pdf", "Extract text"]]);
    const stalled = await upstreamWith([["skills/sql-review", "Review SQL"]]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    await run(["add", moving.url, "--yes", "--json"], world.env);
    await run(["add", stalled.url, "--yes", "--json"], world.env);
    await pushChange(moving, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    // Only the second row's cache goes away, so the first row moves and the
    // second one throws the cold-cache refusal.
    await rm(
      remoteCachePath(parseRemoteSkillUrl(stalled.url).upstream, world.env),
      { recursive: true },
    );

    const result = await run(
      ["update", "skills/pdf", "skills/sql-review", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).not.toBe(0);
    expect(
      await readFile(
        join(world.project, ".agents/skills/pdf/SKILL.md"),
        "utf-8",
      ),
    ).toContain("Extract text and tables");
    // The moved row must not read as drifted: its files and its pin agree.
    const status = await run(["status", "skills/pdf", "--json"], world.env);
    const rows = objectItems(jsonOutput(status), "items");
    expect(rows.find((row) => row.name === "pdf")!.state).toBe("ok");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
