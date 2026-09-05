import { describe, expect, test } from "bun:test";
import { actionsForRow } from "../src/status-actions";
import type { State, StatusRow } from "../src/status-core";

function row(overrides: Partial<StatusRow> & { state: State }): StatusRow {
  return {
    scope: "project",
    source: "data",
    kind: "skills",
    name: "security-review",
    lockedSha: "a".repeat(64),
    currentSha: "a".repeat(64),
    upstreamSha: "a".repeat(64),
    ...overrides,
  };
}

const commands = (actions: ReturnType<typeof actionsForRow>): string[] =>
  actions.map((action) => action.command);

describe("actionsForRow", () => {
  test("an up-to-date row has nothing to run", () => {
    expect(actionsForRow(row({ state: "ok" }))).toEqual([]);
  });

  test("update available offers update, with --local for local scope", () => {
    expect(commands(actionsForRow(row({ state: "update_available" })))).toEqual(
      ["capshelf update skills/security-review"],
    );
    expect(
      commands(
        actionsForRow(row({ state: "update_available", scope: "local" })),
      ),
    ).toEqual(["capshelf update skills/security-review --local"]);
  });

  test("drift offers promote, keep-local, and revert, in that order", () => {
    expect(commands(actionsForRow(row({ state: "drifted_local" })))).toEqual([
      "capshelf promote skills/security-review",
      "capshelf keep-local skills/security-review",
      "capshelf revert skills/security-review",
    ]);
  });

  test("a drifted system item can only be reverted", () => {
    expect(
      commands(
        actionsForRow(
          row({ state: "drifted_local", source: "system", name: "capshelf" }),
        ),
      ),
    ).toEqual(["capshelf revert skills/capshelf"]);
  });

  test("drift plus update offers --merge for copy items only", () => {
    const skill = commands(actionsForRow(row({ state: "drifted_and_update" })));
    expect(skill[0]).toBe("capshelf update skills/security-review --merge");
    expect(skill).toContain(
      "capshelf promote skills/security-review --stale-ok",
    );
    const fragment = commands(
      actionsForRow(
        row({ state: "drifted_and_update", kind: "settings", name: "base" }),
      ),
    );
    expect(fragment[0]).toBe("capshelf update settings/base");
    expect(fragment.some((command) => command.includes("--merge"))).toBe(false);
  });

  test("missing content and drifted output both run apply", () => {
    expect(
      commands(actionsForRow(row({ state: "missing_installed" }))),
    ).toEqual(["capshelf apply skills/security-review"]);
    expect(
      commands(
        actionsForRow(row({ state: "output_drift", kind: "mcp", name: "gh" })),
      ),
    ).toEqual(["capshelf apply mcp/gh"]);
  });

  test("a missing source commit re-pins after a sync", () => {
    expect(
      commands(actionsForRow(row({ state: "missing_source_commit" }))),
    ).toEqual(["capshelf data sync && capshelf update skills/security-review"]);
  });

  test("a dirty shelf names git commands in the data repo", () => {
    const actions = actionsForRow(
      row({ state: "source_dirty", kind: "mcp", name: "gh" }),
      { dataRepo: "/home/me/shelf" },
    );
    expect(commands(actions)).toEqual([
      "git -C /home/me/shelf status --short -- mcp/gh/claude.json mcp/gh/codex.toml",
      "git -C /home/me/shelf add -- mcp/gh/claude.json mcp/gh/codex.toml && git -C /home/me/shelf commit",
    ]);
    expect(
      actionsForRow(row({ state: "upstream_dirty" }), { dataRepo: null }),
    ).toEqual([]);
  });

  test("kept-local offers --unset and revert", () => {
    expect(
      commands(actionsForRow(row({ state: "kept-local", local: true }))),
    ).toEqual([
      "capshelf keep-local skills/security-review --unset",
      "capshelf revert skills/security-review",
    ]);
  });

  test("a requirements change adds update once", () => {
    const actions = actionsForRow(
      row({ state: "update_available", needsState: "update_available" }),
    );
    expect(commands(actions)).toEqual([
      "capshelf update skills/security-review",
    ]);
    const okRow = actionsForRow(row({ state: "ok", needsState: "unknown" }));
    expect(commands(okRow)).toEqual(["capshelf update skills/security-review"]);
    expect(okRow[0]?.purpose).toMatch(/snapshot/);
  });

  test("quotes names the shell would expand and repeats --data", () => {
    const actions = actionsForRow(
      row({ state: "update_available", kind: "settings", name: "$(whoami)" }),
      { dataOverride: "/tmp/my shelf" },
    );
    expect(commands(actions)).toEqual([
      "capshelf --data '/tmp/my shelf' update 'settings/$(whoami)'",
    ]);
  });
});
