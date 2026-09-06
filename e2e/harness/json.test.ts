import { describe, expect, test } from "bun:test";
import {
  asArray,
  asObject,
  asString,
  objectField,
  parseJsonText,
} from "../support/json";

describe("json support", () => {
  test("parses and narrows a document", () => {
    const value = parseJsonText('{"items":[{"key":"a"}]}', "stdout");
    const items = asArray(
      objectField(asObject(value, "stdout"), "items", "stdout"),
      "items",
    );
    expect(
      asString(
        objectField(asObject(items[0] ?? null, "item"), "key", "item"),
        "key",
      ),
    ).toBe("a");
  });

  test("names the label in every failure", () => {
    expect(() => parseJsonText("not json", "stdout")).toThrow("stdout");
    expect(() => asObject([], "rows")).toThrow("rows");
    expect(() => asString(1, "key")).toThrow("key");
  });
});
