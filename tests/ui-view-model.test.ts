import { describe, expect, test } from "bun:test";
import type {
  UiItem,
  UiItemUsage,
  UiProjectStatus,
  UiShelfItem,
} from "../src/ui/shared/api-types";
import { homeDisplay } from "../src/ui/shared/display";
import {
  isKind,
  KIND_ORDER,
  kindLabel,
  kindNoun,
} from "../src/ui/shared/kind-label";
import {
  itemIcon,
  stateIcon,
  stateLabel,
  stateTone,
  warningLabel,
} from "../src/ui/shared/state-label";
import {
  changedItemIds,
  externalEntries,
  findingsAcrossProjects,
  groupByKind,
  jumpCandidates,
  listGroups,
  projectCounts,
  shortCommit,
  shortDigest,
  sharedFindings,
  shelfCoverage,
  shelfRollouts,
  shortenDigests,
  sortItems,
  sortTree,
  splitDisplayPath,
  stateSentence,
  usageState,
} from "../src/ui/shared/view-model";
import { ITEM_KINDS, parseItemKind } from "../src/master";
import type { State } from "../src/status-core";

function item(
  ref: string,
  state: State,
  overrides: Partial<UiItem> = {},
): UiItem {
  const [kindText = "", name = ""] = ref.split("/");
  const kind = parseItemKind(kindText);
  const attention = state !== "ok" && state !== "kept-local";
  return {
    id: `project/data/${ref}`,
    ref,
    kind,
    name,
    scope: "project",
    source: "data",
    row: {
      scope: "project",
      source: "data",
      kind,
      name,
      state,
      lockedSha: "a".repeat(64),
      currentSha: "a".repeat(64),
      upstreamSha: "a".repeat(64),
    },
    attention,
    tone: stateTone(state),
    stateLabel: stateLabel(state, "data"),
    stateDetail: "",
    actions: [],
    diffViews: [],
    installedPath: null,
    ...overrides,
  };
}

describe("view model", () => {
  const items = [
    item("skills/zeta", "ok"),
    item("skills/alpha", "update_available"),
    item("mcp/context7", "ok"),
    item("skills/beta", "kept-local"),
    item("settings/base", "drifted_local"),
  ];

  test("counts attention, up to date, and kept local", () => {
    expect(projectCounts(items)).toEqual({
      items: 5,
      attention: 2,
      ok: 2,
      kept: 1,
    });
  });

  test("sorts attention first, then kept, then up to date, each by ref", () => {
    expect(sortItems(items).map((entry) => entry.ref)).toEqual([
      "settings/base",
      "skills/alpha",
      "skills/beta",
      "mcp/context7",
      "skills/zeta",
    ]);
  });

  test("groups rows by kind in the order ls prints, skipping empty kinds", () => {
    const groups = groupByKind([
      { kind: "mcp", ref: "mcp/b" },
      { kind: "skills", ref: "skills/z" },
      { kind: "mcp", ref: "mcp/a" },
      { kind: "settings", ref: "settings/base" },
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "skills",
      "settings",
      "mcp",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Skills",
      "Settings",
      "MCP servers",
    ]);
    expect(groups[2]?.rows.map((row) => row.ref)).toEqual(["mcp/b", "mcp/a"]);
    expect(groupByKind([])).toEqual([]);
  });

  test("reports which rows moved between refreshes", () => {
    const before = [item("skills/a", "ok"), item("skills/b", "ok")];
    const after = [
      item("skills/a", "update_available"),
      item("skills/b", "ok"),
      item("skills/c", "ok"),
    ];
    expect([...changedItemIds(before, after)].sort()).toEqual([
      "project/data/skills/a",
      "project/data/skills/c",
    ]);
    expect(changedItemIds(undefined, after).size).toBe(0);
  });

  test("orders the tree by attention, then path, with unknown counts last", () => {
    const sorted = sortTree([
      {
        path: "/b",
        display: "~/b",
        state: "ready",
        counts: { items: 2, attention: 0, ok: 2, kept: 0 },
      },
      {
        path: "/a",
        display: "~/a",
        state: "ready",
        counts: { items: 5, attention: 2, ok: 3, kept: 0 },
      },
      { path: "/c", display: "~/c", state: "loading", counts: null },
      {
        path: "/0",
        display: "~/0",
        state: "ready",
        counts: { items: 1, attention: 0, ok: 1, kept: 0 },
      },
    ]);
    expect(sorted.map((entry) => entry.path)).toEqual(["/a", "/0", "/b", "/c"]);
  });

  test("shortens every full digest inside a CLI sentence", () => {
    const digest = "0bcc14f36db5".padEnd(64, "a");
    expect(shortenDigests(`update available → ${digest} now`)).toBe(
      "update available → 0bcc14f36db5 now",
    );
    expect(shortenDigests("drifted (1 file: content-edit)")).toBe(
      "drifted (1 file: content-edit)",
    );
  });

  test("shortens digests and commits the way the CLI prints them", () => {
    expect(shortDigest("f".repeat(64))).toBe("f".repeat(12));
    expect(shortDigest("2c8b859bd658")).toBe("2c8b859bd658");
    expect(shortDigest(null)).toBe("(missing)");
    expect(shortCommit("1".repeat(40))).toBe("1111111");
    expect(shortCommit(null)).toBe("");
  });
});

