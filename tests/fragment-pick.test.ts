import { describe, expect, test } from "bun:test";
import { extractPickedFragment, pickPathSegments } from "../src/fragment-pick";
import {
  fragmentSourceCandidates,
  type FragmentSource,
} from "../src/fragments";
import type { FragmentItemKind } from "../src/master";

function sourceFor(
  kind: FragmentItemKind,
  name: string,
  index = 0,
): FragmentSource {
  const source = fragmentSourceCandidates(kind, name)[index];
  if (!source) throw new Error(`no source candidate ${kind}/${name}[${index}]`);
  return source;
}

describe("pickPathSegments", () => {
  test("splits settings paths on dots", () => {
    expect(
      pickPathSegments(
        sourceFor("settings", "permissions"),
        "permissions.allow",
      ),
    ).toEqual(["permissions", "allow"]);
  });

  test("treats bare mcp picks as claude server names", () => {
    expect(pickPathSegments(sourceFor("mcp", "github", 0), "github")).toEqual([
      "mcpServers",
      "github",
    ]);
  });

  test("treats bare mcp picks as codex server names", () => {
    expect(pickPathSegments(sourceFor("mcp", "github", 1), "github")).toEqual([
      "mcp_servers",
      "github",
    ]);
  });

  test("keeps explicit mcp container paths", () => {
    expect(
      pickPathSegments(sourceFor("mcp", "github", 0), "mcpServers.github"),
    ).toEqual(["mcpServers", "github"]);
  });

  test("rejects empty path segments", () => {
    expect(() =>
      pickPathSegments(
        sourceFor("settings", "permissions"),
        "permissions..allow",
      ),
    ).toThrow('invalid --pick path "permissions..allow"');
  });
});

describe("extractPickedFragment", () => {
  const settingsSource = sourceFor("settings", "permissions");

  test("extracts unmanaged values at the picked paths", () => {
    const extracted = extractPickedFragment({
      source: settingsSource,
      picks: ["permissions.allow", "model"],
      current: {
        permissions: { allow: ["Bash(git status *)"], deny: ["Bash(rm *)"] },
        model: "opus",
      },
      managed: { permissions: { deny: ["Bash(rm *)"] } },
      managedFragments: [],
      outputLabel: ".claude/settings.json",
    });
    expect(extracted).toEqual({
      permissions: { allow: ["Bash(git status *)"] },
      model: "opus",
    });
  });

  test("extracts only the unmanaged remainder of an array", () => {
    const extracted = extractPickedFragment({
      source: settingsSource,
      picks: ["permissions.deny"],
      current: { permissions: { deny: ["Bash(rm *)", "Bash(curl *)"] } },
      managed: { permissions: { deny: ["Bash(rm *)"] } },
      managedFragments: [],
      outputLabel: ".claude/settings.json",
    });
    expect(extracted).toEqual({ permissions: { deny: ["Bash(curl *)"] } });
  });

  test("rejects picks that are already managed, naming the owner", () => {
    expect(() =>
      extractPickedFragment({
        source: settingsSource,
        picks: ["permissions.deny"],
        current: { permissions: { deny: ["Bash(rm *)"] } },
        managed: { permissions: { deny: ["Bash(rm *)"] } },
        managedFragments: [
          {
            source: sourceFor("settings", "security"),
            value: { permissions: { deny: ["Bash(rm *)"] } },
          },
        ],
        outputLabel: ".claude/settings.json",
      }),
    ).toThrow(
      ".claude/settings.json value at permissions.deny is already managed by settings/security",
    );
  });

  test("rejects picks with no value in the output", () => {
    expect(() =>
      extractPickedFragment({
        source: settingsSource,
        picks: ["statusLine"],
        current: { model: "opus" },
        managed: {},
        managedFragments: [],
        outputLabel: ".claude/settings.json",
      }),
    ).toThrow(".claude/settings.json has no unmanaged value at statusLine");
  });
});
