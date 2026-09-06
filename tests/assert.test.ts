import { describe, expect, test } from "bun:test";
import { assertNever } from "../src/assert";

describe("assertNever", () => {
  test("throws with the offending value when reached at runtime", () => {
    // SAFETY: the test reaches assertNever with a value the type system calls
    // impossible. `never` is comparable to string, so one assertion is enough.
    expect(() => assertNever("surprise" as never)).toThrow(
      /unexpected value: "surprise"/,
    );
  });
});