describe("state labels", () => {
  test("every state has a label, a tone, and an icon", () => {
    const states: State[] = [
      "ok",
      "source_filtered",
      "missing_source_commit",
      "update_available",
      "drifted_local",
      "drifted_and_update",
      "missing_installed",
      "missing_output",
      "missing_upstream",
      "upstream_dirty",
      "source_dirty",
      "drifted_and_upstream_dirty",
      "output_drift",
      "source_dirty_and_output_drift",
      "kept-local",
    ];
    for (const state of states) {
      expect(stateLabel(state, "data").length).toBeGreaterThan(0);
      expect(stateIcon(state)).toBeTruthy();
    }
    expect(stateTone("ok")).toBe("ok");
    expect(stateTone("kept-local")).toBe("kept");
    expect(stateTone("drifted_local")).toBe("attention");
    expect(stateLabel("missing_upstream", "system")).toBe("Gone from this CLI");
    expect(stateIcon("drifted_and_update")).toBe("pencil");
    expect(stateIcon("missing_installed")).toBe("question");
  });
});

describe("kind labels", () => {
  test("the display order is the order ITEM_KINDS declares", () => {
    expect([...KIND_ORDER]).toEqual([...ITEM_KINDS]);
  });

  test("every kind has a label", () => {
    for (const kind of ITEM_KINDS) {
      expect(kindLabel(kind).length).toBeGreaterThan(0);
    }
    expect(kindLabel("pi-extensions")).toBe("Pi extensions");
    expect(kindLabel("codex-config")).toBe("Codex config");
  });

  test("every kind has a singular noun for list rows", () => {
    for (const kind of ITEM_KINDS) {
      expect(kindNoun(kind).length).toBeGreaterThan(0);
    }
    expect(kindNoun("skills")).toBe("skill");
    expect(kindNoun("mcp")).toBe("MCP server");
  });
});

