import { describe, expect, test } from "bun:test";
import { assertNever, isSafeGitRef } from "../src/assert";

describe("assertNever", () => {
  test("throws with the offending value when reached at runtime", () => {
    // SAFETY: the test reaches assertNever with a value the type system calls
    // impossible. `never` is comparable to string, so one assertion is enough.
    expect(() => assertNever("surprise" as never)).toThrow(
      /unexpected value: "surprise"/,
    );
  });
});

describe("isSafeGitRef", () => {
  test("refuses the single character @", () => {
    expect(isSafeGitRef("@")).toBe(false);
  });

  test("refuses reflog and previous-branch syntax", () => {
    for (const ref of ["main@{1}", "foo@{upstream}", "@{-1}"]) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });

  test("refuses a trailing dot but accepts an inner dot", () => {
    expect(isSafeGitRef("foo.")).toBe(false);
    expect(isSafeGitRef("a.b")).toBe(true);
    expect(isSafeGitRef("v1.0.0")).toBe(true);
  });

  test("accepts plain names", () => {
    for (const ref of ["main", "feature/x", "foo@bar", "refs/heads/main"]) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });
});
