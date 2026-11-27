import { describe, expect, test } from "bun:test";
import {
  BODY_LINE_BUDGET,
  CHECK_IDS,
  DESCRIPTION_TOKEN_BUDGET,
  MAX_DESCRIPTION_CHARS,
  estimateTokens,
  lintResult,
  lintSkill,
} from "../src/skill-lint";
import type { CheckId, LintCheck, SkillLintInput } from "../src/skill-lint";

const GOOD_BODY = [
  "# Deploy",
  "",
  "1. Build. Run `scripts/build.sh` and check that it exits 0.",
  "2. Ship. Read [the notes](references/notes.md), then run `make ship`.",
  "",
  "## Troubleshooting",
  "",
  "| Failure | Fix |",
  "|---|---|",
  "| build fails | run `make clean`, then build again |",
  "",
];

function skill(
  frontmatter: string[] | null,
  body: string[] = GOOD_BODY,
): string {
  const head = frontmatter === null ? [] : ["---", ...frontmatter, "---", ""];
  return [...head, ...body].join("\n");
}

function input(overrides: Partial<SkillLintInput> = {}): SkillLintInput {
  return {
    name: "deploy",
    files: ["SKILL.md", "scripts/build.sh", "references/notes.md"],
    skillMd: skill(["name: deploy", "description: Deploy the service."]),
    ...overrides,
  };
}

function check(checks: LintCheck[], id: CheckId): LintCheck {
  const found = checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return found;
}

