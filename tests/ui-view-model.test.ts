import { describe, expect, test } from "bun:test";
import type { UiItem } from "../src/ui/shared/api-types";
import { stateIcon, stateLabel, stateTone } from "../src/ui/shared/state-label";
import {
  changedItemIds,
  filterItems,
  projectCounts,
  shortCommit,
  shortDigest,
  shortenDigests,
  sortItems,
  sortTree,
  summaryLine,
} from "../src/ui/shared/view-model";
import type { State } from "../src/status-core";

function item(
  ref: string,
  state: State,
  overrides: Partial<UiItem> = {},
): UiItem {
  const [kind, name] = ref.split("/") as [UiItem["kind"], string];
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

  test("filters by tab and by query", () => {
    expect(
      filterItems(items, "attention", "").map((entry) => entry.ref),
    ).toEqual(["settings/base", "skills/alpha"]);
    expect(filterItems(items, "ok", "").map((entry) => entry.ref)).toEqual([
      "skills/beta",
      "mcp/context7",
      "skills/zeta",
    ]);
    expect(
      filterItems(items, "all", "SKILLS/").map((entry) => entry.ref),
    ).toEqual(["skills/alpha", "skills/beta", "skills/zeta"]);
  });

  test("writes the summary line the way the comp reads", () => {
    expect(summaryLine(items)).toBe(
      "5 items · 2 up to date · 1 drifted · 1 update available · 1 kept local",
    );
    expect(summaryLine([item("skills/one", "ok")])).toBe(
      "1 item · 1 up to date",
    );
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
