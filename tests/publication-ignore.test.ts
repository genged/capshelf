import { describe, expect, test } from "bun:test";
import { commitProofRefusalMessage } from "../src/pin";
import { ignoredPublicationMessage } from "../src/publication-ignore";

describe("ignoredPublicationMessage", () => {
  test("a data-repo rule offers removal of the rule first", () => {
    const text = ignoredPublicationMessage(
      ["skills/s/scripts/__pycache__/x.pyc"],
      new Map([
        [
          "skills/s/scripts/__pycache__/x.pyc",
          { source: ".gitignore", line: 3, pattern: "__pycache__/" },
        ],
      ]),
      ["skills/s"],
    );
    expect(text).toBe(
      [
        "the data repo ignores files that this commit must contain",
        "",
        "    skills/s/scripts/__pycache__/x.pyc",
        "      ignored by .gitignore:3  __pycache__/",
        "",
        "  remove the rule from the data repo, or, if the item supplies the file,",
        "  delete it from the item",
        "  the data repo was restored; nothing was published",
      ].join("\n"),
    );
  });

  test("a rule inside an owned root says the commit writes it", () => {
    // A Codex projection copies a canonical skill's own `.gitignore`, so the
    // rule source sits under a generated root, not in the project.
    const path = "codex/generated/plugins/p/skills/s/x.log";
    const text = ignoredPublicationMessage(
      [path],
      new Map([
        [
          path,
          {
            source: "codex/generated/plugins/p/skills/s/.gitignore",
            line: 1,
            pattern: "*.log",
          },
        ],
      ]),
      ["skills/s", "codex/generated"],
    );
    expect(text).toContain(
      "the rule comes from codex/generated/plugins/p/skills/s/.gitignore, which this commit writes;",
    );
    expect(text).not.toContain("remove the rule from the data repo");
  });

  test("a path without a known rule still prints, with the general fix", () => {
    const text = ignoredPublicationMessage(
      ["skills/s/a\u001b[31m"],
      new Map(),
      ["skills/s"],
    );
    expect(text).toContain("    skills/s/a [31m");
    expect(text).not.toContain("ignored by");
    expect(text).toContain("remove the rule from the data repo");
  });

  test("the PIN-11 refusal strips terminal control codes from the rule", () => {
    const text = commitProofRefusalMessage(
      "skills/s",
      [{ path: "x.pyc", candidate: "a".repeat(40), committed: null }],
      () => ({ source: ".gitignore", line: 1, pattern: "[\u001b]*.pyc" }),
    );
    expect(text).toContain("      ignored by .gitignore:1  [ ]*.pyc");
    expect(text).not.toContain("\u001b");
  });
});
