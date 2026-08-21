import { describe, expect, test } from "bun:test";
import { pathsCollide } from "../src/path-collision";

describe("pathsCollide", () => {
  test("uses measured case folding for ancestor collisions", () => {
    expect(
      pathsCollide("Generated", "generated/file.md", {
        caseFolding: true,
        normalizationFolding: false,
      }),
    ).toBe(true);
    expect(
      pathsCollide("Generated", "generated/file.md", {
        caseFolding: false,
        normalizationFolding: false,
      }),
    ).toBe(false);
  });

  test("uses measured Unicode normalization for ancestor collisions", () => {
    expect(
      pathsCollide("Ge\u0301ne\u0301rated", "G\u00e9n\u00e9rated/file.md", {
        caseFolding: false,
        normalizationFolding: true,
      }),
    ).toBe(true);
  });
});