describe("lintSkill", () => {
  test("a complete skill passes every check in a fixed order", () => {
    const checks = lintSkill(input());
    expect(checks.map((entry) => entry.id)).toEqual([...CHECK_IDS]);
    expect(checks.filter((entry) => entry.status !== "pass")).toEqual([]);
    expect(lintResult(checks)).toBe("pass");
  });

  test("a missing SKILL.md fails and skips the other checks", () => {
    const checks = lintSkill(input({ skillMd: null, files: [] }));
    expect(check(checks, "skill-md").status).toBe("fail");
    expect(checks.slice(1).every((entry) => entry.status === "skip")).toBe(
      true,
    );
    expect(checks).toHaveLength(CHECK_IDS.length);
    expect(lintResult(checks)).toBe("fail");
  });

  test("absent, unclosed, invalid, and non-mapping frontmatter fail", () => {
    const cases = [
      skill(null),
      "---\nname: deploy\n",
      skill(["name: [unclosed"]),
      skill(["- a", "- b"]),
    ];
    for (const skillMd of cases) {
      const checks = lintSkill(input({ skillMd }));
      expect(check(checks, "frontmatter").status).toBe("fail");
      expect(check(checks, "name").status).toBe("skip");
      expect(check(checks, "description").status).toBe("skip");
    }
  });

  test("frontmatter over 16 KiB fails with the metadata parser's reason", () => {
    const checks = lintSkill(
      input({
        skillMd: skill(["name: deploy", `description: ${"x".repeat(17_000)}`]),
      }),
    );
    expect(check(checks, "frontmatter").message).toContain("16 KiB");
  });

  test("a name that differs from the directory fails; a missing name warns", () => {
    const mismatch = lintSkill(
      input({ skillMd: skill(["name: other", "description: d"]) }),
    );
    expect(check(mismatch, "name").status).toBe("fail");
    expect(check(mismatch, "name").message).toContain('"other"');

    const missing = lintSkill(input({ skillMd: skill(["description: d"]) }));
    expect(check(missing, "name").status).toBe("warn");
  });

  test("description: missing or empty fails, over budget warns, over the cap fails", () => {
    const status = (description: string | null): string =>
      check(
        lintSkill(
          input({
            skillMd: skill(
              description === null
                ? ["name: deploy"]
                : ["name: deploy", `description: "${description}"`],
            ),
          }),
        ),
        "description",
      ).status;
    expect(status(null)).toBe("fail");
    expect(status("   ")).toBe("fail");
    expect(status("x".repeat(DESCRIPTION_TOKEN_BUDGET * 4))).toBe("pass");
    expect(status("x".repeat(DESCRIPTION_TOKEN_BUDGET * 4 + 1))).toBe("warn");
    expect(status("x".repeat(MAX_DESCRIPTION_CHARS + 1))).toBe("fail");
  });

  test("estimateTokens counts code points, four per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("😀😀😀😀")).toBe(1);
  });

  test("a body over the line budget warns and does not fail", () => {
    const body = [...GOOD_BODY, ...Array(BODY_LINE_BUDGET).fill("text")];
    const checks = lintSkill(
      input({ skillMd: skill(["name: deploy", "description: d"], body) }),
    );
    expect(check(checks, "body-lines").status).toBe("warn");
    expect(lintResult(checks)).toBe("warn");
  });

  test("relative links must resolve inside the item", () => {
    const body = [
      ...GOOD_BODY,
      "See [a](references/notes.md#part), [b](scripts/), [c](missing.md),",
      "[d](../other/SKILL.md), [e](/etc/passwd), [f](https://example.com),",
      "[g](#troubleshooting), and ![h](assets/logo%20one.png).",
      "",
      "| col | link |",
      "|---|---|",
      "| x | [i](table-missing.md) |",
    ];
    const checks = lintSkill(
      input({
        files: [
          "SKILL.md",
          "scripts/build.sh",
          "references/notes.md",
          "assets/logo one.png",
        ],
        skillMd: skill(["name: deploy", "description: d"], body),
      }),
    );
    const links = check(checks, "links");
    expect(links.status).toBe("fail");
    expect(links.details).toEqual([
      "../other/SKILL.md: points outside the item",
      "/etc/passwd: absolute path",
      "missing.md: no such file",
      "table-missing.md: no such file",
    ]);
  });

  test("links inside code are not links", () => {
    const body = ["```", "[x](missing.md)", "```", ...GOOD_BODY];
    const checks = lintSkill(
      input({ skillMd: skill(["name: deploy", "description: d"], body) }),
    );
    expect(check(checks, "links").status).toBe("pass");
  });

  test("a missing scripts/, references/, or assets/ path in code warns", () => {
    const body = [
      ...GOOD_BODY,
      "Run `bash scripts/missing.sh --all`.",
      "",
      "```bash",
      'python "references/gone.md"',
      "ls src/not-checked.ts",
      "```",
    ];
    const checks = lintSkill(
      input({ skillMd: skill(["name: deploy", "description: d"], body) }),
    );
    const refs = check(checks, "file-refs");
    expect(refs.status).toBe("warn");
    expect(refs.details).toEqual(["references/gone.md", "scripts/missing.sh"]);
  });

  test("steps: a numbered list or numbered headings pass, prose warns", () => {
    const stepStatus = (body: string[]): string =>
      check(
        lintSkill(
          input({ skillMd: skill(["name: deploy", "description: d"], body) }),
        ),
        "steps",
      ).status;
    expect(stepStatus(["Do the thing.", "Then the other."])).toBe("warn");
    expect(stepStatus(["1. only one"])).toBe("warn");
    expect(stepStatus(["## Step 1: build", "x", "## Step 2: ship", "y"])).toBe(
      "pass",
    );
    expect(stepStatus(["### 1. Build", "x", "### 2. Ship", "y"])).toBe("pass");
  });

  test("error recovery needs a section with a failure table and real fixes", () => {
    const recovery = (body: string[]): LintCheck =>
      check(
        lintSkill(
          input({ skillMd: skill(["name: deploy", "description: d"], body) }),
        ),
        "error-recovery",
      );
    expect(recovery(["1. a", "2. b"]).status).toBe("warn");
    expect(
      recovery(["## Errors", "", "If it fails, try again."]).message,
    ).toContain("no table");
    const retryOnly = recovery([
      "## Errors",
      "",
      "| Failure | Fix |",
      "|---|---|",
      "| timeout | Try again. |",
      "| crash | retry |",
    ]);
    expect(retryOnly.status).toBe("warn");
    expect(retryOnly.message).toContain("try again");
    const laterTable = recovery([
      "## Troubleshooting",
      "",
      "Words.",
      "## Other",
      "",
      "| Failure | Fix |",
      "|---|---|",
      "| x | y |",
    ]);
    expect(laterTable.status).toBe("warn");
  });

  test("style heuristics warn and never fail", () => {
    const checks = lintSkill(
      input({ skillMd: skill(["name: deploy", "description: d"], ["Text."]) }),
    );
    expect(check(checks, "steps").status).toBe("warn");
    expect(check(checks, "error-recovery").status).toBe("warn");
    expect(lintResult(checks)).toBe("warn");
  });
});
