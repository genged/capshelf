import { describe, expect, test } from "bun:test";
import {
  assertNoScopeCollisions,
  buildStatusRow,
  deriveState,
  personalClaudeExternals,
  statusTargets,
  type StateFacts,
  type StatusRow,
} from "../src/status-core";
import type { Lock, LockEntry } from "../src/lock";
import type { RuntimeWarning } from "../src/runtime-warnings";

function facts(overrides: Partial<StateFacts> = {}): StateFacts {
  return {
    kind: "skills",
    source: "data",
    local: false,
    lockedSha: "L",
    currentSha: "L",
    upstreamSha: "L",
    upstreamDirty: false,
    fragmentOutputState: null,
    ...overrides,
  };
}

describe("deriveState", () => {
  test("ok when current and upstream match the lock", () => {
    expect(deriveState(facts())).toBe("ok");
  });

  test("update_available when only upstream moved", () => {
    expect(deriveState(facts({ upstreamSha: "U" }))).toBe("update_available");
  });

  test("drifted_local when only the install drifted", () => {
    expect(deriveState(facts({ currentSha: "C" }))).toBe("drifted_local");
  });

  test("drifted_and_update when install and upstream both moved", () => {
    expect(deriveState(facts({ currentSha: "C", upstreamSha: "U" }))).toBe(
      "drifted_and_update",
    );
  });

  test("missing_installed when the install is gone", () => {
    expect(deriveState(facts({ currentSha: null }))).toBe("missing_installed");
  });

  test("missing_upstream when upstream is gone", () => {
    expect(deriveState(facts({ upstreamSha: null }))).toBe("missing_upstream");
  });

  test("upstream_dirty when the data repo is dirty and install matches", () => {
    expect(deriveState(facts({ upstreamDirty: true }))).toBe("upstream_dirty");
  });

  test("drifted_and_upstream_dirty when dirty upstream and drifted install", () => {
    expect(deriveState(facts({ upstreamDirty: true, currentSha: "C" }))).toBe(
      "drifted_and_upstream_dirty",
    );
  });

  test("kept-local for a pinned data entry with an install present", () => {
    expect(deriveState(facts({ local: true }))).toBe("kept-local");
  });

  test("kept-local takes precedence over fragment/dirty signals", () => {
    expect(
      deriveState(
        facts({
          kind: "settings",
          local: true,
          upstreamDirty: true,
          fragmentOutputState: "drifted",
        }),
      ),
    ).toBe("kept-local");
  });

  test("source_dirty for a dirty fragment with clean output", () => {
    expect(
      deriveState(
        facts({
          kind: "settings",
          upstreamDirty: true,
          fragmentOutputState: "ok",
        }),
      ),
    ).toBe("source_dirty");
  });

  test("source_dirty_and_output_drift for a dirty fragment with drifted output", () => {
    expect(
      deriveState(
        facts({
          kind: "settings",
          upstreamDirty: true,
          fragmentOutputState: "drifted",
        }),
      ),
    ).toBe("source_dirty_and_output_drift");
  });

  test("missing_output for a fragment whose output is gone", () => {
    expect(
      deriveState(facts({ kind: "settings", fragmentOutputState: "missing" })),
    ).toBe("missing_output");
  });

  test("output_drift for a drifted fragment output with no upstream update", () => {
    expect(
      deriveState(
        facts({
          kind: "settings",
          fragmentOutputState: "drifted",
          upstreamSha: "L",
        }),
      ),
    ).toBe("output_drift");
  });

  test("drifted_and_update for a drifted fragment output with an upstream update", () => {
    expect(
      deriveState(
        facts({
          kind: "settings",
          fragmentOutputState: "drifted",
          upstreamSha: "U",
        }),
      ),
    ).toBe("drifted_and_update");
  });

  test("local pin without an install does not count as kept-local", () => {
    expect(deriveState(facts({ local: true, currentSha: null }))).toBe(
      "missing_installed",
    );
  });

  test("missing_source_commit when the pinned commit is unreachable", () => {
    expect(deriveState(facts({ sourceCommitPresent: false }))).toBe(
      "missing_source_commit",
    );
  });

  test("missing_source_commit wins over every drift/update comparison", () => {
    expect(
      deriveState(
        facts({
          sourceCommitPresent: false,
          currentSha: "C",
          upstreamSha: "U",
          upstreamDirty: true,
        }),
      ),
    ).toBe("missing_source_commit");
    expect(
      deriveState(
        facts({
          kind: "settings",
          sourceCommitPresent: false,
          upstreamDirty: true,
          fragmentOutputState: "drifted",
        }),
      ),
    ).toBe("missing_source_commit");
    expect(
      deriveState(facts({ sourceCommitPresent: false, currentSha: null })),
    ).toBe("missing_source_commit");
  });

  test("kept-local still wins over a missing source commit", () => {
    expect(
      deriveState(facts({ local: true, sourceCommitPresent: false })),
    ).toBe("kept-local");
  });

  test("system entries never report missing_source_commit", () => {
    expect(
      deriveState(facts({ source: "system", sourceCommitPresent: false })),
    ).toBe("ok");
  });

  test("present and unknown reachability leave every existing case unchanged", () => {
    const cases: Array<[Partial<StateFacts>, string]> = [
      [{}, "ok"],
      [{ upstreamSha: "U" }, "update_available"],
      [{ currentSha: "C" }, "drifted_local"],
      [{ currentSha: "C", upstreamSha: "U" }, "drifted_and_update"],
      [{ currentSha: null }, "missing_installed"],
      [{ upstreamSha: null }, "missing_upstream"],
      [{ upstreamDirty: true }, "upstream_dirty"],
      [{ upstreamDirty: true, currentSha: "C" }, "drifted_and_upstream_dirty"],
      [{ local: true }, "kept-local"],
      [
        { kind: "settings", upstreamDirty: true, fragmentOutputState: "ok" },
        "source_dirty",
      ],
      [
        {
          kind: "settings",
          upstreamDirty: true,
          fragmentOutputState: "drifted",
        },
        "source_dirty_and_output_drift",
      ],
      [{ kind: "settings", fragmentOutputState: "missing" }, "missing_output"],
      [
        { kind: "settings", fragmentOutputState: "drifted", upstreamSha: "L" },
        "output_drift",
      ],
      [
        { kind: "settings", fragmentOutputState: "drifted", upstreamSha: "U" },
        "drifted_and_update",
      ],
    ];
    for (const [overrides, expected] of cases) {
      expect(
        deriveState(facts({ ...overrides, sourceCommitPresent: true })),
      ).toBe(expected as ReturnType<typeof deriveState>);
      expect(
        deriveState(facts({ ...overrides, sourceCommitPresent: null })),
      ).toBe(expected as ReturnType<typeof deriveState>);
      expect(deriveState(facts(overrides))).toBe(
        expected as ReturnType<typeof deriveState>,
      );
    }
  });
});