describe("item list", () => {
  test("groups findings first, then kept local, then up to date", () => {
    const groups = listGroups([
      item("skills/b", "ok"),
      item("skills/a", "kept-local"),
      item("skills/c", "drifted_local"),
      item("settings/d", "update_available"),
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      "attention",
      "kept",
      "ok",
    ]);
    expect(groups[0]?.rows.map((row) => row.ref)).toEqual([
      "settings/d",
      "skills/c",
    ]);
  });

  test("drops an empty group", () => {
    expect(listGroups([item("skills/a", "ok")]).map((g) => g.id)).toEqual([
      "ok",
    ]);
    expect(listGroups([])).toEqual([]);
  });

  test("splits a display path into the folder name and its parent", () => {
    expect(splitDisplayPath("~/code/billing-api")).toEqual({
      name: "billing-api",
      parent: "~/code",
    });
    expect(splitDisplayPath("/srv/app/")).toEqual({
      name: "app",
      parent: "/srv",
    });
    expect(splitDisplayPath("/app")).toEqual({ name: "app", parent: "/" });
    expect(splitDisplayPath("~")).toEqual({ name: "~", parent: "" });
  });

  test("keeps the CLI sentence only when it adds to the label", () => {
    expect(stateSentence("Up to date", "up-to-date")).toBeNull();
    expect(stateSentence("Drifted", "")).toBeNull();
    expect(
      stateSentence(
        "Drifted, update available",
        `drifted + update available → ${"4".repeat(64)}`,
      ),
    ).toBe("drifted + update available → 444444444444");
  });

  test("lists external rows by name with ids that cannot be item ids", () => {
    const entries = externalEntries({
      external: [{ name: "terraform-plan", source: "hashicorp/agent-skills" }],
      externalClaudePlugins: [
        {
          id: "github@official",
          name: "github",
          scope: "project",
          enabled: true,
          settingsPath: "/p/.claude/settings.json",
        },
      ],
      externalUserSkills: [
        {
          kind: "skills",
          name: "quick-review",
          surface: "claude",
          path: "/home/u/.claude/skills/quick-review",
          shadows: [{ scope: "project", source: "data" }],
        },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "plugin/project/github@official",
      "user/claude/quick-review",
      "external/skills/terraform-plan",
    ]);
    for (const entry of entries) {
      expect(entry.id.split("/")[0]).not.toBe("project");
      expect(entry.id.split("/")[0]).not.toBe("local");
    }
  });
});

describe("hidden rows and external display", () => {
  test("an up-to-date row with a finding shows the alert icon", () => {
    expect(itemIcon("ok", true)).toBe("alert");
    expect(itemIcon("kept-local", true)).toBe("alert");
    expect(itemIcon("ok", false)).toBe("check");
    expect(itemIcon("drifted_local", true)).toBe("pencil");
  });

  test("every runtime warning has a badge label", () => {
    expect(warningLabel("shadowed_by_personal_claude_skill")).toBe(
      "Shadowed by a personal Claude skill",
    );
    expect(warningLabel("shadowed_by_pi_project_skill")).toBe(
      "Shadowed by a Pi project skill",
    );
    expect(warningLabel("codex_project_untrusted").length).toBeGreaterThan(0);
  });

  test("isKind accepts kinds and rejects the external group ids", () => {
    expect(isKind("skills")).toBe(true);
    // "plugins" is the real kind (the data-repo plugin kind). The external
    // "Claude plugins" chip id is "claude-plugins" (D11), so the two no
    // longer collide.
    expect(isKind("plugins")).toBe(true);
    expect(isKind("claude-plugins")).toBe(false);
    expect(isKind("user-skills")).toBe(false);
  });

  test("homeDisplay shortens paths under the home directory", () => {
    expect(homeDisplay("/Users/mg/.claude/skills/x", "/Users/mg")).toBe(
      "~/.claude/skills/x",
    );
    expect(homeDisplay("/Users/mg", "/Users/mg")).toBe("~");
    expect(homeDisplay("/etc/codex/skills", "/Users/mg")).toBe(
      "/etc/codex/skills",
    );
    expect(homeDisplay("/Users/mgx/y", "/Users/mg")).toBe("/Users/mgx/y");
    expect(homeDisplay("/Users/mg/y", "")).toBe("/Users/mg/y");
  });
});

function status(
  display: string,
  items: UiItem[],
  overrides: Partial<UiProjectStatus> = {},
): UiProjectStatus {
  return {
    project: `/home/u/${display.replace(/^~\//, "")}`,
    display,
    cdCommand: `cd ${display}`,
    dataRepo: "/home/u/shelf",
    dataRepoDisplay: "~/shelf",
    dataRepoUpstream: null,
    lockVersion: 5,
    localLockVersion: 5,
    installMode: "codex-compatible",
    cliVersion: "0.15.0",
    items,
    external: [],
    externalClaudePlugins: [],
    externalUserSkills: [],
    personalClaudeExternal: [],
    shelf: null,
    notices: [],
    generatedAt: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("across projects", () => {
  const billing = status("~/code/billing-api", [
    item("skills/quick-review", "update_available", {
      actions: [
        { command: "capshelf update skills/quick-review", purpose: "" },
      ],
    }),
    item("skills/commit-message", "drifted_local"),
    item("skills/sql-migrations", "ok"),
  ]);
  const checkout = status("~/code/checkout-web", [
    item("skills/quick-review", "drifted_and_update"),
  ]);
  const infra = status("~/code/infra-tools", [item("skills/go", "ok")]);

  test("groups findings by project, the most findings first", () => {
    const groups = findingsAcrossProjects([checkout, infra, billing]);
    expect(groups.map((group) => group.name)).toEqual([
      "billing-api",
      "checkout-web",
    ]);
    expect(groups[0]?.rows.map((row) => row.ref)).toEqual([
      "skills/commit-message",
      "skills/quick-review",
    ]);
  });

  test("names a shelf item that is behind in more than one project", () => {
    const shared = sharedFindings(findingsAcrossProjects([billing, checkout]));
    expect(shared).toEqual([
      { ref: "skills/quick-review", projects: ["billing-api", "checkout-web"] },
    ]);
    expect(sharedFindings(findingsAcrossProjects([billing]))).toEqual([]);
  });

  test("jump rows put a finding under Findings with its command", () => {
    const rows = jumpCandidates(
      [billing],
      [
        {
          dataRepo: "/home/u/shelf",
          items: [
            {
              ref: "skills/quick-review",
              name: "quick-review",
              tags: [],
              usage: [{}, {}],
            },
          ],
        },
      ],
    );
    const finding = rows.find(
      (row) => row.group === "Findings" && row.ref === "quick-review",
    );
    expect(finding?.command).toBe("capshelf update skills/quick-review");
    expect(finding?.target).toEqual({
      type: "item",
      project: billing.project,
      item: "project/data/skills/quick-review",
    });
    expect(
      rows.filter((row) => row.group === "Items").map((row) => row.ref),
    ).toEqual(["sql-migrations"]);
    expect(rows.find((row) => row.group === "Shelf")?.detail).toBe(
      "skills/quick-review · 2 projects",
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  test("lists a user-level skill once, however many projects report it", () => {
    const skill = {
      kind: "skills" as const,
      name: "notes",
      surface: "claude" as const,
      path: "/home/u/.claude/skills/notes",
      shadows: [],
    };
    const rows = jumpCandidates(
      [
        status("~/a", [], { externalUserSkills: [skill] }),
        status("~/b", [], { externalUserSkills: [skill] }),
      ],
      [],
    );
    expect(rows.filter((row) => row.group === "This machine")).toHaveLength(1);
  });
});

function usage(
  project: UiProjectStatus,
  overrides: Partial<UiItemUsage> = {},
): UiItemUsage {
  return {
    project: project.project,
    display: project.display,
    scope: "project",
    sourceCommit: "1".repeat(40),
    sourceCommitShort: "1111111",
    cliVersion: null,
    lockedSha: "a".repeat(64),
    current: false,
    keptLocal: false,
    ...overrides,
  };
}

function shelfItem(
  ref: string,
  usages: UiItemUsage[],
  overrides: Partial<UiShelfItem> = {},
): UiShelfItem {
  const [kindText = "", name = ""] = ref.split("/");
  return {
    ref,
    kind: parseItemKind(kindText),
    name,
    source: "data",
    tags: [],
    lastCommit: null,
    usage: usages,
    ...overrides,
  };
}

describe("shelf views", () => {
  const billing = status("~/code/billing-api", [
    item("skills/quick-review", "update_available"),
    item("skills/notes", "kept-local"),
  ]);
  const checkout = status("~/code/checkout-web", [
    item("skills/quick-review", "drifted_and_update"),
  ]);
  const infra = status("~/code/infra-tools", [
    item("skills/quick-review", "ok"),
  ]);
  const read = new Map([
    [billing.project, billing],
    [checkout.project, checkout],
    [infra.project, infra],
  ]);

  test("the project's status row decides the state, not the shelf flag", () => {
    // The shelf says current, the status row says behind: the row wins.
    expect(
      usageState(
        "skills/quick-review",
        usage(billing, { current: true }),
        read,
      ),
    ).toMatchObject({
      state: "behind",
      label: "Update available",
      itemId: "project/data/skills/quick-review",
    });
    expect(usageState("skills/quick-review", usage(checkout), read).state).toBe(
      "behind-edited",
    );
  });

  test("a project still loading falls back to the shelf flag", () => {
    expect(
      usageState("skills/quick-review", usage(billing), new Map()),
    ).toMatchObject({ state: "behind", label: null, itemId: null });
    expect(
      usageState(
        "skills/quick-review",
        usage(billing, { current: null }),
        new Map(),
      ).state,
    ).toBe("unknown");
  });

  test("a rollout lists items some project has not taken", () => {
    const items = [
      shelfItem("skills/quick-review", [
        usage(billing),
        usage(checkout),
        usage(infra, { current: true }),
      ]),
      shelfItem("skills/notes", [usage(billing, { keptLocal: true })]),
    ];
    const rollouts = shelfRollouts(items, read);
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0]?.behind).toBe(2);
    expect(rollouts[0]?.projects.map((entry) => entry.state)).toEqual([
      "behind",
      "behind-edited",
      "current",
    ]);
  });

  test("coverage has one cell per project and marks unused items", () => {
    const rows = shelfCoverage(
      [
        shelfItem("skills/quick-review", [usage(billing), usage(infra)]),
        shelfItem("skills/unused", []),
        shelfItem("skills/system-one", [], { source: "system" }),
      ],
      [billing.project, checkout.project, infra.project],
      read,
    );
    expect(rows.map((row) => row.ref)).toEqual([
      "skills/quick-review",
      "skills/unused",
    ]);
    expect(rows[0]?.cells.map((cell) => cell?.state ?? null)).toEqual([
      "behind",
      null,
      "current",
    ]);
    expect(rows[1]?.used).toBe(0);
  });
});
