import { expect, test } from "bun:test";
import { shellCommand, shellQuote } from "../src/shell-quote";

test("a plain argument is not quoted", () => {
  expect(shellQuote("plugins/rust-review/skills/rust-review")).toBe(
    "plugins/rust-review/skills/rust-review",
  );
  expect(shellQuote("https://github.com/a/b")).toBe("https://github.com/a/b");
});

test("a space or $( is single-quoted", () => {
  expect(shellQuote("skills/my skill")).toBe("'skills/my skill'");
  expect(shellQuote("x$(rm -rf ~)")).toBe("'x$(rm -rf ~)'");
});

test("a single quote closes, escapes, and reopens", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

test("an empty argument is two quotes", () => {
  expect(shellQuote("")).toBe("''");
});

test("shellCommand joins quoted arguments with spaces", () => {
  expect(shellCommand(["capshelf", "add", "u", "--path", "a b"])).toBe(
    "capshelf add u --path 'a b'",
  );
});
