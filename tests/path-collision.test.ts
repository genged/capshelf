import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  findDestinationPathCollision,
  pathsCollide,
} from "../src/path-collision";
import { probeDestinationFolding } from "../src/pin";
import { tempDir } from "./cli-fixtures";

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

describe("findDestinationPathCollision", () => {
  test("reports an exact or ancestor collision with the matching entries", async () => {
    const destination = await tempDir("capshelf-collision-");
    try {
      expect(
        await findDestinationPathCollision(destination, ["x", "a"], ["a"]),
      ).toEqual({ left: "a", right: "a" });
      expect(
        await findDestinationPathCollision(destination, ["x", "a"], ["a/b.md"]),
      ).toEqual({ left: "a", right: "a/b.md" });
      expect(
        await findDestinationPathCollision(destination, ["a/b.md"], ["a"]),
      ).toEqual({ left: "a/b.md", right: "a" });
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("returns null for disjoint paths", async () => {
    const destination = await tempDir("capshelf-collision-");
    try {
      expect(
        await findDestinationPathCollision(
          destination,
          ["a/one.md", "b"],
          ["a/two.md", "c/d"],
        ),
      ).toBeNull();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("follows the probed folding for a case-only pair", async () => {
    const destination = await tempDir("capshelf-collision-");
    try {
      const { caseFolding } = await probeDestinationFolding(destination);
      expect(
        await findDestinationPathCollision(
          destination,
          ["Readme.md"],
          ["README.md"],
        ),
      ).toEqual(caseFolding ? { left: "Readme.md", right: "README.md" } : null);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  test("follows the probed folding for a normalization-only pair", async () => {
    const destination = await tempDir("capshelf-collision-");
    try {
      const { normalizationFolding } =
        await probeDestinationFolding(destination);
      const left = "caf\u00e9.md";
      const right = "cafe\u0301.md";
      expect(
        await findDestinationPathCollision(destination, [left], [right]),
      ).toEqual(normalizationFolding ? { left, right } : null);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
