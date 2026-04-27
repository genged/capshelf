import { describe, expect, test } from "bun:test";
import { privateDotenvFiles } from "../src/dotfiles";

describe("dotenv safety policy", () => {
  test("flags common private dotenv files but not shareable templates", () => {
    expect(
      privateDotenvFiles([
        ".env",
        ".env.local",
        ".env.development.local",
        ".env.production",
        ".env.1password",
        ".env.example",
        "nested/.env.test.local",
        "nested/.env.template",
      ]),
    ).toEqual([
      ".env",
      ".env.development.local",
      ".env.local",
      ".env.production",
      "nested/.env.test.local",
    ]);
  });
});
