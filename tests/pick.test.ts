import { describe, expect, test } from "bun:test";
import {
  borrowTerminalWidth,
  pickItems,
  pickTerminalUnavailable,
  pickUnavailableMessage,
  setPickContext,
} from "../src/pick";
import type { PickContext, PickRequest } from "../src/pick";
import type { PickRow } from "../src/pick-core";

function row(ref: string, extra: Partial<PickRow> = {}): PickRow {
  const [kind = "skills", ...rest] = ref.split("/");
  return {
    ref,
    kind: kind as PickRow["kind"],
    name: rest.join("/"),
    tags: [],
    installed: false,
    ...extra,
  };
}

const ROWS = [
  row("skills/security-review", { description: "Find vulnerabilities" }),
  row("skills/code-review"),
  row("mcp/postgres-local", { kind: "mcp", installed: true }),
];

function context(overrides: Partial<PickContext> = {}): PickContext {
  return {
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async () => ({ kind: "picked", refs: [] }),
    ...overrides,
  };
}

describe("pickItems terminal gating", () => {
  const never: PickContext["prompt"] = async () => {
    throw new Error("the prompt must not be reached");
  };

  test("reports unavailable without a stdin terminal", async () => {
    const result = await pickItems(
      { rows: ROWS, message: "pick" },
      context({ stdinIsTTY: false, prompt: never }),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "no-terminal" });
  });

  test("reports unavailable without a stderr terminal", async () => {
    // stderr is where the prompt draws, so a redirected stderr is as fatal to
    // it as a redirected stdin.
    const result = await pickItems(
      { rows: ROWS, message: "pick" },
      context({ stderrIsTTY: false, prompt: never }),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "no-terminal" });
  });

  test("reports unavailable rather than drawing an empty list", async () => {
    const result = await pickItems(
      { rows: [], message: "pick" },
      context({ prompt: never }),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "empty-shelf" });
  });

  test("reaches the prompt when both streams are terminals", async () => {
    const result = await pickItems(
      { rows: ROWS, message: "pick" },
      context({
        prompt: async () => ({ kind: "picked", refs: ["skills/code-review"] }),
      }),
    );
    expect(result).toEqual({ kind: "picked", refs: ["skills/code-review"] });
  });

  test("a cancel is distinct from an unavailable picker", async () => {
    // The two mean different things to a caller: `init` stays quiet about a
    // cancel and explains an unavailable one.
    const result = await pickItems(
      { rows: ROWS, message: "pick" },
      context({ prompt: async () => ({ kind: "cancelled" }) }),
    );
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("passes the rows and message through untouched", async () => {
    const seen: PickRequest[] = [];
    await pickItems(
      { rows: ROWS, message: "choose one" },
      context({
        prompt: async (request) => {
          seen.push(request);
          return { kind: "picked", refs: [] };
        },
      }),
    );
    expect(seen[0]?.message).toBe("choose one");
    expect(seen[0]?.rows.map((row) => row.ref)).toEqual(
      ROWS.map((row) => row.ref),
    );
  });
});

describe("setPickContext", () => {
  test("installs a context and returns the previous one for restoring", () => {
    const first = context();
    const second = context();
    const original = setPickContext(first);
    expect(setPickContext(second)).toBe(first);
    setPickContext(original);
  });

  test("the installed context is what pickItems uses by default", async () => {
    const original = setPickContext(
      context({ prompt: async () => ({ kind: "picked", refs: ["skills/x"] }) }),
    );
    try {
      expect(await pickItems({ rows: ROWS, message: "pick" })).toEqual({
        kind: "picked",
        refs: ["skills/x"],
      });
    } finally {
      setPickContext(original);
    }
  });
});

