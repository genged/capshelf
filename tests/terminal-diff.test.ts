import { describe, expect, test } from "bun:test";
import { highlightTerminalDiff, truncateAnsiLine } from "../src/terminal-diff";

function stripAnsi(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\x1b" && text[index + 1] === "[") {
      const end = text.indexOf("m", index + 2);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
    }
    out += text[index];
    index++;
  }
  return out;
}

describe("terminal diff syntax highlighting", () => {
  test.each([
    ["index.ts", "const value: number = 1;", "const"],
    ["main.py", "def run(value: int):", "def"],
    ["main.go", "func run(value int) int {", "func"],
    ["main.rs", "fn run(value: i32) -> i32 {", "fn"],
    ["main.c", "int run(int value) {", "int"],
  ])("highlights %s and preserves its source", (path, source, keyword) => {
    const lines = highlightTerminalDiff(
      `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${source}\n`,
    );

    expect(stripAnsi(lines[3]!)).toBe(`+${source}`);
    expect(lines[3]).toContain(`\x1b[35m${keyword}\x1b[0m`);
  });

  test("removes source-controlled terminal commands before it adds ANSI", () => {
    const lines = highlightTerminalDiff(
      "--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+const safe = '\x1b]2;owned\x07';\n",
    );
    const rendered = lines.join("\n");

    expect(rendered).not.toContain("\x1b]");
    expect(rendered).not.toContain("\x07");
    expect(stripAnsi(rendered)).toContain("const safe");
  });

  test("truncates by cells and keeps complete ANSI sequences", () => {
    const line = "\x1b[35mconst\x1b[0m longName = 1";
    const truncated = truncateAnsiLine(line, 10);

    expect(Bun.stringWidth(truncated)).toBeLessThanOrEqual(10);
    expect(truncated).toEndWith("…\x1b[0m");
    expect(stripAnsi(truncated)).toStartWith("const");
  });
});
