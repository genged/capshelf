import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideSync,
  formatSyncHuman,
  syncData,
  syncGuidance,
  type SyncFacts,
  type SyncReport,
  type SyncState,
} from "../src/data-sync";

function facts(overrides: Partial<SyncFacts> = {}): SyncFacts {
  return {
    hasOrigin: true,
    fetchOk: true,
    detached: false,
    branch: "main",
    trackingRef: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: false,
    ...overrides,
  };
}

describe("decideSync state table", () => {
  test("up_to_date when nothing moved", () => {
    expect(decideSync(facts())).toEqual({
      state: "up_to_date",
      integrate: false,
      exitCode: 0,
    });
  });

  test("up_to_date even when dirty (dirtiness alone is not an error)", () => {
    expect(decideSync(facts({ dirty: true }))).toEqual({
      state: "up_to_date",
      integrate: false,
      exitCode: 0,
    });
  });

  test("fast_forwarded only when clean, attached, not ahead, behind", () => {
    expect(decideSync(facts({ behind: 3 }))).toEqual({
      state: "fast_forwarded",
      integrate: true,
      exitCode: 0,
    });
  });

  test("local_ahead is exit 0 (unpushed promotes are intentional)", () => {
    expect(decideSync(facts({ ahead: 2 }))).toEqual({
      state: "local_ahead",
      integrate: false,
      exitCode: 0,
    });
  });

  test("local_ahead is unaffected by dirtiness", () => {
    expect(decideSync(facts({ ahead: 2, dirty: true }))).toEqual({
      state: "local_ahead",
      integrate: false,
      exitCode: 0,
    });
  });

  test("diverged when ahead and behind", () => {
    expect(decideSync(facts({ ahead: 2, behind: 3 }))).toEqual({
      state: "diverged",
      integrate: false,
      exitCode: 4,
    });
  });

  test("diverged wins over dirty_worktree when ahead > 0 && behind > 0 && dirty", () => {
    expect(decideSync(facts({ ahead: 2, behind: 3, dirty: true }))).toEqual({
      state: "diverged",
      integrate: false,
      exitCode: 4,
    });
  });

  test("dirty_worktree only when behind > 0 && ahead == 0 && dirty", () => {
    expect(decideSync(facts({ behind: 3, dirty: true }))).toEqual({
      state: "dirty_worktree",
      integrate: false,
      exitCode: 4,
    });
  });

  test("detached_head before any comparison state", () => {
    expect(
      decideSync(
        facts({
          detached: true,
          branch: null,
          ahead: 5,
          behind: 5,
          dirty: true,
        }),
      ),
    ).toEqual({ state: "detached_head", integrate: false, exitCode: 3 });
  });

  test("no_tracking_ref when neither @{upstream} nor origin/<branch> exists", () => {
    expect(
      decideSync(
        facts({ trackingRef: null, ahead: null, behind: null, dirty: true }),
      ),
    ).toEqual({ state: "no_tracking_ref", integrate: false, exitCode: 3 });
  });

  test("no_origin beats everything (fetch never attempted)", () => {
    expect(
      decideSync(
        facts({
          hasOrigin: false,
          fetchOk: false,
          detached: true,
          trackingRef: null,
          dirty: true,
        }),
      ),
    ).toEqual({ state: "no_origin", integrate: false, exitCode: 3 });
  });

  test("fetch_failed beats detached/tracking/comparison states", () => {
    expect(
      decideSync(
        facts({
          fetchOk: false,
          detached: true,
          trackingRef: null,
          dirty: true,
        }),
      ),
    ).toEqual({ state: "fetch_failed", integrate: false, exitCode: 1 });
  });

  test("exhaustive: every fact combination yields a documented state with consistent outputs", () => {
    // Enumerate the full cross product of the discrete fact dimensions.
    // The precedence order itself is pinned by the point tests above; here we
    // assert the invariants that hold across the whole input space: decideSync
    // is total, each state carries its documented exit code, and only
    // fast_forwarded integrates.
    const exits: Record<SyncState, 0 | 1 | 3 | 4> = {
      up_to_date: 0,
      fast_forwarded: 0,
      local_ahead: 0,
      diverged: 4,
      dirty_worktree: 4,
      detached_head: 3,
      no_tracking_ref: 3,
      no_origin: 3,
      fetch_failed: 1,
    };
    let combos = 0;
    for (const hasOrigin of [true, false]) {
      for (const fetchOk of [true, false]) {
        for (const detached of [true, false]) {
          for (const tracking of ["origin/main", null]) {
            for (const ahead of [0, 2]) {
              for (const behind of [0, 3]) {
                for (const dirty of [true, false]) {
                  const f = facts({
                    hasOrigin,
                    fetchOk,
                    detached,
                    trackingRef: tracking,
                    ahead: tracking === null ? null : ahead,
                    behind: tracking === null ? null : behind,
                    dirty,
                  });
                  const decision = decideSync(f);
                  expect(Object.keys(exits)).toContain(decision.state);
                  expect(decision.exitCode).toBe(exits[decision.state]);
                  expect(decision.integrate).toBe(
                    decision.state === "fast_forwarded",
                  );
                  combos++;
                }
              }
            }
          }
        }
      }
    }
    expect(combos).toBe(128);
  });
});

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    dataRepo: "/data",
    origin: "https://example.com/acme/agent-shared",
    branch: "main",
    trackingRef: "origin/main",
    fetched: true,
    state: "up_to_date",
    before: "a".repeat(40),
    after: "a".repeat(40),
    ahead: 0,
    behind: 0,
    dirty: false,
    guidance: "already up to date",
    exitCode: 0,
    ...overrides,
  };
}

