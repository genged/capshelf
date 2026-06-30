import { describe, expect, test } from "bun:test";
import {
  ITEM_KINDS,
  ITEM_KIND_DESCRIPTORS,
  descriptorFor,
  isDirectoryKind,
  isFragmentItemKind,
  isSkillKind,
  itemRepoRelPath,
} from "../src/master";
import { manifestNamesForKind, emptyManifest } from "../src/manifest";

describe("kind descriptor registry", () => {
  test("every kind has a descriptor keyed by itself", () => {
    for (const kind of ITEM_KINDS) {
      const d = descriptorFor(kind);
      expect(d.kind).toBe(kind);
      expect(ITEM_KIND_DESCRIPTORS[kind]).toBe(d);
    }
  });

  test("shapes classify the existing kinds", () => {
    expect(descriptorFor("skills").shape).toBe("skill");
    expect(descriptorFor("settings").shape).toBe("fragment");
    expect(descriptorFor("mcp").shape).toBe("fragment");
    expect(descriptorFor("codex-config").shape).toBe("fragment");
  });

  test("positive predicates replace the negative skills tests", () => {
    expect(isFragmentItemKind("settings")).toBe(true);
    expect(isFragmentItemKind("mcp")).toBe(true);
    expect(isFragmentItemKind("codex-config")).toBe(true);
    expect(isFragmentItemKind("skills")).toBe(false);

    expect(isSkillKind("skills")).toBe(true);
    expect(isSkillKind("settings")).toBe(false);

    // directory kinds = non-fragment (skills today; okf later)
    expect(isDirectoryKind("skills")).toBe(true);
    expect(isDirectoryKind("settings")).toBe(false);
  });

  test("descriptor repoDir/manifestKey match legacy behavior", () => {
    expect(descriptorFor("skills").repoDir).toBe("skills");
    expect(descriptorFor("codex-config").repoDir).toBe("codex/config");
    expect(itemRepoRelPath("skills", "x")).toBe("skills/x");
    expect(itemRepoRelPath("codex-config", "x")).toBe("codex/config/x");

    const m = emptyManifest();
    expect(manifestNamesForKind(m, descriptorFor("codex-config").kind)).toBe(
      m.codexConfig,
    );
  });
});
