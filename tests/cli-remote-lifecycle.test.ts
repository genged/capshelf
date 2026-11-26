import { $ } from "bun";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addSkill,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectField,
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
import { setDestructiveConfirmationContext } from "../src/destructive-change";

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
    // The cache must hold something newer than the pin, or an implementation
    // that moved every remote pin would pass anyway.
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
    // `fetchOrigin` reports failure instead of throwing, so exit 0 proves
    // nothing; count git invocations instead.
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
    // `--json` names a scripted caller but does not answer the consent question
    // for a commit; `--yes` does.
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
    // A merge must report as a merge, since "updated" would hide that a local
    // edit was reconciled and drop the review command.
    expect(out).toContain("merged upstream into installed copy");
    expect(out).toContain("capshelf status skills/pdf --diff-view installed");
    expect(out).not.toContain("--local");
    // The merge must move the pin as well as the files, or the row reads as
    // drift the merge itself created.
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
    // With the locked file set unknown, every installed path may be the user's,
    // so each is named and deleted only with consent.
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
    // The `share --adopt` refusal must come first, or a project with remote
    // rows and no data binding exits 6 about a shelf it never had.
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
    // Asserts the preview reports the row, since a do-nothing command would
    // pass the dry-run no-change test trivially.
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

test.each([
  ["plain", ["update", "skills/pdf"]],
  ["merge", ["update", "skills/pdf", "--merge"]],
])(
  "%s update --dry-run reports the digest a real update locks",
  async (_mode, args) => {
    const { upstream, world, run, lockPath, installPath } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const lockBefore = await readFile(lockPath, "utf-8");
    const skillBefore = await readFile(join(installPath, "SKILL.md"), "utf-8");

    const dry = await run([...args, "--dry-run", "--json"], world.env);
    expect(dry.exitCode).toBe(0);
    const dryRow = objectItems(jsonOutput(dry), "items").find(
      (row) => row.key === "remote/skills/pdf",
    )!;
    expect(dryRow.action).toBe("would-update");
    expect(dryRow.plannedSha).not.toBe(dryRow.lockedSha);
    expect(dryRow.sha).toBe(dryRow.plannedSha);
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      skillBefore,
    );

    const real = await run([...args, "--yes", "--json"], world.env);
    expect(real.exitCode).toBe(0);
    const realRow = objectItems(jsonOutput(real), "items").find(
      (row) => row.key === "remote/skills/pdf",
    )!;
    expect(realRow.action).toBe("updated");
    expect(dryRow.plannedSha).toBe(realRow.plannedSha);
    expect(dryRow.lockedSha).toBe(realRow.lockedSha);
    const lock = JSON.parse(await readFile(lockPath, "utf-8"));
    expect(lock.items["remote/skills/pdf"].sourcePinDigest).toBe(
      dryRow.plannedSha,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "merge --dry-run on a locally edited copy reports the digest a real merge locks",
  async () => {
    const { upstream, world, run, lockPath, installPath } = await installed();
    await appendFile(join(installPath, "SKILL.md"), "\n- ask about rollback\n");
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
    const lockBefore = await readFile(lockPath, "utf-8");
    const skillBefore = await readFile(join(installPath, "SKILL.md"), "utf-8");
    const args = ["update", "skills/pdf", "--merge"];

    const dry = await run([...args, "--dry-run", "--json"], world.env);
    expect(dry.exitCode).toBe(0);
    const dryRow = objectItems(jsonOutput(dry), "items").find(
      (row) => row.key === "remote/skills/pdf",
    )!;
    expect(dryRow.action).toBe("would-merge");
    expect(dryRow.plannedSha).not.toBe(dryRow.lockedSha);
    expect(dryRow.sha).toBe(dryRow.plannedSha);
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      skillBefore,
    );

    const real = await run([...args, "--yes", "--json"], world.env);
    expect(real.exitCode).toBe(0);
    const realRow = objectItems(jsonOutput(real), "items").find(
      (row) => row.key === "remote/skills/pdf",
    )!;
    expect(realRow.action).toBe("merged");
    expect(dryRow.plannedSha).toBe(realRow.plannedSha);
    const lock = JSON.parse(await readFile(lockPath, "utf-8"));
    expect(lock.items["remote/skills/pdf"].sourcePinDigest).toBe(
      dryRow.plannedSha,
    );
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
    // A shelf lock saved after the remote pass throws is never saved, leaving
    // item files ahead of their pin and reverted by the next `apply`.
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
    // The exclude must go before the adopt reads the item: a project-scope
    // adopt snapshots through project Git, which sees an excluded install path
    // as empty.
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
    // Exit 0 alone would pass on an adopt that committed an empty tree, so
    // assert the shelf copy.
    expect(
      await readFile(join(world.dataRepo, "skills/pdf/SKILL.md"), "utf-8"),
    ).toContain("name: pdf");
    // A path still in `.git/info/exclude` is skipped by `git add -A` and
    // misclassifies unpinned extras, because project scope reads Git's whole
    // ignore stack.
    expect(await readFile(excludePath, "utf-8")).not.toContain(
      ".agents/skills/pdf/",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a cold cache reports an unreadable source, not a missing install",
  async () => {
    // A cold cache with intact files must not report `missing_installed`: it
    // points to `capshelf apply`, which refuses on a cold cache, a dead end.
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
    // The second check must replace the digest, not merge: a carried-over
    // digest leaves a deleted skill reading `ok` forever.
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
    const { world, run } = await installed();
    await rm(cacheRootOf(world), { recursive: true });

    const result = await run(["apply", "--yes", "--json"], world.env);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("capshelf status --check-upstream");
    expect(output).not.toContain("not a git repository");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test.each([["apply"], ["update"]])(
  "%s refuses a bare ref that names a shelf item and a remote skill",
  async (verb) => {
    // `add <url>` only checks `skills/<name>` against the locks, so a project
    // can hold `pi-extensions/pdf` and pull `skills/pdf`; the bare ref must not
    // silently resolve to the remote row.
    const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    const extension = join(world.dataRepo, "pi/extensions/pdf");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default {};\n");
    await commitAll(world.dataRepo, "add a pi extension named pdf");
    expect(
      (await run(["add", "pi-extensions/pdf", "--json"], world.env)).exitCode,
    ).toBe(0);
    expect(
      (await run(["add", upstream.url, "--yes", "--json"], world.env)).exitCode,
    ).toBe(0);

    const result = await run([verb, "pdf", "--yes", "--json"], world.env);
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("ambiguous item");
    expect(message).toContain("pi-extensions/pdf");
    expect(message).toContain("remote/skills/pdf");

    expect(
      (await run([verb, "pi-extensions/pdf", "--yes", "--json"], world.env))
        .exitCode,
    ).toBe(0);
    expect(
      (await run([verb, "skills/pdf", "--yes", "--json"], world.env)).exitCode,
    ).toBe(0);

    // Each named kind must reach its own population; the shelf pass must not
    // drop an mcp-shaped ref because the skill matched a remote row.
    if (verb !== "update") return;
    const both = await run(
      [verb, "skills/pdf", "pi-extensions/pdf", "--yes", "--json"],
      world.env,
    );
    expect(both.exitCode).toBe(0);
    const keys = objectItems(jsonOutput(both), "items").map((row) => row.key);
    expect(keys).toContain("remote/skills/pdf");
    expect(keys).toContain("data/pi-extensions/pdf");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a pin move deletes a hidden path the new commit dropped",
  async () => {
    // Without the previous pin, a dropped file hidden by the item's
    // `.gitignore` is classified as the user's and copied forward. The commit
    // also edits `SKILL.md` so a write happens; otherwise the test passes
    // against both implementations.
    const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
    await writeFile(join(upstream.work, "skills/pdf/helper.sh"), "echo old\n");
    await commitAll(upstream.work, "ship a helper");
    // The pin reads the tree, so the ignored helper stays pinned; only
    // install-side classification treats it as hidden.
    await writeFile(join(upstream.work, "skills/pdf/.gitignore"), "*.sh\n");
    await commitAll(upstream.work, "ignore shell helpers inside the item");
    await $`git -C ${upstream.work} push -q origin main`.quiet();

    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    expect(
      (await run(["add", upstream.url, "--yes", "--json"], world.env)).exitCode,
    ).toBe(0);
    const helper = join(world.project, ".agents/skills/pdf/helper.sh");
    expect(existsSync(helper)).toBe(true);

    await rm(join(upstream.work, "skills/pdf/helper.sh"));
    await writeFile(
      join(upstream.work, "skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: Extract text and tables\n---\nbody\n",
    );
    await commitAll(upstream.work, "drop the helper and revise the skill");
    await $`git -C ${upstream.work} push -q origin main`.quiet();
    await run(["status", "--check-upstream", "--json"], world.env);
    expect(
      (await run(["update", "skills/pdf", "--yes", "--json"], world.env))
        .exitCode,
    ).toBe(0);

    expect(existsSync(helper)).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "status --diff reports the pin a remote skill is locked to",
  async () => {
    const { world, run, installPath } = await installed();
    await appendFile(join(installPath, "SKILL.md"), "\n- local note\n");

    const result = await run(
      ["status", "skills/pdf", "--diff", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const report = jsonOutput(result);
    const row = objectItems(report, "items").find(
      (candidate) => candidate.name === "pdf",
    )!;
    const from = objectField(objectItems(report, "diffs")[0]!, "from");
    expect(from.sha).toBe(row.lockedSha);
    expect(from.sha).not.toBeNull();
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "share without --adopt refuses a remote skill instead of making two owners",
  async () => {
    // A plain share would commit the bytes but leave the remote row, the state
    // status labels "an adopt did not finish".
    const { world, run, lockPath } = await installed();
    const before = await readFile(lockPath, "utf-8");

    const result = await run(
      ["share", "skills/pdf", "--json", "-m", "share pdf"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "capshelf share skills/pdf --adopt",
    );
    expect(existsSync(join(world.dataRepo, "skills/pdf"))).toBe(false);
    expect(await readFile(lockPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a failed project-scope share puts the exclude line back",
  async () => {
    // If the adopt fails, the install path stays owned by the remote row and
    // must stay excluded, or the next `git add -A` commits clone-local files.
    const { world, run } = await installed();
    const excludePath = join(world.project, ".git/info/exclude");
    // A dirty data repo fails the adopt after the exclude is dropped.
    await writeFile(join(world.dataRepo, "stray.txt"), "uncommitted\n");

    const result = await run(
      ["share", "skills/pdf", "--adopt", "--to", "project", "--json"],
      world.env,
    );
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(excludePath, "utf-8")).toContain(
      ".agents/skills/pdf/",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a second add from a cached repository pins what the upstream holds now",
  async () => {
    // `ensureClone` clones once and never fetches, so a second install must
    // refresh the cache or it pins a stale commit.
    const upstream = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    expect(
      (
        await run(
          ["add", upstream.url, "--path", "skills/pdf", "--yes", "--json"],
          world.env,
        )
      ).exitCode,
    ).toBe(0);

    await pushChange(upstream, "skills/xlsx", "Read workbooks and charts");
    expect(
      (
        await run(
          ["add", upstream.url, "--path", "skills/xlsx", "--yes", "--json"],
          world.env,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      await readFile(
        join(world.project, ".agents/skills/xlsx/SKILL.md"),
        "utf-8",
      ),
    ).toContain("Read workbooks and charts");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "re-adding a moved upstream names update, not a different repository",
  async () => {
    const { upstream, world, run } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");

    const result = await run(
      ["add", upstream.url, "--path", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("capshelf update skills/pdf");
    expect(message).not.toContain("a different repository");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "add names apply when the record is current but the install is gone",
  async () => {
    // "Already current" beside a missing path would make the obvious repair
    // command a silent no-op.
    const { upstream, world, run, installPath } = await installed();
    await rm(installPath, { recursive: true });

    const result = await run(
      ["add", upstream.url, "--path", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("capshelf apply skills/pdf");
    expect(message).not.toContain("already-current");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test.each([["apply"], ["update"]])(
  "%s refuses skills/<name> when the shelf and a remote row both own it",
  async (verb) => {
    // Reconstructs the unfinished-adopt state (a crash after the shelf lock
    // write but before the remote row is released) from a real record. Every
    // remote row is kind `skills`, so naming the kind does not disambiguate.
    const { world, run, lockPath } = await installed();
    const beforeAdopt = await readFile(lockPath, "utf-8");
    expect(
      (
        await run(
          ["share", "skills/pdf", "--adopt", "--json", "-m", "adopt pdf"],
          world.env,
        )
      ).exitCode,
    ).toBe(0);
    await writeFile(lockPath, beforeAdopt);

    const status = await run(["status", "skills/pdf", "--json"], world.env);
    const remoteRow = objectItems(jsonOutput(status), "items").find(
      (row) => row.source === "remote",
    );
    expect(remoteRow).toBeDefined();
    expect(objectField(remoteRow!, "remote").alsoTrackedInShelf).toBe(true);

    const result = await run(
      [verb, "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("ambiguous item");
    expect(message).toContain("remote/skills/pdf");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a converging adopt does not claim provenance the shelf copy lacks",
  async () => {
    // `adoptIntoDataRepo` returns `already-upstream` before writing the
    // sidecar, so "provenance recorded" must not print when the shelf copy
    // carries none.
    const { upstream, world, run } = await installed();
    const body = await readFile(
      join(world.project, ".agents/skills/pdf/SKILL.md"),
      "utf-8",
    );
    await addSkill(world.dataRepo, "pdf", body);
    await commitAll(world.dataRepo, "the same bytes, with no provenance");

    const result = await run(
      ["share", "skills/pdf", "--adopt", "-m", "adopt pdf"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("no provenance");
    expect(out).toContain(upstream.url);
    expect(out).not.toContain("provenance recorded");
    expect(existsSync(join(world.dataRepo, "skills/pdf/.capshelf.yml"))).toBe(
      false,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a pin move onto a cache the check never saw clears the stale measurement",
  async () => {
    // A warm cache can pass the head the last check recorded; carrying that
    // digest across the move leaves a stale `update_available` that fails
    // --strict.
    const upstream = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    await run(
      ["add", upstream.url, "--path", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);

    await pushChange(upstream, "skills/pdf", "Extract text, tables, and forms");
    await run(
      ["add", upstream.url, "--path", "skills/xlsx", "--yes", "--json"],
      world.env,
    );
    expect(
      (await run(["update", "skills/pdf", "--yes", "--json"], world.env))
        .exitCode,
    ).toBe(0);

    const status = await run(["status", "skills/pdf", "--json"], world.env);
    expect(
      objectItems(jsonOutput(status), "items").find(
        (row) => row.name === "pdf",
      )!.state,
    ).toBe("ok");
    expect(
      (await run(["status", "--strict", "--json"], world.env)).exitCode,
    ).toBe(0);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "rm refuses a name the shelf and a remote copy both own",
  async () => {
    // The shelf path must not win: it would delete the install and lock entry
    // while the remote row survives, so the next `apply` reinstalls the skill.
    const { world, run, lockPath, installPath } = await installed();
    const beforeAdopt = await readFile(lockPath, "utf-8");
    expect(
      (
        await run(
          ["share", "skills/pdf", "--adopt", "--json", "-m", "adopt pdf"],
          world.env,
        )
      ).exitCode,
    ).toBe(0);
    await writeFile(lockPath, beforeAdopt);

    const result = await run(
      ["rm", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("both own it");
    expect(existsSync(installPath)).toBe(true);
    expect(await readFile(lockPath, "utf-8")).toBe(beforeAdopt);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the consent prompt cannot be repainted by repository-controlled text",
  async () => {
    // The prompt is the gate authorizing third-party code, so
    // repository-supplied names and descriptions must not be able to emit ESC
    // into it.
    const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
    await writeFile(
      join(upstream.work, "skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: safe\u001b[2Kfaked\n---\nbody\n",
    );
    await writeFile(
      join(upstream.work, "skills/pdf/no\u001b[31mtes.md"),
      "hidden\n",
    );
    await commitAll(upstream.work, "escape sequences in a name and a summary");
    await $`git -C ${upstream.work} push -q origin main`.quiet();

    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    const listed = await run(
      ["add", upstream.url, "--path", "skills/pdf", "--list"],
      world.env,
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).not.toContain("\u001b");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "apply and update leave a remote skill alone once skills.sh claims the name",
  async () => {
    // skills.sh can claim the name after install and both tools write
    // `.agents/skills/pdf`, so reconciling anyway would overwrite the other
    // tool's content.
    const { world, run, installPath } = await installed();
    await writeFile(
      join(world.project, "skills-lock.json"),
      JSON.stringify(
        { skills: { pdf: { source: "https://skills.sh/pdf", version: "1" } } },
        null,
        2,
      ),
    );
    await writeFile(join(installPath, "SKILL.md"), "owned by skills.sh\n");

    const applied = await run(["apply", "--yes", "--json"], world.env);
    const rows = objectItems(jsonOutput(applied), "items");
    expect(rows.find((row) => row.key === "remote/skills/pdf")!.action).toBe(
      "skipped-external",
    );
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      "owned by skills.sh\n",
    );

    const updated = await run(
      ["update", "skills/pdf", "--yes", "--json"],
      world.env,
    );
    expect(updated.exitCode).toBe(3);
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      "owned by skills.sh\n",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a check records a deleted branch instead of keeping the old measurement",
  async () => {
    const { upstream, world, run, lockPath } = await installed();
    await run(["status", "--check-upstream", "--json"], world.env);

    // Without pruning, the cache keeps resolving a deleted branch from its
    // stale remote-tracking ref and reports it healthy.
    const bare = upstream.url.replace("file://", "");
    await $`git -C ${upstream.work} branch -M main retired`.quiet();
    await $`git -C ${upstream.work} push -q origin retired`.quiet();
    // The bare repo refuses to delete the branch its HEAD points at.
    await $`git -C ${bare} symbolic-ref HEAD refs/heads/retired`.quiet();
    await $`git -C ${upstream.work} push -q origin --delete main`.quiet();

    expect(
      (await run(["status", "--check-upstream", "--json"], world.env)).exitCode,
    ).toBe(0);
    const lock = JSON.parse(await readFile(lockPath, "utf-8"));
    expect(lock.items["remote/skills/pdf"].upstreamHead).toBeUndefined();
    expect(lock.items["remote/skills/pdf"].lastChecked).toBeDefined();
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
  "an edit made while the update prompt is open aborts the write",
  async () => {
    // The loss summary is computed before the prompt wait, so the write must
    // recheck that it still describes the tree.
    const { upstream, world, run, installPath } = await installed();
    await pushChange(upstream, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);

    const outer = setDestructiveConfirmationContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async () => {
        await writeFile(join(installPath, "SKILL.md"), "edited mid-prompt\n");
        return "y";
      },
      stderr: { write: () => {} },
    });
    const result = await (async () => {
      try {
        return await run(["update", "skills/pdf"], world.env);
      } finally {
        setDestructiveConfirmationContext(outer);
      }
    })();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("local state changed");
    expect(await readFile(join(installPath, "SKILL.md"), "utf-8")).toBe(
      "edited mid-prompt\n",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a refusal on the second named row keeps the first row's moved pin recorded",
  async () => {
    const moving = await upstreamWith([["skills/pdf", "Extract text"]]);
    const stalled = await upstreamWith([["skills/sql-review", "Review SQL"]]);
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    await run(["add", moving.url, "--yes", "--json"], world.env);
    await run(["add", stalled.url, "--yes", "--json"], world.env);
    await pushChange(moving, "skills/pdf", "Extract text and tables");
    await run(["status", "--check-upstream", "--json"], world.env);
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
    const status = await run(["status", "skills/pdf", "--json"], world.env);
    const rows = objectItems(jsonOutput(status), "items");
    expect(rows.find((row) => row.name === "pdf")!.state).toBe("ok");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
