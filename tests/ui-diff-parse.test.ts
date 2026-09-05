import { describe, expect, test } from "bun:test";
import {
  diffLineCount,
  parseDiffLabel,
  parseUnifiedDiff,
  sideBySideRows,
  threeWayRows,
} from "../src/ui/shared/diff-parse";

const INSTALLED = [
  "--- SKILL.md (locked 7940223)",
  "+++ SKILL.md (installed)",
  "@@ -1,4 +1,4 @@",
  " # Security review",
  " ",
  "-Flag every raw query.",
  "+Flag every f-string in a query.",
  " Done.",
  "",
].join("\n");

const UPSTREAM = [
  "--- SKILL.md (locked 7940223)",
  "+++ SKILL.md (upstream cf20921)",
  "@@ -2,3 +2,4 @@",
  " ",
  " Flag every raw query.",
  "+Parameterized queries are assumed.",
  " Done.",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  test("splits labels into path and side", () => {
    expect(parseDiffLabel("SKILL.md (locked 7940223)")).toEqual({
      path: "SKILL.md",
      side: "locked 7940223",
    });
    expect(parseDiffLabel(".claude/settings.json (current)")).toEqual({
      path: ".claude/settings.json",
      side: "current",
    });
    expect(parseDiffLabel("/dev/null")).toEqual({ path: "", side: "" });
    expect(parseDiffLabel("plain.txt")).toEqual({
      path: "plain.txt",
      side: "",
    });
  });

  test("reads hunks with old and new line numbers", () => {
    const parsed = parseUnifiedDiff(INSTALLED);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.path).toBe("SKILL.md");
    expect(file.oldSide).toBe("locked 7940223");
    expect(file.newSide).toBe("installed");
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newCount).toBe(4);
    expect(
      hunk.lines.map((line) => [line.kind, line.oldNo, line.newNo]),
    ).toEqual([
      ["context", 1, 1],
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
      ["context", 4, 4],
    ]);
    expect(diffLineCount(parsed)).toBe(5);
  });

  test("a deleted line that starts with dashes is not a file header", () => {
    const text = [
      "--- notes.md (locked)",
      "+++ notes.md (installed)",
      "@@ -1,2 +1,2 @@",
      "---- four dashes",
      "+++ three pluses",
      " same",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.files).toHaveLength(1);
    const lines = parsed.files[0]!.hunks[0]!.lines;
    expect(lines[0]).toMatchObject({ kind: "del", text: "--- four dashes" });
    expect(lines[1]).toMatchObject({ kind: "add", text: "++ three pluses" });
  });

  test("keeps binary stanzas, mode lines, notes, and no-newline marks", () => {
    const text = [
      "--- font.woff (locked)",
      "+++ font.woff (installed)",
      "Binary files differ",
      "old mode 100644",
      "new mode 100755",
      "--- run.sh (locked)",
      "+++ run.sh (installed)",
      "@@ -1 +1 @@",
      "-echo a",
      "\\ No newline at end of file",
      "+echo b",
      "\\ No newline at end of file",
      "settings/x/settings.json: staged for deletion; the file is still in the working tree",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]).toMatchObject({ path: "font.woff", binary: true });
    const script = parsed.files[1]!;
    expect(script.oldMode).toBe("100644");
    expect(script.newMode).toBe("100755");
    expect(script.hunks[0]!.lines.map((line) => line.noNewline)).toEqual([
      true,
      true,
    ]);
    expect(script.notes).toEqual([
      "settings/x/settings.json: staged for deletion; the file is still in the working tree",
    ]);
  });

  test("a mode-only change carries its labels first", () => {
    const text = [
      "--- run.sh (locked)",
      "+++ run.sh (installed)",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(text);
    expect(parsed.files[0]).toMatchObject({
      path: "run.sh",
      oldMode: "100644",
      newMode: "100755",
      hunks: [],
    });
  });

  test("an empty diff has no files", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], notes: [] });
  });
});

describe("sideBySideRows", () => {
  test("pairs a deleted run with the added run that follows it", () => {
    const hunk = parseUnifiedDiff(INSTALLED).files[0]!.hunks[0]!;
    const rows = sideBySideRows(hunk);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({
      left: { no: 3, text: "Flag every raw query.", kind: "del" },
      right: { no: 3, text: "Flag every f-string in a query.", kind: "add" },
      changed: true,
    });
    expect(rows[3]!.changed).toBe(false);
  });

  test("leaves empty cells when the runs differ in length", () => {
    const text = [
      "--- a (locked)",
      "+++ a (installed)",
      "@@ -1,2 +1,3 @@",
      "-one",
      "+uno",
      "+dos",
      " end",
      "",
    ].join("\n");
    const rows = sideBySideRows(parseUnifiedDiff(text).files[0]!.hunks[0]!);
    expect(rows[0]!.left?.text).toBe("one");
    expect(rows[0]!.right?.text).toBe("uno");
    expect(rows[1]!.left).toBeNull();
    expect(rows[1]!.right?.text).toBe("dos");
  });
});

describe("threeWayRows", () => {
  test("aligns installed and shelf changes on the locked line numbers", () => {
    const installed = parseUnifiedDiff(INSTALLED).files[0]!;
    const shelf = parseUnifiedDiff(UPSTREAM).files[0]!;
    const rows = threeWayRows(installed, shelf);
    const lines = rows.map((row) => [
      row.kind,
      row.locked?.no ?? null,
      row.installed ? `${row.installed.kind}:${row.installed.text}` : null,
      row.shelf ? `${row.shelf.kind}:${row.shelf.text}` : null,
    ]);
    expect(lines).toEqual([
      ["line", 1, "same:# Security review", "same:# Security review"],
      ["line", 2, "same:", "same:"],
      ["line", 3, "del:", "same:Flag every raw query."],
      [
        "line",
        null,
        "add:Flag every f-string in a query.",
        "add:Parameterized queries are assumed.",
      ],
      ["line", 4, "same:Done.", "same:Done."],
    ]);
    // The installed side knows line numbers it changed; the shelf side keeps its own.
    expect(rows[3]!.installed?.no).toBe(3);
    expect(rows[3]!.shelf?.no).toBe(4);
  });

  test("marks a jump in locked lines as a gap and tolerates a missing side", () => {
    const text = [
      "--- a (locked)",
      "+++ a (upstream)",
      "@@ -1,2 +1,2 @@",
      " first",
      "-second",
      "+SECOND",
      "@@ -10,2 +10,2 @@",
      " tenth",
      "-eleventh",
      "+ELEVENTH",
      "",
    ].join("\n");
    const rows = threeWayRows(null, parseUnifiedDiff(text).files[0]!);
    expect(rows.map((row) => row.kind)).toEqual([
      "line",
      "line",
      "line",
      "gap",
      "line",
      "line",
      "line",
    ]);
    // With no installed diff, the installed column repeats the locked text
    // and carries no line number.
    expect(rows[1]).toMatchObject({
      installed: { kind: "same", no: null, text: "second" },
      locked: { no: 2, text: "second" },
      shelf: { kind: "del", text: "" },
    });
  });
});
