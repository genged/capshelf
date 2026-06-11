import { describe, expect, test } from "bun:test";
import {
  FIELD_WEIGHTS,
  MAX_SEARCHABLE_CONTENT_BYTES,
  compareResults,
  isSearchableContent,
  matchAnnotations,
  matchItem,
  splitTerms,
} from "../src/search-core";
import type { SearchableItem } from "../src/search-core";

const item: SearchableItem = {
  name: "skills/security-review",
  tags: ["Security", "review"],
  description: "Deep multi-pass audit of changed files.",
  files: [
    { relPath: "SKILL.md", content: "Check for SQL injection issues.\n" },
    { relPath: "notes.md", content: "secondary file\n" },
  ],
};

describe("splitTerms", () => {
  test("splits on whitespace and drops empties", () => {
    expect(splitTerms("  sql   injection \n")).toEqual(["sql", "injection"]);
    expect(splitTerms("")).toEqual([]);
  });
});

describe("matchItem", () => {
  test("every term must match (AND)", () => {
    expect(matchItem(["sql", "injection"], item)).not.toBeNull();
    expect(matchItem(["sql", "nonexistent-term"], item)).toBeNull();
  });

  test("matching is case-insensitive in both directions", () => {
    expect(matchItem(["SECURITY"], item)).not.toBeNull();
    // "Security" tag matches a lowercase term too.
    expect(matchItem(["security"], item)?.matches[0]?.field).toBe("name");
  });

  test("returns null for an empty term list", () => {
    expect(matchItem([], item)).toBeNull();
  });

  test("each term scores its best field: name 8, tag 4, description 2, content 1", () => {
    expect(FIELD_WEIGHTS).toEqual({
      name: 8,
      tags: 4,
      description: 2,
      content: 1,
    });
    // "review" hits the name (best), even though it is also a tag.
    expect(matchItem(["review"], item)?.score).toBe(8);
    // tag-only hit.
    const tagOnly = matchItem(["review"], { ...item, name: "skills/x" });
    expect(tagOnly?.score).toBe(4);
    expect(tagOnly?.matches[0]).toEqual({
      term: "review",
      field: "tags",
      detail: "review",
    });
    // description hit.
    expect(matchItem(["audit"], item)?.score).toBe(2);
    // content hit carries the first matching file path.
    const content = matchItem(["sql"], item);
    expect(content?.score).toBe(1);
    expect(content?.matches[0]).toEqual({
      term: "sql",
      field: "content",
      file: "SKILL.md",
      detail: "SKILL.md",
    });
    // multi-term scores sum per-term best weights.
    expect(matchItem(["audit", "sql"], item)?.score).toBe(3);
  });
});

describe("compareResults", () => {
  test("orders by score descending then kind/name ascending", () => {
    const results = [
      { score: 1, name: "skills/zeta" },
      { score: 5, name: "skills/beta" },
      { score: 1, name: "settings/alpha" },
      { score: 5, name: "mcp/alpha" },
    ];
    expect([...results].sort(compareResults)).toEqual([
      { score: 5, name: "mcp/alpha" },
      { score: 5, name: "skills/beta" },
      { score: 1, name: "settings/alpha" },
      { score: 1, name: "skills/zeta" },
    ]);
  });
});

describe("isSearchableContent", () => {
  test("skips files containing a NUL byte", () => {
    expect(
      isSearchableContent("bin.dat", Buffer.from([0x73, 0x00, 0x71])),
    ).toBe(false);
    expect(isSearchableContent("text.md", Buffer.from("plain text"))).toBe(
      true,
    );
  });

  test("skips files over 256 KiB", () => {
    const big = Buffer.alloc(MAX_SEARCHABLE_CONTENT_BYTES + 1, 0x61);
    expect(isSearchableContent("big.md", big)).toBe(false);
    const exact = Buffer.alloc(MAX_SEARCHABLE_CONTENT_BYTES, 0x61);
    expect(isSearchableContent("ok.md", exact)).toBe(true);
  });

  test("skips the metadata sidecar itself but not nested sidecars", () => {
    expect(isSearchableContent(".capshelf.yml", Buffer.from("tags: [a]"))).toBe(
      false,
    );
    expect(
      isSearchableContent("sub/.capshelf.yml", Buffer.from("content")),
    ).toBe(true);
  });
});

describe("matchAnnotations", () => {
  test("renders unique field(detail) pairs in match order", () => {
    expect(
      matchAnnotations([
        { term: "a", field: "tags", detail: "security" },
        { term: "b", field: "content", file: "SKILL.md", detail: "SKILL.md" },
        { term: "c", field: "tags", detail: "security" },
        { term: "d", field: "description" },
      ]),
    ).toEqual(["tags(security)", "content(SKILL.md)", "description"]);
  });
});
