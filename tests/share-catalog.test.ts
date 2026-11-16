import { describe, expect, test } from "bun:test";
import { pickRowId } from "../src/pick-core";
import {
  changedMarks,
  plannedSharesFromMarks,
  shareCatalogRows,
} from "../src/share-catalog";
import type { ShareOutputRemainder, SharePick } from "../src/share-catalog";

function output(
  target: ShareOutputRemainder["target"],
  label: string,
  remainder: ShareOutputRemainder["remainder"],
): ShareOutputRemainder {
  return { target, label, exists: true, remainder };
}

describe("shareCatalogRows", () => {
  test("settings rows are the exact --pick paths, with shape details", () => {
    const { rows, picks } = shareCatalogRows([
      output("claude-settings", ".claude/settings.json", {
        permissions: { allow: ["ls"], deny: ["rm"] },
        env: { FOO: "bar" },
      }),
    ]);
    expect(rows.map((row) => [row.ref, row.kind, row.detail])).toEqual([
      ["permissions", "settings", "2 keys"],
      ["permissions.allow", "settings", "1 entry"],
      ["permissions.deny", "settings", "1 entry"],
      ["env", "settings", "1 key"],
      ["env.FOO", "settings", "string"],
    ]);
    const mark = picks.get(pickRowId(rows[1]!));
    expect(mark).toMatchObject({
      id: rows[1]?.id,
      kind: "settings",
      sourceTarget: null,
      pick: "permissions.allow",
    });
    // The digest fingerprints the value the row showed, so the post-prompt
    // check can detect a change.
    expect(mark?.digest).toBe(JSON.stringify(["ls"]));
  });

  test("an mcp server gets one row per output file that holds it", () => {
    const { rows, picks } = shareCatalogRows([
      output("claude-mcp", ".mcp.json", {
        mcpServers: { github: { command: "npx" }, posthog: { command: "ph" } },
      }),
      output("codex-config", ".codex/config.toml", {
        mcp_servers: { github: { command: "npx" } },
      }),
    ]);
    const github = rows.filter((row) => row.ref === "github");
    expect(github).toHaveLength(2);
    expect(github[0]?.id).not.toBe(github[1]?.id);
    expect(picks.get(pickRowId(github[0]!))?.sourceTarget).toBe("claude");
    expect(picks.get(pickRowId(github[1]!))?.sourceTarget).toBe("codex");
    expect(rows.filter((row) => row.ref === "posthog")).toHaveLength(1);
    expect(github[0]?.detail).toContain(".mcp.json");
    expect(github[1]?.detail).toContain(".codex/config.toml");
  });

  test("the codex-config walk skips the server table, so a server has one kind", () => {
    const { rows } = shareCatalogRows([
      output("codex-config", ".codex/config.toml", {
        model: "gpt-5",
        mcp_servers: { github: { command: "npx" } },
      }),
    ]);
    expect(rows.map((row) => [row.ref, row.kind])).toEqual([
      ["model", "codex-config"],
      ["github", "mcp"],
    ]);
  });

  test("an absent output contributes no rows", () => {
    const { rows } = shareCatalogRows([
      {
        target: "claude-mcp",
        label: ".mcp.json",
        exists: false,
        remainder: {},
      },
    ]);
    expect(rows).toEqual([]);
  });

  test("a server name that cannot become an item name is visible but disabled", () => {
    const { rows } = shareCatalogRows([
      output("claude-mcp", ".mcp.json", {
        mcpServers: {
          "a.b": { command: "x" },
          "-dash": { command: "y" },
          // The parser splits on `/` and trims, so these names can't round-trip
          // as `mcp/<name>`; `capshelf` is reserved.
          "a/b": { command: "x" },
          " padded": { command: "x" },
          capshelf: { command: "x" },
          ok: { command: "z" },
        },
      }),
    ]);
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    for (const name of ["a.b", "-dash", "a/b", " padded", "capshelf"]) {
      expect(byRef.get(name)?.disabled).toBe(true);
    }
    expect(byRef.get("ok")?.disabled).toBeUndefined();
  });

  test("a non-server key in .mcp.json is a disabled row, not silence", () => {
    // Without a row for this key, a file holding only it would read as "nothing
    // to share".
    const { rows } = shareCatalogRows([
      output("claude-mcp", ".mcp.json", {
        mcpServers: {},
        metadata: { owner: "platform" },
      }),
    ]);
    expect(rows.map((row) => [row.ref, row.disabled ?? false])).toEqual([
      ["metadata", true],
    ]);
    expect(rows[0]?.detail).toContain("servers only");
  });

  test("a malformed server table or entry is a disabled row, not silence or a trap", () => {
    // Share validators require plain objects, so scalar entries get no enabled
    // row, and dropping a scalar container would read as "nothing to share".
    const { rows } = shareCatalogRows([
      output("claude-mcp", ".mcp.json", {
        mcpServers: { github: "npx", ok: { command: "z" } },
      }),
      output("codex-config", ".codex/config.toml", {
        mcp_servers: "oops",
      }),
    ]);
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    expect(byRef.get("github")?.disabled).toBe(true);
    expect(byRef.get("github")?.detail).toContain("not a server definition");
    expect(byRef.get("ok")?.disabled).toBeUndefined();
    expect(byRef.get("mcp_servers")?.disabled).toBe(true);
    expect(byRef.get("mcp_servers")?.detail).toContain("not a server table");
  });

  test("the synthetic $schema key is not offered", () => {
    // `$schema` is written by capshelf's normalizer, so it is an artifact, not
    // project config; schema-only files must yield no rows.
    const { rows } = shareCatalogRows([
      output("claude-settings", ".claude/settings.json", {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        env: { FOO: "bar" },
      }),
    ]);
    expect(rows.map((row) => row.ref)).toEqual(["env", "env.FOO"]);
    const { rows: schemaOnly } = shareCatalogRows([
      output("claude-settings", ".claude/settings.json", {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
      }),
    ]);
    expect(schemaOnly).toEqual([]);
  });

  test("a top-level key --pick cannot name is a disabled row, not silence", () => {
    // Control-bearing paths would carry a raw ESC into a printed command
    // (`shellArg` doesn't strip) and dotted keys have no pick syntax, so they
    // stay visible, sanitized and unmarkable instead of being dropped.
    const { rows, picks } = shareCatalogRows([
      output("claude-settings", ".claude/settings.json", {
        "evil\u001b[2Jkey": "x",
        "dotted.key": "y",
        plain: "z",
      }),
    ]);
    expect(rows.map((row) => [row.ref, row.disabled ?? false])).toEqual([
      ["evil [2Jkey", true],
      ["dotted.key", true],
      ["plain", false],
    ]);
    const disabledIds = rows.filter((row) => row.disabled).map(pickRowId);
    for (const id of disabledIds) expect(picks.get(id)).toBeUndefined();
  });
});

