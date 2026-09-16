import { expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  jsonOutput,
  runInProcess,
} from "./cli-fixtures";
import { initRemoteProject, skillText, upstreamWith } from "./remote-fixtures";

async function installedFromRemote() {
  const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
  const world = await initRemoteProject();
  const run = runInProcess(world.project);
  expect(
    (await run(["add", upstream.url, "--yes", "--json"], world.env)).exitCode,
  ).toBe(0);
  const remotesPath = join(world.project, ".capshelf", "remotes.lock.json");
  return { upstream, world, run, remotesPath };
}

async function headOf(repo: string): Promise<string> {
  return (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
}

test(
  "adopt transfers a remote row into the shelf and releases it last",
  async () => {
    const { world, run, remotesPath } = await installedFromRemote();
    const result = await run(
      ["share", "skills/pdf", "--adopt", "--json", "-m", "adopt pdf"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    expect(payload.adoptedFrom).toBe("remote");
    expect(payload.previousOwnerReleased).toBe(true);
    expect(payload.committed).toBe(true);

    expect(existsSync(join(world.dataRepo, "skills/pdf/SKILL.md"))).toBe(true);
    const localLock = JSON.parse(
      await readFile(
        join(world.project, ".capshelf", "local.lock.json"),
        "utf-8",
      ),
    );
    expect(localLock.items["data/skills/pdf"]).toBeDefined();
    expect(JSON.parse(await readFile(remotesPath, "utf-8")).items).toEqual({});

    const sidecar = await readFile(
      join(world.dataRepo, "skills/pdf/.capshelf.yml"),
      "utf-8",
    );
    expect(sidecar).toContain("upstream:");
    expect(sidecar).toContain("upstreamCommit:");
    expect(sidecar).toContain("upstreamPath: skills/pdf");
    // The sidecar is committed with the item, not left dirty in the shelf.
    const dirty = await $`git -C ${world.dataRepo} status --porcelain`
      .quiet()
      .text();
    expect(dirty.trim()).toBe("");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "adopt transfers a skills.sh row and keeps every other row and field",
  async () => {
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    await mkdir(join(world.project, ".agents/skills/git-commit"), {
      recursive: true,
    });
    await writeFile(
      join(world.project, ".agents/skills/git-commit/SKILL.md"),
      skillText("git-commit", "Create a git commit"),
    );
    await writeFile(
      join(world.project, "skills-lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            "git-commit": {
              source: "vercel-labs/agent-skills",
              sourceType: "github",
              skillPath: "skills/git-commit/SKILL.md",
              computedHash: "abc",
            },
            impeccable: { source: "pbakaus/impeccable", computedHash: "def" },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await run(
      [
        "share",
        "skills/git-commit",
        "--adopt",
        "--to",
        "project",
        "--json",
        "-m",
        "adopt",
      ],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(result).adoptedFrom).toBe("skills.sh");

    const after = JSON.parse(
      await readFile(join(world.project, "skills-lock.json"), "utf-8"),
    );
    expect(Object.keys(after.skills)).toEqual(["impeccable"]);
    expect(after.version).toBe(1);
    expect(after.skills.impeccable.computedHash).toBe("def");
    const sidecar = await readFile(
      join(world.dataRepo, "skills/git-commit/.capshelf.yml"),
      "utf-8",
    );
    expect(sidecar).toContain("upstream: vercel-labs/agent-skills");
    expect(sidecar).toContain("upstreamPath: skills/git-commit/SKILL.md");
    expect(sidecar).not.toContain("upstreamCommit:");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "identical content already in the data repo reports already-upstream",
  async () => {
    const { world, run, remotesPath } = await installedFromRemote();
    await mkdir(join(world.dataRepo, "skills/pdf"), { recursive: true });
    await writeFile(
      join(world.dataRepo, "skills/pdf/SKILL.md"),
      await readFile(join(world.project, ".agents/skills/pdf/SKILL.md")),
    );
    await $`git -C ${world.dataRepo} add -A`.quiet();
    await $`git -C ${world.dataRepo} commit -qm "same content"`.quiet();
    const head = await headOf(world.dataRepo);

    const result = await run(
      ["share", "skills/pdf", "--adopt", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    expect(payload.action).toBe("already-upstream");
    expect(payload.committed).toBe(false);
    expect(payload.previousOwnerReleased).toBe(true);
    expect(await headOf(world.dataRepo)).toBe(head);
    expect(JSON.parse(await readFile(remotesPath, "utf-8")).items).toEqual({});
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "different content already in the data repo refuses and keeps the owner",
  async () => {
    const { world, run, remotesPath } = await installedFromRemote();
    await mkdir(join(world.dataRepo, "skills/pdf"), { recursive: true });
    await writeFile(
      join(world.dataRepo, "skills/pdf/SKILL.md"),
      skillText("pdf", "Something else entirely"),
    );
    await $`git -C ${world.dataRepo} add -A`.quiet();
    await $`git -C ${world.dataRepo} commit -qm "other content"`.quiet();
    const head = await headOf(world.dataRepo);
    const before = await readFile(remotesPath, "utf-8");

    const result = await run(
      ["share", "skills/pdf", "--adopt", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("skills/pdf");
    expect(message).toMatch(/kept the remote row|ownership was kept/);
    expect(await headOf(world.dataRepo)).toBe(head);
    expect(await readFile(remotesPath, "utf-8")).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a retry after an interruption between step 11 and step 12 converges",
  async () => {
    // Constructed state, not a raced one: the adopt runs to completion, then
    // the remote row is written back by hand.
    const { world, run, remotesPath } = await installedFromRemote();
    const before = await readFile(remotesPath, "utf-8");
    expect(
      (await run(["share", "skills/pdf", "--adopt", "--json"], world.env))
        .exitCode,
    ).toBe(0);
    await writeFile(remotesPath, before);

    const retry = await run(
      ["share", "skills/pdf", "--adopt", "--json"],
      world.env,
    );
    expect(retry.exitCode).toBe(0);
    const payload = jsonOutput(retry);
    expect(payload.action).toBe("already-upstream");
    expect(payload.previousOwnerReleased).toBe(true);
    expect(JSON.parse(await readFile(remotesPath, "utf-8")).items).toEqual({});
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "adopt with no data repo exits 6",
  async () => {
    const { world, run } = await installedFromRemote();
    await rm(join(world.project, ".capshelf", "local.json"));
    const result = await run(["share", "skills/pdf", "--adopt", "--json"], {
      ...world.env,
      CAPSHELF_HOME: undefined,
    });
    expect(result.exitCode).toBe(6);
    expect(result.stderr.toString()).toContain("no data repo configured");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "adopt on a kind other than skills exits 3 and names the kind",
  async () => {
    const world = await initRemoteProject();
    const result = await runInProcess(world.project)(
      ["share", "settings/base", "--adopt", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("settings");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test.each([
  ["--from", "/tmp/x"],
  ["--pick", "a.b"],
  ["--target", "codex"],
])(
  "adopt beside %s exits 3 and names the conflicting flag",
  async (flag, value) => {
    const { world, run } = await installedFromRemote();
    const result = await run(
      ["share", "skills/pdf", "--adopt", flag, value, "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(flag);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "adopt with no previous owner and no lock entry names both places searched",
  async () => {
    const world = await initRemoteProject();
    await mkdir(join(world.project, ".agents/skills/orphan"), {
      recursive: true,
    });
    await writeFile(
      join(world.project, ".agents/skills/orphan/SKILL.md"),
      skillText("orphan", "Nobody owns this"),
    );
    const result = await runInProcess(world.project)(
      ["share", "skills/orphan", "--adopt", "--json"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    const message = result.stderr.toString();
    expect(message).toContain("remotes.lock.json");
    expect(message).toContain("skills-lock.json");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "adopt warns when no license is found in the item or at the repo root",
  async () => {
    const { world, run } = await installedFromRemote();
    const result = await run(["share", "skills/pdf", "--adopt"], world.env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("no license");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "share without --adopt reports the earlier refusal before the missing data repo",
  async () => {
    // The data-repo resolution moved below the lock-key refusals, for both
    // paths, so `share` has one refusal precedence rather than two. This is
    // the one visible change on the path without `--adopt`.
    const world = await initRemoteProject();
    const run = runInProcess(world.project);
    expect((await run(["add", "skills/placeholder", "--json"])).exitCode).toBe(
      0,
    );
    await rm(join(world.project, ".capshelf", "local.json"));
    const result = await run(["share", "skills/placeholder", "--json"], {
      ...world.env,
      CAPSHELF_HOME: undefined,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("already tracked in project");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
