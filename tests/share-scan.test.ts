import { describe, expect, test } from "bun:test";
import {
  plannedItemSharesFromMarks,
  untrackedItemRows,
} from "../src/share-scan";
import type { ItemSharePick, UntrackedItemCandidate } from "../src/share-scan";

function candidate(
  overrides: Partial<UntrackedItemCandidate> &
    Pick<UntrackedItemCandidate, "kind" | "name">,
): UntrackedItemCandidate {
  return {
    target: null,
    label: overrides.name,
    summary: null,
    refusal: null,
    digest: "v1",
    ...overrides,
  };
}

describe("untrackedItemRows", () => {
  test("a subagent present in both outputs gets one row per output file", () => {
    const { rows, picks } = untrackedItemRows([
      candidate({
        kind: "subagents",
        name: "reviewer",
        target: "claude",
        label: ".claude/agents/reviewer.md",
      }),
      candidate({
        kind: "subagents",
        name: "reviewer",
        target: "codex",
        label: ".codex/agents/reviewer.toml",
      }),
    ]);
    const reviewer = rows.filter((row) => row.ref === "reviewer");
    expect(reviewer).toHaveLength(2);
    // Two rows, one label: the identity is the id, not the ref.
    expect(reviewer[0]?.id).not.toBe(reviewer[1]?.id);
    expect(reviewer[0]?.detail).toContain(".claude/agents/reviewer.md");
    expect(reviewer[1]?.detail).toContain(".codex/agents/reviewer.toml");
    // Each pick knows every shareable output, so the mark grouping can tell
    // "all of them" from "one of them".
    for (const row of reviewer) {
      expect(picks.get(row.id as string)?.presentTargets).toEqual([
        "claude",
        "codex",
      ]);
    }
  });

  test("a refused candidate is a disabled row with the refusal, and no pick", () => {
    const { rows, picks } = untrackedItemRows([
      candidate({
        kind: "skills",
        name: "broken",
        refusal: "local skill is missing SKILL.md",
        digest: null,
      }),
      candidate({
        kind: "skills",
        name: "ok",
        label: ".agents/skills/ok",
        summary: "2 files",
      }),
    ]);
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    expect(byRef.get("broken")?.disabled).toBe(true);
    expect(byRef.get("broken")?.detail).toContain("missing SKILL.md");
    expect(picks.get(byRef.get("broken")?.id as string)).toBeUndefined();
    expect(byRef.get("ok")?.disabled).toBeUndefined();
    expect(byRef.get("ok")?.detail).toBe(".agents/skills/ok · 2 files");
    expect(picks.get(byRef.get("ok")?.id as string)).toMatchObject({
      kind: "skills",
      name: "ok",
      target: null,
      digest: "v1",
    });
  });

  test("a refused output does not count as a present target for its sibling", () => {
    const { rows, picks } = untrackedItemRows([
      candidate({ kind: "subagents", name: "solo", target: "claude" }),
      candidate({
        kind: "subagents",
        name: "solo",
        target: "codex",
        refusal: "not a regular file",
        digest: null,
      }),
    ]);
    const enabled = rows.find((row) => row.disabled !== true);
    expect(picks.get(enabled?.id as string)?.presentTargets).toEqual([
      "claude",
    ]);
  });

  test("labels and details are sanitized for the live frame", () => {
    // The name and the label come from the user's filesystem, not from a
    // validated lock, and the frame is live: a raw ESC must never render.
    const { rows } = untrackedItemRows([
      candidate({
        kind: "skills",
        name: "evil\u001b[2Jname",
        label: "evil\u001b[2Jname",
        refusal: "name cannot become an item name",
        digest: null,
      }),
    ]);
    expect(rows[0]?.ref).toBe("evil [2Jname");
    expect(rows[0]?.detail).not.toContain("\u001b");
  });
});

const mark = (
  kind: ItemSharePick["kind"],
  name: string,
  target: ItemSharePick["target"] = null,
  presentTargets: ItemSharePick["presentTargets"] = [],
): ItemSharePick => ({
  id: JSON.stringify([kind, target, name]),
  kind,
  name,
  target,
  presentTargets,
  digest: "v1",
});

describe("plannedItemSharesFromMarks", () => {
  test("a copy-directory mark is one item share with no --target", () => {
    const planned = plannedItemSharesFromMarks([
      mark("skills", "hello"),
      mark("pi-extensions", "lint"),
    ]);
    expect(planned).toMatchObject([
      { kind: "skills", name: "hello", target: null },
      { kind: "pi-extensions", name: "lint", target: null },
    ]);
  });

  test("subagent marks decide --target like mcp rows: all rows drop it, a subset keeps one flag each", () => {
    const planned = plannedItemSharesFromMarks([
      mark("subagents", "both", "claude", ["claude", "codex"]),
      mark("subagents", "both", "codex", ["claude", "codex"]),
      mark("subagents", "one-of-two", "claude", ["claude", "codex"]),
      mark("subagents", "only-output", "claude", ["claude"]),
    ]);
    expect(planned).toMatchObject([
      { kind: "subagents", name: "both", target: null },
      { kind: "subagents", name: "one-of-two", target: "claude" },
      // The named command shares every present output by default, so the one
      // present output marked needs no flag.
      { kind: "subagents", name: "only-output", target: null },
    ]);
    // Every mark stays attached for the staleness check.
    expect(planned[0]?.marks).toHaveLength(2);
  });
});