const mark = (
  kind: SharePick["kind"],
  pick: string,
  sourceTarget: SharePick["sourceTarget"] = null,
  digest = "v1",
): SharePick => ({
  id: JSON.stringify([kind, sourceTarget, pick]),
  kind,
  pick,
  sourceTarget,
  digest,
});

describe("plannedSharesFromMarks", () => {
  test("settings marks group into one unnamed item with deduped picks", () => {
    const planned = plannedSharesFromMarks([
      mark("settings", "permissions"),
      mark("settings", "permissions.allow"),
      mark("settings", "env.FOO"),
    ]);
    expect(planned).toMatchObject([
      {
        kind: "settings",
        name: null,
        picks: ["permissions", "env.FOO"],
        target: null,
      },
    ]);
    // Dropped descendants stay in `marks` because the staleness check covers
    // every value the user saw.
    expect(planned[0]?.marks.map((m) => m.pick)).toEqual([
      "permissions",
      "permissions.allow",
      "env.FOO",
    ]);
  });

  test("mcp marks group by server, and the marked outputs decide --target", () => {
    const planned = plannedSharesFromMarks([
      mark("mcp", "github", "claude"),
      mark("mcp", "github", "codex"),
      mark("mcp", "posthog", "claude"),
    ]);
    expect(planned).toMatchObject([
      { kind: "mcp", name: "github", picks: [], target: null },
      { kind: "mcp", name: "posthog", picks: [], target: "claude" },
    ]);
  });

  test("kinds stay separate items", () => {
    const planned = plannedSharesFromMarks([
      mark("codex-config", "model"),
      mark("settings", "env"),
      mark("mcp", "github", "codex"),
    ]);
    expect(planned.map((item) => item.kind)).toEqual([
      "settings",
      "codex-config",
      "mcp",
    ]);
  });
});

describe("changedMarks", () => {
  test("flags a mark whose value changed or vanished since the frame", () => {
    const original = [
      mark("settings", "env.FOO", null, "old"),
      mark("settings", "env.BAR", null, "same"),
    ];
    const [planned] = plannedSharesFromMarks(original);
    const fresh = new Map([
      [original[0]!.id, { ...original[0]!, digest: "new" }],
      [original[1]!.id, original[1]!],
    ]);
    expect(
      changedMarks(planned!, fresh).map((changedMark) => changedMark.pick),
    ).toEqual(["env.FOO"]);
    fresh.delete(original[1]!.id);
    expect(changedMarks(planned!, fresh).map((m) => m.pick)).toEqual([
      "env.FOO",
      "env.BAR",
    ]);
  });
});
