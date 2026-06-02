import { describe, expect, test } from "bun:test";
import { assertNever } from "../src/assert";

describe("assertNever", () => {
  test("throws with the offending value when reached at runtime", () => {
    // Cast through unknown because callers only reach this with a value the
    // type system believed impossible (e.g. data from outside the union).
    expect(() => assertNever("surprise" as unknown as never)).toThrow(
      /unexpected value: "surprise"/,
    );
  });
});
