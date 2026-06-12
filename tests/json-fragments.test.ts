import { describe, expect, test } from "bun:test";
import { parseJsonConfigObject } from "../src/json-fragments";

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
});