describe("formatSyncHuman", () => {
  test("fast_forwarded shows the ff range and next steps", () => {
    const lines = formatSyncHuman(
      report({
        state: "fast_forwarded",
        before: "4f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        after: "8e7d3b2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        behind: 3,
      }),
    ).join("\n");
    expect(lines).toContain("fetched origin:");
    expect(lines).toContain("fast-forwarded main:");
    expect(lines).toContain("4f2a9c1 -> 8e7d3b2  (3 new commits)");
    expect(lines).toContain("capshelf status");
    expect(lines).toContain("capshelf update <item>");
  });

  test("local_ahead prints push guidance and no failure marker", () => {
    const lines = formatSyncHuman(
      report({ state: "local_ahead", ahead: 2 }),
    ).join("\n");
    expect(lines).toContain("ahead of origin/main by 2 commits");
    expect(lines).toContain("git -C /data push");
    expect(lines).not.toContain("✗");
  });

  test("diverged prints the fetched header before the failure", () => {
    const lines = formatSyncHuman(
      report({ state: "diverged", ahead: 2, behind: 3, exitCode: 4 }),
    );
    expect(lines[0]).toBe("fetched origin:");
    expect(lines.join("\n")).toContain(
      "✗ main and origin/main have diverged (2 local commits, 3 upstream commits).",
    );
    expect(lines.join("\n")).toContain("rebase origin/main");
  });

  test("dirty_worktree names the blocked fast-forward", () => {
    const lines = formatSyncHuman(
      report({ state: "dirty_worktree", behind: 3, dirty: true, exitCode: 4 }),
    ).join("\n");
    expect(lines).toContain("origin/main has 3 new commits");
    expect(lines).toContain("status --short");
  });

  test("no_origin skips the fetched header entirely", () => {
    const lines = formatSyncHuman(
      report({
        state: "no_origin",
        origin: null,
        fetched: false,
        branch: null,
        trackingRef: null,
        before: null,
        after: null,
        ahead: null,
        behind: null,
        exitCode: 3,
      }),
    );
    expect(lines[0]).toContain("no `origin` remote");
    expect(lines.join("\n")).toContain("remote add origin <url>");
  });

  test("fetch_failed includes git stderr", () => {
    const lines = formatSyncHuman(
      report({
        state: "fetch_failed",
        fetched: false,
        branch: null,
        trackingRef: null,
        before: null,
        after: null,
        ahead: null,
        behind: null,
        fetchStderr: "fatal: unable to access remote",
        exitCode: 1,
      }),
    ).join("\n");
    expect(lines).toContain("✗ failed to fetch origin for /data");
    expect(lines).toContain("    fatal: unable to access remote");
  });

  test("detached_head and no_tracking_ref print branch fixes", () => {
    expect(
      formatSyncHuman(
        report({ state: "detached_head", branch: null, trackingRef: null }),
      ).join("\n"),
    ).toContain("detached HEAD");
    expect(
      formatSyncHuman(
        report({
          state: "no_tracking_ref",
          branch: "propose/foo",
          trackingRef: null,
          ahead: null,
          behind: null,
        }),
      ).join("\n"),
    ).toContain("push -u origin propose/foo");
  });
});

