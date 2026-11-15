import { describe, expect, test } from "bun:test";
import { hashNamedContents } from "../src/content-hash";

describe("hashNamedContents", () => {
  // Golden value: changing this digest silently invalidates every existing
  // lockfile, so it must be a deliberate, versioned break.
  test("pins the digest for a known input", () => {
    expect(
      hashNamedContents([
        { name: "SKILL.md", content: "hello\n" },
        { name: "café.md", content: "accent\n" },
      ]),
    ).toBe("2d5de8dd9b63");
  });

  test("is independent of input order (sorts by name)", () => {
    const a = hashNamedContents([
      { name: "b", content: "2" },
      { name: "a", content: "1" },
    ]);
    const b = hashNamedContents([
      { name: "a", content: "1" },
      { name: "b", content: "2" },
    ]);
    expect(a).toBe(b);
  });

  test("hashes string and byte content identically", () => {
    const asString = hashNamedContents([{ name: "x", content: "héllo" }]);
    const asBytes = hashNamedContents([
      { name: "x", content: new TextEncoder().encode("héllo") },
    ]);
    expect(asString).toBe(asBytes);
  });

  test("name and content are framed so they cannot collide", () => {
    // Without NUL framing, {ab, c} and {a, bc} would hash the same.
    const one = hashNamedContents([{ name: "ab", content: "c" }]);
    const two = hashNamedContents([{ name: "a", content: "bc" }]);
    expect(one).not.toBe(two);
  });
});
