import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
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
    const { upstream, world, run, installPath } = await installed();
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

// Keep the filesystem import visible: the fixtures above assert on real paths.
void existsSync;
void writeFile;
