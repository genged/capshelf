import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearNeedsPolicyCacheForTests,
  formatDeclaredNeeds,
  needsPolicyForProject,
  needsWarningsForItem,
  runfreeHostAdd,
} from "../src/needs";
import {
  formatRuntimeWarnings,
  isStrictRuntimeWarning,
} from "../src/runtime-warnings";

const needs = {
  network: ["api.example.com", "mcp.exa.ai"],
  env: ["EXA_API_KEY"],
  bin: ["agent-browser"],
};

afterEach(() => {
  clearNeedsPolicyCacheForTests();
});

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-needs-"));
}

describe("Runfree needs checks", () => {
  test("an absent .runfree directory produces no check or output", async () => {
    const project = await tempProject();
    expect(needsPolicyForProject(project).active).toBe(false);
    expect(
      needsWarningsForItem(project, "pi-extensions/exa-mcp", needs),
    ).toEqual([]);
  });

  test("a missing policy in a Runfree project treats every host as unmet", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".runfree"));

    const warnings = needsWarningsForItem(
      project,
      "pi-extensions/exa-mcp",
      needs,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type).toBe("network_needs_unmet");
    expect(warnings[0]?.path).toBe(".runfree/network-policy.json");
    expect(formatRuntimeWarnings(warnings)).toEqual([
      "⚠ pi-extensions/exa-mcp needs network egress this project does not allow:",
      "    api.example.com — allow with: runfree host add api.example.com",
      "    mcp.exa.ai — allow with: runfree host add mcp.exa.ai",
    ]);
    expect(isStrictRuntimeWarning(warnings[0]!)).toBe(false);
  });

  test("policy matching is exact and case-insensitive", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".runfree"));
    await writeFile(
      join(project, ".runfree", "network-policy.json"),
      JSON.stringify({ domains: ["MCP.EXA.AI", "*.example.com"] }),
    );

    const warnings = needsWarningsForItem(
      project,
      "pi-extensions/exa-mcp",
      needs,
    );
    expect(warnings[0]?.message).toContain("api.example.com");
    expect(warnings[0]?.message).not.toContain("mcp.exa.ai — allow with:");
  });

  test("malformed policies skip with one non-strict advisory", async () => {
    for (const text of ["{broken", '{"domains":"example.com"}']) {
      const project = await tempProject();
      await mkdir(join(project, ".runfree"));
      await writeFile(join(project, ".runfree", "network-policy.json"), text);

      const warnings = needsWarningsForItem(project, "skills/x", needs);
      expect(warnings).toEqual([
        {
          type: "needs_check_skipped",
          path: ".runfree/network-policy.json",
          message:
            "could not read .runfree/network-policy.json — needs check skipped",
        },
      ]);
      expect(isStrictRuntimeWarning(warnings[0]!)).toBe(false);
      clearNeedsPolicyCacheForTests();
    }
  });

  test("information and fix-command formatting are centralized", () => {
    expect(formatDeclaredNeeds(needs)).toBe(
      "reads env: EXA_API_KEY · needs on PATH: agent-browser",
    );
    expect(runfreeHostAdd("api.example.com")).toBe(
      "runfree host add api.example.com",
    );
  });
});
