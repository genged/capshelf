import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertBundleInstallable,
  isBundleRef,
  listBundles,
  loadBundle,
  loadBundleStrict,
  memberCountSummary,
  memberRef,
  parseBundleText,
} from "../src/bundles";
import { NotFoundError, PreconditionError } from "../src/errors";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-bundles-"));
}

function refs(bundle: { members: { kind: string; name: string }[] }): string[] {
  return bundle.members.map((m) => `${m.kind}/${m.name}`);
}

describe("parseBundleText", () => {
  test("parses the full schema with flow lists", () => {
    const bundle = parseBundleText(
      [
        "description: Everything a Go backend service needs.",
        "tags: [go, backend]",
        "includes:",
        "  skills:   [security-review, go-test-writer]",
        "  settings: [permissions-base, permissions-go]",
        "  mcp:      [github, postgres-local]",
        "  codex-config: [defaults]",
        "",
      ].join("\n"),
      "go-backend",
      "/data/bundles/go-backend.yml",
    );

    expect(bundle.description).toBe("Everything a Go backend service needs.");
    expect(bundle.tags).toEqual(["go", "backend"]);
    expect(refs(bundle)).toEqual([
      "skills/security-review",
      "skills/go-test-writer",
      "settings/permissions-base",
      "settings/permissions-go",
      "mcp/github",
      "mcp/postgres-local",
      "codex-config/defaults",
    ]);
    expect(bundle.warnings).toEqual([]);
    expect(bundle.unknownKinds).toEqual([]);
    expect(bundle.malformed).toBeUndefined();
    expect(memberRef(bundle.members[0]!)).toBe("skills/security-review");
    expect(memberCountSummary(bundle)).toBe(
      "2 skills · 2 settings · 2 mcp · 1 codex-config",
    );
  });

  test("parses block lists and keeps file order within a kind", () => {
    const bundle = parseBundleText(
      [
        "includes:",
        "  settings:",
        "    - permissions-go",
        "    - permissions-base",
        "",
      ].join("\n"),
      "x",
      "/data/bundles/x.yml",
    );
    // Fragment merge order is authored order — never sorted.
    expect(refs(bundle)).toEqual([
      "settings/permissions-go",
      "settings/permissions-base",
    ]);
  });

  test("description and tags are optional; unknown top-level fields ignored", () => {
    const bundle = parseBundleText(
      "includes:\n  skills: [a]\nfuture-field: 42\n",
      "x",
      "/p",
    );
    expect(bundle.description).toBeUndefined();
    expect(bundle.tags).toEqual([]);
    expect(bundle.warnings).toEqual([]);
    expect(refs(bundle)).toEqual(["skills/a"]);
  });

  test("unknown includes kinds populate unknownKinds (incl. bundles:)", () => {
    const bundle = parseBundleText(
      "includes:\n  skills: [a]\n  bundles: [other]\n  agents: [b]\n",
      "x",
      "/p",
    );
    expect(bundle.unknownKinds.sort()).toEqual(["agents", "bundles"]);
    expect(bundle.warnings.join("\n")).toContain('includes kind "bundles"');
    expect(refs(bundle)).toEqual(["skills/a"]);
    expect(() => assertBundleInstallable(bundle)).toThrow(
      /does not support — upgrade capshelf or edit the bundle/,
    );
  });

  test("scalar tags are dropped with a warning, description kept", () => {
    const bundle = parseBundleText(
      "description: ok\ntags: go\nincludes:\n  skills: [a]\n",
      "x",
      "/p",
    );
    expect(bundle.description).toBe("ok");
    expect(bundle.tags).toEqual([]);
    expect(bundle.warnings.join("\n")).toContain(
      '"tags" must be a list of strings',
    );
    // Salvage-level warnings never block install.
    expect(() => assertBundleInstallable(bundle)).not.toThrow();
  });

  test("non-list member sets are flagged and refuse on install", () => {
    const bundle = parseBundleText(
      "includes:\n  skills: security-review\n  mcp: [github]\n",
      "x",
      "/p",
    );
    expect(bundle.invalidIncludes).toEqual(["skills"]);
    expect(refs(bundle)).toEqual(["mcp/github"]);
    expect(() => assertBundleInstallable(bundle)).toThrow(
      /member set is ambiguous/,
    );
  });

  test("invalid member entries are dropped on read and refuse on install", () => {
    const bundle = parseBundleText(
      "includes:\n  skills: [ok, 42, 'a/b', 'a:b']\n",
      "x",
      "/p",
    );
    expect(refs(bundle)).toEqual(["skills/ok"]);
    expect(bundle.invalidIncludes).toEqual(["skills"]);
    expect(() => assertBundleInstallable(bundle)).toThrow(
      /member set is ambiguous/,
    );
  });

  test("duplicate members are deduped with a warning", () => {
    const bundle = parseBundleText(
      "includes:\n  skills: [a, b, a]\n",
      "x",
      "/p",
    );
    expect(refs(bundle)).toEqual(["skills/a", "skills/b"]);
    expect(bundle.warnings).toEqual([
      "bundles/x: duplicate member skills/a — deduped",
    ]);
    expect(() => assertBundleInstallable(bundle)).not.toThrow();
  });

  test("empty bundles parse cleanly", () => {
    for (const text of ["", "includes:\n", "includes:\n  skills: []\n"]) {
      const bundle = parseBundleText(text, "x", "/p");
      expect(bundle.members).toEqual([]);
      expect(bundle.malformed).toBeUndefined();
      expect(() => assertBundleInstallable(bundle)).not.toThrow();
    }
  });

  test("oversize files are malformed", () => {
    const bundle = parseBundleText(
      `description: ${"x".repeat(64 * 1024)}\n`,
      "big",
      "/p",
    );
    expect(bundle.malformed).toContain("larger than 64 KiB");
    expect(() => assertBundleInstallable(bundle)).toThrow(PreconditionError);
  });

  test("unparseable YAML sets malformed without throwing; strict throws", () => {
    const bundle = parseBundleText("includes: [unclosed\n", "x", "/p");
    expect(bundle.malformed).toContain("invalid YAML");
    expect(bundle.members).toEqual([]);
    expect(bundle.warnings.length).toBeGreaterThan(0);
    expect(() => assertBundleInstallable(bundle)).toThrow(PreconditionError);

    const nonMapping = parseBundleText("- a\n- b\n", "x", "/p");
    expect(nonMapping.malformed).toContain("expected a mapping");
  });
});

