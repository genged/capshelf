import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  METADATA_SIDECAR,
  emptyMetadata,
  extractFrontmatter,
  loadDataItemMetadata,
  loadSystemItemMetadata,
  mergeItemMetadata,
  parseFrontmatter,
  parseSidecar,
  truncatedDescription,
} from "../src/metadata";

describe("parseSidecar", () => {
  test("parses the full schema with block lists", () => {
    const meta = parseSidecar(
      [
        "description: Deep multi-pass security audit of changed files.",
        "tags:",
        "  - security",
        "  - review",
        "requires:",
        "  - settings/permissions-base",
        "conflicts-with:",
        "  - skills/quick-review",
        "",
      ].join("\n"),
      "skills/security-review",
      "security-review",
    );

    expect(meta.description).toBe(
      "Deep multi-pass security audit of changed files.",
    );
    expect(meta.tags).toEqual(["security", "review"]);
    expect(meta.requires).toEqual(["settings/permissions-base"]);
    expect(meta.conflictsWith).toEqual(["skills/quick-review"]);
    expect(meta.warnings).toEqual([]);
  });

  test("parses flow lists, quoted scalars, and comments", () => {
    const meta = parseSidecar(
      [
        'description: "Baseline permission allowlist."  # trailing comment',
        "tags: [security, 'base']",
        "# a full-line comment",
        "requires: [mcp/github, codex-config/defaults]",
        "",
      ].join("\n"),
      "settings/permissions-base",
    );

    expect(meta.description).toBe("Baseline permission allowlist.");
    expect(meta.tags).toEqual(["security", "base"]);
    expect(meta.requires).toEqual(["mcp/github", "codex-config/defaults"]);
    expect(meta.warnings).toEqual([]);
  });

  test("drops a scalar tags field with a warning but keeps the description", () => {
    const meta = parseSidecar(
      "description: kept\ntags: security\n",
      "skills/foo",
    );

    expect(meta.description).toBe("kept");
    expect(meta.tags).toEqual([]);
    expect(meta.warnings).toEqual([
      `skills/foo: ${METADATA_SIDECAR} "tags" must be a list of strings — field ignored`,
    ]);
  });

  test("drops bare-name and unknown-kind refs per entry, keeps qualified refs", () => {
    const meta = parseSidecar(
      [
        "requires:",
        "  - permissions-base",
        "  - settings/permissions-base",
        "  - commands/foo",
        "conflicts-with:",
        "  - skills/quick-review",
        "  - 42",
        "",
      ].join("\n"),
      "skills/foo",
    );

    expect(meta.requires).toEqual(["settings/permissions-base"]);
    expect(meta.conflictsWith).toEqual(["skills/quick-review"]);
    expect(meta.warnings).toHaveLength(3);
    expect(meta.warnings[0]).toContain('"permissions-base"');
    expect(meta.warnings[1]).toContain('"commands/foo"');
    expect(meta.warnings[2]).toContain("42");
  });

  test("ignores unknown fields silently", () => {
    const meta = parseSidecar(
      "description: hi\ntargets: [claude]\nfuture-field: 1\n",
      "skills/foo",
    );

    expect(meta.description).toBe("hi");
    expect(meta.warnings).toEqual([]);
  });

  test("warns and ignores a name that disagrees with the directory name", () => {
    const meta = parseSidecar(
      "name: other-name\ndescription: hi\n",
      "skills/foo",
      "foo",
    );

    expect(meta.description).toBe("hi");
    expect(meta.warnings).toEqual([
      `skills/foo: ${METADATA_SIDECAR} "name" is "other-name" but the directory name "foo" is canonical — name ignored`,
    ]);
  });

  test("accepts a name that matches the directory name without warning", () => {
    const meta = parseSidecar("name: foo\n", "skills/foo", "foo");
    expect(meta.warnings).toEqual([]);
  });

  test("ignores an oversize sidecar with a warning", () => {
    const meta = parseSidecar(
      `description: hi\n# ${"x".repeat(65 * 1024)}\n`,
      "skills/foo",
    );

    expect(meta.description).toBeUndefined();
    expect(meta.warnings).toEqual([
      `skills/foo: ${METADATA_SIDECAR} is larger than 64 KiB — metadata ignored`,
    ]);
  });

  test("returns empty metadata plus a warning for unparseable YAML", () => {
    const meta = parseSidecar(
      "description: hi\ntags: [unclosed\n",
      "skills/foo",
    );

    expect(meta.description).toBeUndefined();
    expect(meta.tags).toEqual([]);
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings[0]).toMatch(
      /^skills\/foo: invalid \.capshelf\.yml \(line \d+: /,
    );
    expect(meta.warnings[0]).toContain("metadata ignored");
  });

  test("treats a non-mapping document as malformed", () => {
    const meta = parseSidecar("- just\n- a list\n", "skills/foo");
    expect(meta.warnings).toEqual([
      `skills/foo: invalid ${METADATA_SIDECAR} (expected a mapping) — metadata ignored`,
    ]);
  });

  test("drops a non-string description but keeps tags", () => {
    const meta = parseSidecar(
      "description: [not, a, string]\ntags: [a]\n",
      "skills/foo",
    );

    expect(meta.description).toBeUndefined();
    expect(meta.tags).toEqual(["a"]);
    expect(meta.warnings).toHaveLength(1);
  });
});

