import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  describe as describeRow,
  formatStatusHuman,
  formatUserSkillsHuman,
  glyph,
} from "../src/status-format";
import type { State, StatusRow } from "../src/status-core";

function row(overrides: Partial<StatusRow>): StatusRow {
  return {
    scope: "project",
    source: "data",
    kind: "skills",
    name: "a",
    state: "ok",
    lockedSha: "abc123",
    currentSha: "abc123",
    upstreamSha: "abc123",
    ...overrides,
  };
}

describe("glyph", () => {
  test("maps every state to a stable glyph", () => {
    const cases: Array<[State, string]> = [
      ["ok", "✓"],
      ["missing_source_commit", "!"],
      ["update_available", "⚠"],
      ["drifted_local", "✎"],
      ["drifted_and_update", "✎⚠"],
      ["missing_installed", "?"],
      ["missing_output", "?"],
      ["missing_upstream", "!"],
      ["upstream_dirty", "!"],
      ["source_dirty", "!"],
      ["drifted_and_upstream_dirty", "✎!"],
      ["output_drift", "✎"],
      ["source_dirty_and_output_drift", "✎!"],
      ["kept-local", "≠"],
    ];
    for (const [state, expected] of cases) {
      expect(glyph(state)).toBe(expected);
    }
  });
});

describe("describe", () => {
  test("up-to-date", () => {
    expect(describeRow(row({ state: "ok" }))).toBe("up-to-date");
  });

  test("update_available distinguishes data from a cli upgrade", () => {
    expect(
      describeRow(row({ state: "update_available", upstreamSha: "newsha" })),
    ).toBe("update available → newsha");
    expect(
      describeRow(
        row({ state: "update_available", source: "system", upstreamSha: "v2" }),
      ),
    ).toBe("update available → v2 (cli upgraded)");
  });

  test("missing_upstream distinguishes data repo from bundled CLI", () => {
    expect(
      describeRow(row({ state: "missing_upstream", source: "data" })),
    ).toBe("no longer in data repo");
    expect(
      describeRow(row({ state: "missing_upstream", source: "system" })),
    ).toBe("no longer bundled in CLI");
  });

  test("kept-local includes the reason when present", () => {
    expect(
      describeRow(row({ state: "kept-local", localReason: "forked" })),
    ).toBe("kept local (forked)");
    expect(describeRow(row({ state: "kept-local" }))).toBe("kept local");
  });

  test("drifted_local reports the current sha", () => {
    expect(
      describeRow(row({ state: "drifted_local", currentSha: "ff00" })),
    ).toBe("drifted (current ff00)");
  });

  test("missing_source_commit names the unreachable pin", () => {
    expect(
      describeRow(
        row({
          state: "missing_source_commit",
          sourceCommit: "abc1234def5678",
        }),
      ),
    ).toBe("locked sourceCommit abc1234 is not present in the data repo");
  });
});

describe("missing_source_commit guidance", () => {
  test("the row carries the re-pin fix", () => {
    const lines = formatStatusHuman({
      project: "/p",
      dataRepo: "/data",
      rows: [
        row({
          state: "missing_source_commit",
          name: "security-review",
          sourceCommit: "abc1234def5678",
        }),
      ],
      external: [],
      externalClaudePlugins: [],
      personalClaudeExternal: [],
    }).join("\n");
    expect(lines).toContain(
      "capshelf sync-data && capshelf update skills/security-review",
    );
    expect(lines).toContain(
      "if it only exists in another clone, fetch or push that clone first.",
    );
  });
});

describe("formatStatusHuman", () => {
  test("reports nothing tracked when everything is empty", () => {
    expect(
      formatStatusHuman({
        project: "/p",
        dataRepo: null,
        rows: [],
        external: [],
        externalClaudePlugins: [],
        personalClaudeExternal: [],
      }),
    ).toEqual(["(no items tracked)"]);
  });

  test("renders a project header and row line", () => {
    const lines = formatStatusHuman({
      project: "/p",
      dataRepo: null,
      rows: [row({ scope: "project", name: "alpha", state: "ok" })],
      external: [],
      externalClaudePlugins: [],
      personalClaudeExternal: [],
    });
    expect(lines[0]).toBe("/p  (1 item)");
    expect(lines).toContain("project/");
    const rowLine = lines.find((l) => l.includes("data/skills/alpha"));
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain("✓");
    expect(rowLine).toContain("up-to-date");
  });

  test("local section labels the data repo, or notes its absence", () => {
    const withRepo = formatStatusHuman({
      project: "/p",
      dataRepo: "/data/repo",
      rows: [row({ scope: "local", name: "beta" })],
      external: [],
      externalClaudePlugins: [],
      personalClaudeExternal: [],
    });
    expect(withRepo.some((l) => l.startsWith("local/  (from "))).toBe(true);

    const withoutRepo = formatStatusHuman({
      project: "/p",
      dataRepo: null,
      rows: [row({ scope: "local", name: "beta" })],
      external: [],
      externalClaudePlugins: [],
      personalClaudeExternal: [],
    });
    expect(withoutRepo.some((l) => l.includes("no data repo configured"))).toBe(
      true,
    );
  });

  test("renders external skills.sh and Claude plugin sections", () => {
    const lines = formatStatusHuman({
      project: "/p",
      dataRepo: null,
      rows: [],
      external: [{ name: "ext", source: "acme/ext" }],
      externalClaudePlugins: [
        {
          id: "rev@co",
          name: "rev",
          marketplace: "co",
          scope: "project",
          enabled: true,
          settingsPath: "/p/.claude/settings.json",
        },
      ],
      personalClaudeExternal: [],
    });
    expect(lines).toContain("external/  (managed by skills.sh)");
    expect(
      lines.some((l) => l.includes("skills/ext") && l.includes("acme/ext")),
    ).toBe(true);
    expect(lines).toContain("external/  (Claude plugins)");
    expect(
      lines.some((l) => l.includes("plugins/rev@co") && l.includes("enabled")),
    ).toBe(true);
  });

  test("renders user-level skills and shadow annotations", () => {
    const claudePath = `${homedir()}/.claude/skills/alpha`;
    const codexPath = `${homedir()}/.agents/skills/beta`;
    const lines = formatUserSkillsHuman([
      {
        kind: "skills",
        name: "alpha",
        surface: "claude",
        path: claudePath,
        shadows: [{ scope: "project", source: "data" }],
      },
      {
        kind: "skills",
        name: "beta",
        surface: "codex",
        path: codexPath,
        shadows: [],
      },
    ]);

    expect(lines).toContain(
      "external/user/claude/  (Claude user-level skills)",
    );
    expect(lines).toContain("external/user/codex/  (Codex user-level skills)");
    expect(
      lines.indexOf("external/user/claude/  (Claude user-level skills)"),
    ).toBeLessThan(
      lines.indexOf("external/user/codex/  (Codex user-level skills)"),
    );
    expect(lines.some((line) => line.includes("skills/alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("skills/beta"))).toBe(true);
    expect(lines.some((line) => line.includes("~/.claude/skills/alpha"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("~/.agents/skills/beta"))).toBe(
      true,
    );
    expect(lines).toContain("      shadows project/data/skills/alpha");
  });
});