describe("pickTerminalUnavailable", () => {
  test("reports the reason without needing any rows", () => {
    // Callers ask this before reading the data repo, so it must not depend on
    // a row list that is expensive, and refusable, to build.
    expect(pickTerminalUnavailable(context())).toBeNull();
    expect(pickTerminalUnavailable(context({ stdinIsTTY: false }))).toBe(
      "no-terminal",
    );
    expect(pickTerminalUnavailable(context({ stderrIsTTY: false }))).toBe(
      "no-terminal",
    );
  });
});

describe("dumb terminals", () => {
  test("a terminal without capabilities is refused, not drawn on", () => {
    // Measured on TERM=dumb: readline ignores the key argument to its own
    // `write`, so the clear that restores the query never runs. Typing `re`,
    // `←`, `v` left `rerev`, and `Tab` arrived as a literal tab instead of
    // marking a row. A clear refusal beats a prompt that quietly misbehaves.
    expect(pickTerminalUnavailable(context({ capableTerminal: false }))).toBe(
      "dumb-terminal",
    );
  });

  test("an injected context is capable unless it says otherwise", () => {
    // Otherwise every in-process test would depend on the developer's TERM.
    expect(pickTerminalUnavailable(context())).toBeNull();
  });

  test("no terminal at all outranks a dumb one", () => {
    expect(
      pickTerminalUnavailable(
        context({ stdinIsTTY: false, capableTerminal: false }),
      ),
    ).toBe("no-terminal");
  });

  test("refusing reaches pickItems, which never prompts", async () => {
    const result = await pickItems(
      { rows: ROWS, message: "pick" },
      context({
        capableTerminal: false,
        prompt: async () => {
          throw new Error("the prompt must not be reached");
        },
      }),
    );
    expect(result).toEqual({ kind: "unavailable", reason: "dumb-terminal" });
  });
});

describe("pickUnavailableMessage", () => {
  test("explains each reason in words a user can act on", () => {
    expect(pickUnavailableMessage("no-terminal")).toBe(
      "no interactive terminal",
    );
    expect(pickUnavailableMessage("empty-shelf")).toBe(
      "the data repo has no items or bundles yet",
    );
    expect(pickUnavailableMessage("dumb-terminal")).toBe(
      "TERM=dumb cannot draw a full-screen prompt",
    );
  });
});

describe("borrowTerminalWidth", () => {
  /**
   * `@clack/core` measures wrapping and cursor rewind with
   * `process.stdout.columns`, not with the stream it draws on. The picker draws
   * on stderr, so `capshelf add > out.txt` left that number undefined and every
   * redraw rewound too few lines. Measured on a 40-column terminal: 49 lines
   * rewound with stdout on the terminal against 40 with it redirected.
   */
  // Read and write through accessors: assigning `undefined` to a typed local
  // narrows it, and the assertions below compare against a number.
  const columns = (): number | undefined =>
    (process.stdout as { columns?: number }).columns;
  const setColumns = (value: number | undefined): void => {
    (process.stdout as { columns?: number }).columns = value;
  };

  test("lends the terminal width when stdout has none, and gives it back", () => {
    const original = columns();
    setColumns(undefined);
    try {
      const restore = borrowTerminalWidth();
      expect(columns()).toBe(process.stderr.columns);
      restore();
      expect(columns()).toBeUndefined();
    } finally {
      setColumns(original);
    }
  });

  test("leaves a real stdout width alone", () => {
    // Borrowing over a genuine width would report the wrong terminal size for
    // whatever else writes to stdout.
    const original = columns();
    setColumns(123);
    try {
      const restore = borrowTerminalWidth();
      expect(columns()).toBe(123);
      restore();
      expect(columns()).toBe(123);
    } finally {
      setColumns(original);
    }
  });

  test("removes its resize listener on restore", () => {
    const original = columns();
    setColumns(undefined);
    const before = process.stderr.listenerCount("resize");
    try {
      const restore = borrowTerminalWidth();
      expect(process.stderr.listenerCount("resize")).toBe(before + 1);
      restore();
      expect(process.stderr.listenerCount("resize")).toBe(before);
    } finally {
      setColumns(original);
    }
  });
});