describe("isBundleRef", () => {
  test("accepts bundles/<name>", () => {
    expect(isBundleRef("bundles/go-backend")).toBe("go-backend");
    expect(isBundleRef("  bundles/x  ")).toBe("x");
  });

  test("rejects invalid bundle refs", () => {
    expect(isBundleRef("bundles/")).toBeNull();
    expect(isBundleRef("bundles/.")).toBeNull();
    expect(isBundleRef("bundles/..")).toBeNull();
    expect(isBundleRef("bundles/a/b")).toBeNull();
    // ":" carries the federation-spec reservation.
    expect(isBundleRef("bundles/a:b")).toBeNull();
    expect(isBundleRef("x")).toBeNull();
    expect(isBundleRef("skills/x")).toBeNull();
    expect(isBundleRef("bundles")).toBeNull();
  });
});

describe("listBundles", () => {
  test("missing bundles/ dir means no bundles", async () => {
    const dataRepo = await tempDir();
    expect(await listBundles(dataRepo)).toEqual({
      bundles: [],
      warnings: [],
    });
  });

  test("reads *.yml, warns on *.yaml, and never throws on parse errors", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(
      join(dataRepo, "bundles", "go-backend.yml"),
      "includes:\n  skills: [a]\n",
    );
    await writeFile(
      join(dataRepo, "bundles", "broken.yml"),
      "includes: [unclosed\n",
    );
    await writeFile(
      join(dataRepo, "bundles", "legacy.yaml"),
      "includes:\n  skills: [b]\n",
    );

    const { bundles, warnings } = await listBundles(dataRepo);
    expect(bundles.map((b) => b.name)).toEqual(["broken", "go-backend"]);
    expect(bundles[0]?.malformed).toContain("invalid YAML");
    expect(refs(bundles[1]!)).toEqual(["skills/a"]);
    expect(bundles[1]?.path).toBe(join(dataRepo, "bundles", "go-backend.yml"));
    expect(warnings).toEqual([
      "bundles/legacy.yaml ignored — rename to legacy.yml",
    ]);
  });
});

describe("loadBundle / loadBundleStrict", () => {
  test("loadBundle returns null for a missing bundle", async () => {
    const dataRepo = await tempDir();
    expect(await loadBundle(dataRepo, "nope")).toBeNull();
  });

  test("loadBundleStrict throws NotFoundError for a missing bundle", async () => {
    const dataRepo = await tempDir();
    await expect(loadBundleStrict(dataRepo, "nope")).rejects.toThrow(
      NotFoundError,
    );
  });

  test("loadBundleStrict hints at a same-stem .yaml file", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(
      join(dataRepo, "bundles", "x.yaml"),
      "includes:\n  skills: [a]\n",
    );
    await expect(loadBundleStrict(dataRepo, "x")).rejects.toThrow(
      /rename it to x\.yml/,
    );
  });

  test("loadBundleStrict refuses malformed and unknown-kind bundles", async () => {
    const dataRepo = await tempDir();
    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(join(dataRepo, "bundles", "bad.yml"), "[broken\n");
    await writeFile(
      join(dataRepo, "bundles", "newer.yml"),
      "includes:\n  skills: [a]\n  agents: [b]\n",
    );
    await writeFile(
      join(dataRepo, "bundles", "ok.yml"),
      "includes:\n  skills: [a]\n",
    );

    await expect(loadBundleStrict(dataRepo, "bad")).rejects.toThrow(
      PreconditionError,
    );
    await expect(loadBundleStrict(dataRepo, "newer")).rejects.toThrow(
      /upgrade capshelf or edit the bundle/,
    );
    const ok = await loadBundleStrict(dataRepo, "ok");
    expect(refs(ok)).toEqual(["skills/a"]);
  });
});
