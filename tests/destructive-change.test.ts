import { describe, expect, test } from "bun:test";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  createDestructiveChangePlan,
  type DestructiveChange,
  type DestructiveConfirmationContext,
  normalizeDestructiveChanges,
} from "../src/destructive-change";
import { PreconditionError } from "../src/errors";

const first: DestructiveChange = {
  scope: "project",
  item: "data/skills/first",
  path: ".agents/skills/first/SKILL.md",
  reason: "managed_content",
  reviewCommand: "capshelf status skills/first --diff",
};

function confirmationContext(answer: string): {
  context: DestructiveConfirmationContext;
  prompts: string[];
  stderr: string[];
} {
  const prompts: string[] = [];
  const stderr: string[] = [];
  return {
    context: {
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async (message) => {
        prompts.push(message);
        return answer;
      },
      stderr: {
        write(text) {
          stderr.push(text);
        },
      },
    },
    prompts,
    stderr,
  };
}

function options(
  overrides: Partial<{
    json: boolean;
    yes: boolean;
    dryRun: boolean;
  }> = {},
) {
  return {
    operation: "Apply",
    json: false,
    yes: false,
    dryRun: false,
    rerunCommand: "capshelf apply --yes",
    ...overrides,
  };
}

describe("destructive change consent", () => {
  test("sorts and deduplicates stable typed records", () => {
    const second: DestructiveChange = {
      scope: "local",
      item: "data/skills/second",
      path: ".agents/skills/second/SKILL.md",
      reason: "executable_mode",
    };
    expect(normalizeDestructiveChanges([second, first, first])).toEqual([
      second,
      first,
    ]);
  });

  test("prompts once with all changes and accepts only explicit yes", async () => {
    const { context, prompts, stderr } = confirmationContext("YES");
    const second: DestructiveChange = {
      scope: "project",
      path: ".claude/settings.json",
      reason: "config_comments",
    };

    expect(
      await confirmDestructiveChanges(
        createDestructiveChangePlan([second, first]),
        options(),
        context,
      ),
    ).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Apply would destroy local state");
    expect(prompts[0]).toContain("data/skills/first");
    expect(prompts[0]).toContain(".claude/settings.json");
    expect(prompts[0]).toContain("capshelf status skills/first --diff");
    expect(prompts[0]).toContain("Continue? [y/N]");
    expect(stderr).toEqual([]);
  });

  test("declines empty and unrelated answers without authorization", async () => {
    for (const answer of ["", "n", "continue"]) {
      const { context, stderr } = confirmationContext(answer);
      expect(
        await confirmDestructiveChanges(
          createDestructiveChangePlan([first]),
          options(),
          context,
        ),
      ).toBe(false);
      expect(stderr.join("")).toContain(
        "Apply cancelled; no changes were written",
      );
    }
  });

  test("refuses JSON and non-interactive runs with review and --yes guidance", async () => {
    for (const context of [
      confirmationContext("yes").context,
      {
        ...confirmationContext("yes").context,
        stdinIsTTY: false,
      },
    ]) {
      const json = context.stdinIsTTY;
      try {
        await confirmDestructiveChanges(
          createDestructiveChangePlan([first]),
          options({ json }),
          context,
        );
        throw new Error("expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(PreconditionError);
        expect((error as PreconditionError).message).toContain(
          ".agents/skills/first/SKILL.md",
        );
        expect((error as PreconditionError).hint).toContain(
          "capshelf status skills/first --diff",
        );
        expect((error as PreconditionError).hint).toContain(
          "capshelf apply --yes",
        );
      }
    }
  });

  test("--yes and dry-run skip only the prompt", async () => {
    for (const override of [{ yes: true }, { dryRun: true }]) {
      const { context, prompts } = confirmationContext("n");
      expect(
        await confirmDestructiveChanges(
          createDestructiveChangePlan([first]),
          options(override),
          context,
        ),
      ).toBe(true);
      expect(prompts).toEqual([]);
    }
  });

  test("invalidates consent when preflight state changes", () => {
    const accepted = createDestructiveChangePlan([first], ["before"]);
    const current = createDestructiveChangePlan([first], ["after"]);
    expect(() => assertDestructivePlanUnchanged(accepted, current)).toThrow(
      /changed after destructive-change preflight/,
    );
  });
});
