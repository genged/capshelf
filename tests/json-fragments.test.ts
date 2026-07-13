import { describe, expect, test } from "bun:test";
import {
  jsonTextHasComments,
  parseJsonConfigObject,
} from "../src/json-fragments";

describe("parseJsonConfigObject", () => {
  test("parses a plain object", () => {
    expect(parseJsonConfigObject('{"mcpServers":{}}', ".mcp.json")).toEqual({
      mcpServers: {},
    });
  });

  test("treats empty input as an empty object", () => {
    expect(parseJsonConfigObject("", ".mcp.json")).toEqual({});
  });

  test("treats whitespace-only input as an empty object", () => {
    expect(parseJsonConfigObject(" \n\t\n", ".mcp.json")).toEqual({});
  });

  test("labels syntax errors with the file path", () => {
    expect(() => parseJsonConfigObject('{"a":', ".mcp.json")).toThrow(
      /^\.mcp\.json: /,
    );
  });

  test("rejects non-object roots", () => {
    expect(() => parseJsonConfigObject("[1, 2]", ".mcp.json")).toThrow(
      ".mcp.json must contain a JSON object",
    );
  });

  test("tolerates JSONC: // and block comments and trailing commas", () => {
    const jsonc = `{
      // opus for the hard repo
      "model": "opus",
      /* block */ "permissions": { "allow": ["Bash(git:*)"], },
    }`;
    expect(parseJsonConfigObject(jsonc, ".claude/settings.json")).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(git:*)"] },
    });
  });

  test("does not treat comment tokens inside strings as comments", () => {
    const raw = '{"url": "https://x/y", "note": "a // b /* c */ d"}';
    expect(parseJsonConfigObject(raw, "x")).toEqual({
      url: "https://x/y",
      note: "a // b /* c */ d",
    });
    expect(jsonTextHasComments(raw)).toBe(false);
  });

  test("jsonTextHasComments detects real comments", () => {
    expect(jsonTextHasComments('{"a":1} // trailing')).toBe(true);
    expect(jsonTextHasComments('{"a":1}')).toBe(false);
  });
});
