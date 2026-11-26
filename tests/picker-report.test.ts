import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { reportItemFailure } from "../src/commands/picker-report";
import { PreconditionError, ResultExitError } from "../src/errors";

let lines: string[] = [];
const spy = spyOn(console, "error").mockImplementation((...values) => {
  lines.push(values.map(String).join(" "));
});

afterEach(() => {
  lines = [];
});

void spy;

describe("reportItemFailure", () => {
  test("prints the full message and a retry for a plain refusal", () => {
    reportItemFailure(
      "settings/x",
      new PreconditionError("value changed while the picker was open"),
      "capshelf share settings/x",
    );
    expect(lines).toEqual([
      "✗ settings/x — value changed while the picker was open",
      "  retry: capshelf share settings/x",
    ]);
  });

  test("keeps every line of a multi-line message and drops the redundant retry", () => {
    // Promote's stale refusal puts its resolution commands after the first
    // line; a plain retry would fail the same way.
    reportItemFailure(
      "skills/hello",
      new PreconditionError(
        "skills/hello changed in the data repo\n  merge:\n    capshelf update skills/hello --merge",
      ),
      "capshelf promote skills/hello",
    );
    expect(lines[0]).toBe(
      "✗ skills/hello — skills/hello changed in the data repo",
    );
    expect(lines).toContain("    capshelf update skills/hello --merge");
    expect(lines.join("\n")).not.toContain("retry:");
  });

  test("preserves a structured CliError hint the CLI boundary would have printed", () => {
    // The interactive loops catch errors before cli.ts prints the hint, so the
    // reporter must print it or the user is left without the migrate
    // instruction.
    reportItemFailure(
      "skills/hello",
      new PreconditionError("lock is version 3", {
        hint: "run capshelf lock migrate first",
      }),
      "capshelf promote skills/hello",
    );
    expect(lines).toEqual([
      "✗ skills/hello — lock is version 3",
      "  run capshelf lock migrate first",
    ]);
  });

  test("a multi-line message without its own command still gets the retry", () => {
    reportItemFailure(
      "settings/x",
      new PreconditionError("something broke\n  details follow"),
      "capshelf share settings/x",
    );
    expect(lines).toContain("  retry: capshelf share settings/x");
  });

  test("a ResultExitError prints only the retry — its detail was already reported", () => {
    reportItemFailure(
      "settings/x",
      new ResultExitError(3),
      "capshelf share settings/x",
    );
    expect(lines).toEqual(["  retry: capshelf share settings/x"]);
  });
});
