import { describe, expect, test } from "bun:test";
import {
  parseTomlConfigObject,
  stringifyTomlConfig,
  validateCodexMcpFragment,
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

describe("validateCodexMcpFragment", () => {
  test("accepts a valid mcp_servers fragment unchanged", () => {
    const parsed = parseTomlConfigObject(
      [
        "[mcp_servers.github]",
        'command = "github-mcp"',
        'args = ["--scope", "repo"]',
        "enabled = true",
        "",
      ].join("\n"),
      "mcp/github/codex.toml",
    );

    expect(validateCodexMcpFragment(parsed, "mcp/github/codex.toml")).toEqual({
      mcp_servers: {
        github: {
          command: "github-mcp",
          args: ["--scope", "repo"],
          enabled: true,
        },
      },
    });
  });

  test("accepts a fragment without mcp_servers", () => {
    const parsed = parseTomlConfigObject(
      'model = "gpt-5"\n',
      "mcp/github/codex.toml",
    );
    expect(validateCodexMcpFragment(parsed, "mcp/github/codex.toml")).toEqual({
      model: "gpt-5",
    });
  });

  test("rejects a non-table mcp_servers value with a labeled error", () => {
    const parsed = parseTomlConfigObject(
      'mcp_servers = "github-mcp"\n',
      "mcp/github/codex.toml",
    );
    expect(() =>
      validateCodexMcpFragment(parsed, "mcp/github/codex.toml"),
    ).toThrow("mcp/github/codex.toml.mcp_servers must be a TOML table");
  });

  test("rejects a non-table server entry with a labeled error", () => {
    const parsed = parseTomlConfigObject(
      '[mcp_servers]\ngithub = "github-mcp"\n',
      "mcp/github/codex.toml",
    );
    expect(() =>
      validateCodexMcpFragment(parsed, "mcp/github/codex.toml"),
    ).toThrow("mcp/github/codex.toml.mcp_servers.github must be a TOML table");
  });
});