async function configUser(repo: string): Promise<void> {
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
}

/**
 * A local bare origin plus two clones: `seed` (used to advance origin) and
 * `clone` (the bound data repo syncData operates on). Both start at the same
 * single commit on main, with `clone` tracking origin/main.
 */
async function syncFixture(prefix: string): Promise<{
  seed: string;
  clone: string;
}> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const clone = join(base, "clone");

  await $`git init -q --bare -b main ${origin}`.quiet();

  await $`git init -q -b main ${seed}`.quiet();
  await configUser(seed);
  await Bun.write(join(seed, "skills.md"), "v1\n");
  await $`git -C ${seed} add skills.md`.quiet();
  await $`git -C ${seed} commit -qm initial`.quiet();
  await $`git -C ${seed} remote add origin ${origin}`.quiet();
  await $`git -C ${seed} push -q -u origin main`.quiet();

  await $`git clone -q ${origin} ${clone}`.quiet();
  await configUser(clone);
  return { seed, clone };
}

/** Commit `file` in the seed clone and push, advancing origin/main. */
async function advanceOrigin(
  seed: string,
  file: string,
  content: string,
): Promise<string> {
  await Bun.write(join(seed, file), content);
  await $`git -C ${seed} add ${file}`.quiet();
  await $`git -C ${seed} commit -qm advance`.quiet();
  await $`git -C ${seed} push -q origin main`.quiet();
  return (await $`git -C ${seed} rev-parse HEAD`.quiet().text()).trim();
}

async function headOf(repo: string): Promise<string> {
  return (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
}

describe("syncData I/O orchestration", () => {
  test("fast-forwards a clean clone that is behind origin and moves HEAD", async () => {
    const { seed, clone } = await syncFixture("capshelf-sync-ff-");
    const before = await headOf(clone);
    const upstreamSha = await advanceOrigin(seed, "new-skill.md", "v2\n");
    expect(upstreamSha).not.toBe(before);

    const report = await syncData(clone);

    expect(report.state).toBe("fast_forwarded");
    expect(report.exitCode).toBe(0);
    expect(report.fetched).toBe(true);
    expect(report.branch).toBe("main");
    expect(report.trackingRef).toBe("origin/main");
    expect(report.before).toBe(before);
    expect(report.after).toBe(upstreamSha);
    expect(report.ahead).toBe(0);
    expect(report.behind).toBe(1);
    expect(report.dirty).toBe(false);

    // HEAD actually moved and the new commit's content landed in the worktree.
    expect(await headOf(clone)).toBe(upstreamSha);
    expect(await Bun.file(join(clone, "new-skill.md")).text()).toBe("v2\n");
  });

  test("dirty worktree behind origin: reports dirty_worktree and moves nothing", async () => {
    const { seed, clone } = await syncFixture("capshelf-sync-dirty-");
    const before = await headOf(clone);
    await advanceOrigin(seed, "new-skill.md", "v2\n");
    await Bun.write(join(clone, "skills.md"), "local edit\n");

    const report = await syncData(clone);

    expect(report.state).toBe("dirty_worktree");
    expect(report.exitCode).toBe(4);
    expect(report.dirty).toBe(true);
    expect(report.behind).toBe(1);
    expect(report.before).toBe(before);
    expect(report.after).toBe(before);

    // HEAD did not move, the dirty file is untouched, and the upstream
    // commit's file was not materialized in the worktree.
    expect(await headOf(clone)).toBe(before);
    expect(await Bun.file(join(clone, "skills.md")).text()).toBe(
      "local edit\n",
    );
    expect(await Bun.file(join(clone, "new-skill.md")).exists()).toBe(false);
  });
});

describe("syncGuidance", () => {
  test("names the remedial action for each state", () => {
    // guidance ships verbatim in the --json report, so each state must point
    // the user at its actual remedy.
    const g = (state: SyncState) => syncGuidance(state, "/data");
    expect(g("up_to_date")).toContain("up to date");
    expect(g("fast_forwarded")).toContain("capshelf status");
    expect(g("local_ahead")).toContain("git -C /data push");
    expect(g("diverged")).toContain("rebase or merge");
    expect(g("dirty_worktree")).toContain("stash");
    expect(g("detached_head")).toContain("check out a branch");
    expect(g("no_tracking_ref")).toContain("push the branch");
    expect(g("no_origin")).toContain("git -C /data remote add origin");
    expect(g("fetch_failed")).toContain("authentication");
  });
});
