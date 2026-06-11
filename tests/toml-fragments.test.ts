import { describe, expect, test } from "bun:test";
import {
  parseTomlConfigObject,
  stringifyTomlConfig,
} from "../src/toml-fragments";

describe("parseTomlConfigObject", () => {
  test("parses and round-trips plain tables", () => {
    const parsed = parseTomlConfigObject(
      ["[server]", 'name = "api"', "ports = [8080, 8081]", ""].join("\n"),
      "config.toml",
    );
    expect(parsed).toEqual({
      server: { name: "api", ports: [8080, 8081] },
    });
    expect(stringifyTomlConfig(parsed)).toContain('name = "api"');
  });

  test("rejects TOML date values", () => {
    expect(() =>
      parseTomlConfigObject("created = 2026-06-09\n", "config.toml"),
    ).toThrow(
      "config.toml.created contains a TOML date, which capshelf does not support in TOML fragments",
    );
  });

  test("rejects nested TOML date-time values", () => {
    expect(() =>
      parseTomlConfigObject(
        "[meta]\nupdated = 2026-06-09T12:00:00Z\n",
        "config.toml",
      ),
    ).toThrow("config.toml.meta.updated contains a TOML date");
  });
});