describe("extractFrontmatter and parseFrontmatter", () => {
  test("extracts a present frontmatter block", () => {
    const block = extractFrontmatter(
      "---\nname: hello\ndescription: hi there\n---\n\nbody\n",
    );
    expect(block.malformed).toBe(false);
    expect(block.text).toBe("name: hello\ndescription: hi there");
  });

  test("reports absent frontmatter", () => {
    const block = extractFrontmatter("# hello\nno frontmatter here\n");
    expect(block).toEqual({ text: null, malformed: false });
  });

  test("flags a missing closing delimiter as malformed", () => {
    const block = extractFrontmatter("---\nname: hello\nno closing\n");
    expect(block).toEqual({ text: null, malformed: true });
  });

  test("strips CRLF line endings so values carry no trailing carriage return", () => {
    const block = extractFrontmatter(
      "---\r\nname: hello\r\ndescription: hi there\r\n---\r\nbody\r\n",
    );
    expect(block.malformed).toBe(false);
    expect(block.text).toBe("name: hello\ndescription: hi there");

    const meta = parseFrontmatter(block.text!, "skills/hello", "hello");
    expect(meta.description).toBe("hi there");
    expect(meta.warnings).toEqual([]);
  });

  test("tolerates a leading UTF-8 BOM before the opening delimiter", () => {
    const block = extractFrontmatter(
      "\uFEFF---\ndescription: hi there\n---\nbody\n",
    );
    expect(block.malformed).toBe(false);
    expect(block.text).toBe("description: hi there");
  });

  test("parses folded descriptions", () => {
    const meta = parseFrontmatter(
      "name: hello\ndescription: >-\n  first part\n  second part\n",
      "skills/hello",
      "hello",
    );
    expect(meta.description).toBe("first part second part");
    expect(meta.warnings).toEqual([]);
  });

  test("never reads tags, requires, or conflicts-with from frontmatter", () => {
    const meta = parseFrontmatter(
      [
        "description: hi",
        "tags: [secret]",
        "requires: [settings/base]",
        "conflicts-with: [skills/other]",
        "",
      ].join("\n"),
      "skills/hello",
    );
    expect(meta.description).toBe("hi");
    expect(meta.tags).toEqual([]);
    expect(meta.requires).toEqual([]);
    expect(meta.conflictsWith).toEqual([]);
    expect(meta.warnings).toEqual([]);
  });

  test("ignores an oversize frontmatter block with a warning", () => {
    const meta = parseFrontmatter(
      `description: hi\n# ${"x".repeat(17 * 1024)}\n`,
      "skills/hello",
    );
    expect(meta.description).toBeUndefined();
    expect(meta.warnings).toEqual([
      "skills/hello: SKILL.md frontmatter is larger than 16 KiB — metadata ignored",
    ]);
  });
});

describe("mergeItemMetadata", () => {
  test("sidecar description beats frontmatter", () => {
    const merged = mergeItemMetadata(
      { ...emptyMetadata(), description: "sidecar" },
      { ...emptyMetadata(), description: "frontmatter" },
    );
    expect(merged.description).toBe("sidecar");
  });

  test("frontmatter description fills a sidecar gap", () => {
    const merged = mergeItemMetadata(emptyMetadata(), {
      ...emptyMetadata(),
      description: "frontmatter",
    });
    expect(merged.description).toBe("frontmatter");
  });

  test("tags/requires/conflicts come from the sidecar only and warnings concat", () => {
    const merged = mergeItemMetadata(
      {
        description: undefined,
        tags: ["a"],
        requires: ["settings/base"],
        conflictsWith: ["skills/other"],
        warnings: ["w1"],
      },
      { ...emptyMetadata(["w2"]) },
    );
    expect(merged.tags).toEqual(["a"]);
    expect(merged.requires).toEqual(["settings/base"]);
    expect(merged.conflictsWith).toEqual(["skills/other"]);
    expect(merged.warnings).toEqual(["w1", "w2"]);
  });
});