function lock(items: Record<string, LockEntry>): Lock {
  return { version: 2, items };
}

const dataEntry: LockEntry = {
  source: "data",
  sha: "L",
  sourceCommit: "c1",
  appliedAt: "t",
};

describe("statusTargets", () => {
  const projectLock = lock({ "data:skills:a": dataEntry });
  const localLock = lock({ "data:skills:b": dataEntry });

  test("includes both scopes by default", () => {
    expect(statusTargets(projectLock, localLock, undefined, {})).toEqual([
      { scope: "project", key: "data:skills:a" },
      { scope: "local", key: "data:skills:b" },
    ]);
  });

  test("--project keeps only project items", () => {
    expect(
      statusTargets(projectLock, localLock, undefined, { project: true }),
    ).toEqual([{ scope: "project", key: "data:skills:a" }]);
  });

  test("--local keeps only clone-local items", () => {
    expect(
      statusTargets(projectLock, localLock, undefined, { local: true }),
    ).toEqual([{ scope: "local", key: "data:skills:b" }]);
  });
});

describe("assertNoScopeCollisions", () => {
  test("passes when scopes are disjoint", () => {
    expect(() =>
      assertNoScopeCollisions(
        lock({ "data:skills:a": dataEntry }),
        lock({ "data:skills:b": dataEntry }),
      ),
    ).not.toThrow();
  });

  test("throws when a key is owned by both scopes", () => {
    expect(() =>
      assertNoScopeCollisions(
        lock({ "data:skills:a": dataEntry }),
        lock({ "data:skills:a": dataEntry }),
      ),
    ).toThrow(/owned by both project and local scope: data:skills:a/);
    expect(() =>
      assertNoScopeCollisions(
        lock({ "data:skills:a": dataEntry }),
        lock({ "data:skills:a": dataEntry }),
      ),
    ).toThrow(/remove one owner before checking status/);
  });

  test("names the caller's action in the message", () => {
    expect(() =>
      assertNoScopeCollisions(
        lock({ "data:skills:a": dataEntry }),
        lock({ "data:skills:a": dataEntry }),
        "applying",
      ),
    ).toThrow(/remove one owner before applying/);
  });
});

