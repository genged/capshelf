import { describe, expect, test } from "bun:test";
import {
  decideSync,
  formatSyncHuman,
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

  test("exhaustive: every fact combination maps to exactly the documented state", () => {
    // Enumerate the full cross product of the discrete fact dimensions and
    // assert the normative precedence order resolves each one.
    const expected = (f: SyncFacts): SyncState => {
      if (!f.hasOrigin) return "no_origin";
      if (!f.fetchOk) return "fetch_failed";
      if (f.detached) return "detached_head";
      if (f.trackingRef === null) return "no_tracking_ref";
      const ahead = f.ahead ?? 0;
      const behind = f.behind ?? 0;
      if (ahead > 0 && behind > 0) return "diverged";
      if (f.dirty && behind > 0) return "dirty_worktree";
      if (ahead > 0) return "local_ahead";
      if (behind > 0) return "fast_forwarded";
      return "up_to_date";
    };
    const exits: Record<SyncState, number> = {
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
                  const state = expected(f);
                  expect(decision.state).toBe(state);
                  expect(decision.exitCode).toBe(exits[state] as 0 | 1 | 3 | 4);
                  expect(decision.integrate).toBe(state === "fast_forwarded");
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

describe("syncGuidance", () => {
  test("covers every state with a one-liner", () => {
    const states: SyncState[] = [
      "up_to_date",
      "fast_forwarded",
      "local_ahead",
      "diverged",
      "dirty_worktree",
      "detached_head",
      "no_tracking_ref",
      "no_origin",
      "fetch_failed",
    ];
    for (const state of states) {
      expect(syncGuidance(state, "/data").length).toBeGreaterThan(0);
    }
  });
});