describe("loadDataItemMetadata", () => {
  test("merges sidecar and frontmatter for skills with sidecar precedence", async () => {
    const dataRepo = await mkdtemp(join(tmpdir(), "capshelf-meta-"));
    const item = join(dataRepo, "skills", "hello");
    await mkdir(item, { recursive: true });
    await writeFile(
      join(item, "SKILL.md"),
      "---\nname: hello\ndescription: frontmatter description\n---\nbody\n",
    );
    await writeFile(
      join(item, METADATA_SIDECAR),
      "description: sidecar description\ntags: [greeting]\n",
    );

    const meta = await loadDataItemMetadata({
      kind: "skills",
      name: "hello",
      path: item,
    });
    expect(meta.description).toBe("sidecar description");
    expect(meta.tags).toEqual(["greeting"]);
  });

  test("falls back to frontmatter description when the sidecar lacks one", async () => {
    const dataRepo = await mkdtemp(join(tmpdir(), "capshelf-meta-"));
    const item = join(dataRepo, "skills", "hello");
    await mkdir(item, { recursive: true });
    await writeFile(
      join(item, "SKILL.md"),
      "---\ndescription: frontmatter description\n---\nbody\n",
    );
    await writeFile(join(item, METADATA_SIDECAR), "tags: [greeting]\n");

    const meta = await loadDataItemMetadata({
      kind: "skills",
      name: "hello",
      path: item,
    });
    expect(meta.description).toBe("frontmatter description");
    expect(meta.tags).toEqual(["greeting"]);
  });

  test("returns empty metadata for items without any metadata source", async () => {
    const dataRepo = await mkdtemp(join(tmpdir(), "capshelf-meta-"));
    const item = join(dataRepo, "settings", "base");
    await mkdir(item, { recursive: true });
    await writeFile(join(item, "settings.json"), "{}\n");

    const meta = await loadDataItemMetadata({
      kind: "settings",
      name: "base",
      path: item,
    });
    expect(meta).toEqual(emptyMetadata());
  });

  test("warns on unterminated skill frontmatter without failing", async () => {
    const dataRepo = await mkdtemp(join(tmpdir(), "capshelf-meta-"));
    const item = join(dataRepo, "skills", "hello");
    await mkdir(item, { recursive: true });
    await writeFile(join(item, "SKILL.md"), "---\nname: hello\nno close\n");

    const meta = await loadDataItemMetadata({
      kind: "skills",
      name: "hello",
      path: item,
    });
    expect(meta.description).toBeUndefined();
    expect(meta.warnings).toEqual([
      'skills/hello: SKILL.md frontmatter has no closing "---" — metadata ignored',
    ]);
  });
});

describe("loadSystemItemMetadata", () => {
  test("reads bundled SKILL.md frontmatter", () => {
    const meta = loadSystemItemMetadata({
      kind: "skills",
      name: "capshelf",
      files: [
        {
          relPath: "SKILL.md",
          content: "---\nname: capshelf\ndescription: Bundled skill.\n---\n",
        },
      ],
    });
    expect(meta.description).toBe("Bundled skill.");
    expect(meta.warnings).toEqual([]);
  });

  test("returns empty metadata when SKILL.md is absent", () => {
    const meta = loadSystemItemMetadata({
      kind: "skills",
      name: "x",
      files: [],
    });
    expect(meta).toEqual(emptyMetadata());
  });
});

describe("truncatedDescription", () => {
  test("truncates by code points so an emoji at the boundary survives", () => {
    // 59 ASCII chars + one emoji = 60 code points but 61 UTF-16 code units;
    // a code-unit slice would cut the surrogate pair in half.
    const head = `${"a".repeat(59)}😀`;
    expect(truncatedDescription(`${head} trailing text`)).toBe(`${head}…`);
    expect(truncatedDescription(`${head} trailing text`).isWellFormed()).toBe(
      true,
    );
    // Exactly 60 code points: returned unchanged.
    expect(truncatedDescription(head)).toBe(head);
  });

  test("keeps short descriptions and trims truncation-edge whitespace", () => {
    expect(truncatedDescription("short")).toBe("short");
    expect(truncatedDescription(`${"a".repeat(59)} tail`)).toBe(
      `${"a".repeat(59)}…`,
    );
  });
});