describe("buildStatusRow", () => {
  test("assembles a data row with optional fields and warnings", () => {
    const entry: LockEntry = {
      source: "data",
      sha: "L",
      sourceCommit: "c1",
      appliedAt: "t",
      label: "lbl",
      local: true,
      localReason: "why",
    };
    expect(
      buildStatusRow({
        scope: "local",
        source: "data",
        kind: "skills",
        name: "a",
        entry,
        state: "kept-local",
        currentSha: "L",
        upstreamSha: "U",
        upstreamDirty: true,
        runtimeWarnings: [],
      }),
    ).toEqual({
      scope: "local",
      source: "data",
      kind: "skills",
      name: "a",
      state: "kept-local",
      lockedSha: "L",
      currentSha: "L",
      upstreamSha: "U",
      upstreamDirty: true,
      sourceCommit: "c1",
      local: true,
      localReason: "why",
      label: "lbl",
    });
  });

  test("assembles a system row and omits absent optional fields", () => {
    const warning: RuntimeWarning = {
      type: "codex_project_untrusted",
      path: "/p",
      message: "m",
    };
    const entry: LockEntry = {
      source: "system",
      sha: "S",
      cliVersion: "1.2.3",
      appliedAt: "t",
    };
    expect(
      buildStatusRow({
        scope: "project",
        source: "system",
        kind: "skills",
        name: "b",
        entry,
        state: "ok",
        currentSha: "S",
        upstreamSha: "S",
        upstreamDirty: false,
        runtimeWarnings: [warning],
      }),
    ).toEqual({
      scope: "project",
      source: "system",
      kind: "skills",
      name: "b",
      state: "ok",
      lockedSha: "S",
      currentSha: "S",
      upstreamSha: "S",
      cliVersion: "1.2.3",
      runtimeWarnings: [warning],
    });
  });
});

describe("personalClaudeExternals", () => {
  const shadow: RuntimeWarning = {
    type: "shadowed_by_personal_claude_skill",
    path: "/home/u/.claude/skills/a",
    message: "shadowed",
  };

  function row(overrides: Partial<StatusRow>): StatusRow {
    return {
      scope: "project",
      source: "data",
      kind: "skills",
      name: "a",
      state: "ok",
      lockedSha: "L",
      currentSha: "L",
      upstreamSha: "L",
      ...overrides,
    };
  }

  test("extracts shadowed personal-claude skills from skills rows", () => {
    expect(
      personalClaudeExternals([row({ runtimeWarnings: [shadow] })]),
    ).toEqual([
      { kind: "skills", name: "a", path: shadow.path, warning: shadow },
    ]);
  });

  test("ignores non-skills rows and unrelated warnings", () => {
    const codex: RuntimeWarning = {
      type: "codex_project_untrusted",
      path: "/p",
      message: "m",
    };
    expect(
      personalClaudeExternals([
        row({ kind: "settings", runtimeWarnings: [shadow] }),
        row({ name: "b", runtimeWarnings: [codex] }),
        row({ name: "c" }),
      ]),
    ).toEqual([]);
  });
});
