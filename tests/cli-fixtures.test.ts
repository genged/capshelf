import { describe, expect, test } from "bun:test";
import { PreconditionError } from "../src/errors";
import { rejection } from "./cli-fixtures";

describe("rejection", () => {
  test("returns the typed error a promise rejects with", async () => {
    const error = await rejection(
      Promise.reject(new PreconditionError("refused", { hint: "fix it" })),
      PreconditionError,
    );
    expect(error.message).toBe("refused");
    expect(error.hint).toBe("fix it");
  });

  test("fails when the promise resolves", async () => {
    await expect(rejection(Promise.resolve(1), Error)).rejects.toThrow(
      "expected Error, but the promise resolved",
    );
  });

  test("fails when the rejection has another type", async () => {
    await expect(
      rejection(Promise.reject(new Error("plain")), PreconditionError),
    ).rejects.toThrow("expected PreconditionError, got Error");
  });
});
