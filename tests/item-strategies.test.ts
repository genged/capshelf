import { describe, expect, test } from "bun:test";
import { installedPath, itemOutputTargets } from "../src/installed";
import {
  COPY_DIRECTORY_ITEM_KINDS,
  COPY_TARGET_FILE_ITEM_KINDS,
  FRAGMENT_ITEM_KINDS,
  ITEM_KINDS,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMaterializedItemKind,
  itemStrategy,
} from "../src/master";

describe("item strategies", () => {
  test("every public item kind belongs to exactly one explicit strategy", () => {
    expect(ITEM_KINDS).toEqual([
      "skills",
      "pi-extensions",
      "settings",
      "mcp",
      "codex-config",
    ]);

    const groupedKinds = [
      ...COPY_DIRECTORY_ITEM_KINDS,
      ...COPY_TARGET_FILE_ITEM_KINDS,
      ...FRAGMENT_ITEM_KINDS,
    ];
    expect(new Set(groupedKinds)).toEqual(new Set(ITEM_KINDS));

    for (const kind of ITEM_KINDS) {
      const memberships = [
        isCopyDirectoryItemKind(kind),
        isCopyTargetFileItemKind(kind),
        isFragmentItemKind(kind),
      ].filter(Boolean);
      expect(memberships).toHaveLength(1);
      const expectedStrategy = isCopyDirectoryItemKind(kind)
        ? "copy-directory"
        : isCopyTargetFileItemKind(kind)
          ? "copy-target-file"
          : "fragment";
      expect(itemStrategy(kind)).toBe(expectedStrategy);
      expect(isMaterializedItemKind(kind)).toBe(
        itemStrategy(kind) !== "fragment",
      );
    }
  });

  test("copy-directory strategies own their canonical source and output", () => {
    expect(
      itemOutputTargets("/project", "skills", "hello", "codex-compatible"),
    ).toEqual([
      {
        id: "directory",
        canonicalRelPath: "skills/hello",
        outputPath: "/project/.agents/skills/hello",
      },
    ]);
    expect(
      installedPath("/project", "skills", "hello", "codex-compatible"),
    ).toBe("/project/.agents/skills/hello");

    expect(
      itemOutputTargets(
        "/project",
        "pi-extensions",
        "guard",
        "codex-compatible",
      ),
    ).toEqual([
      {
        id: "directory",
        canonicalRelPath: "pi/extensions/guard",
        outputPath: "/project/.pi/extensions/guard",
      },
    ]);
    expect(
      installedPath("/project", "pi-extensions", "guard", "codex-compatible"),
    ).toBe("/project/.pi/extensions/guard");
  });
});
