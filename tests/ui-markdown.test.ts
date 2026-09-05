import { describe, expect, test } from "bun:test";
import {
  parseInlines,
  parseMarkdown,
  safeHref,
  splitFrontmatter,
} from "../src/ui/shared/markdown";

describe("splitFrontmatter", () => {
  test("separates a closed block and tolerates a BOM and CRLF", () => {
    const text = "﻿---\r\nname: x\r\ndescription: y\r\n---\r\n# Title\r\n";
    expect(splitFrontmatter(text)).toEqual({
      frontmatter: "name: x\ndescription: y",
      body: "# Title\n",
    });
  });

  test("an unclosed block is body text", () => {
    const text = "---\nname: x\n# Title\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
});

describe("parseMarkdown", () => {
  test("reads headings, paragraphs, lists, fences, quotes, rules, and tables", () => {
    const text = [
      "# Skill",
      "",
      "One line",
      "two lines.",
      "",
      "- first",
      "- second",
      "  continued",
      "",
      "1. a",
      "2) b",
      "",
      "```bash",
      "echo hi",
      "```",
      "",
      "> quoted",
      "",
      "---",
      "",
      "| a | b |",
      "|---|---|",
    ].join("\n");
    const blocks = parseMarkdown(text).blocks;
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "code",
      "quote",
      "rule",
      "pre",
    ]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(blocks[1]).toMatchObject({
      children: [{ type: "text", text: "One line two lines." }],
    });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [
        [{ type: "text", text: "first" }],
        [{ type: "text", text: "second continued" }],
      ],
    });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toMatchObject({ lang: "bash", text: "echo hi" });
    expect(blocks[7]).toMatchObject({ text: "| a | b |\n|---|---|" });
  });

  test("a fence keeps its content verbatim, blank lines included", () => {
    const text = "```\nline\n\n  indented\n```\n";
    expect(parseMarkdown(text).blocks).toEqual([
      { type: "code", lang: "", text: "line\n\n  indented" },
    ]);
  });
});

describe("parseInlines", () => {
  test("reads code, strong, emphasis, links, and autolinks", () => {
    expect(
      parseInlines(
        "run `capshelf add` **now** or *later* [docs](https://x.test/a) <https://y.test>",
      ),
    ).toEqual([
      { type: "text", text: "run " },
      { type: "code", text: "capshelf add" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "now" }] },
      { type: "text", text: " or " },
      { type: "em", children: [{ type: "text", text: "later" }] },
      { type: "text", text: " " },
      {
        type: "link",
        children: [{ type: "text", text: "docs" }],
        href: "https://x.test/a",
      },
      { type: "text", text: " " },
      {
        type: "link",
        children: [{ type: "text", text: "https://y.test" }],
        href: "https://y.test",
      },
    ]);
  });

  test("markup inside code stays text", () => {
    expect(parseInlines("`**not bold**`")).toEqual([
      { type: "code", text: "**not bold**" },
    ]);
  });
});

describe("safeHref", () => {
  test("allows http, https, mailto, and relative targets only", () => {
    expect(safeHref("https://example.test/x")).toBe("https://example.test/x");
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeHref("./guide.md")).toBe("./guide.md");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
  });
});
