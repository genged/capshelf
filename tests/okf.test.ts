import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ITEM_KINDS,
  descriptorFor,
  isDirectoryKind,
  isFragmentItemKind,
  isSkillKind,
  itemRepoRelPath,
} from "../src/master";
import {
  addManifestName,
  emptyManifest,
  loadManifest,
  manifestNamesForKind,
  saveManifest,
} from "../src/manifest";
import {
  DEFAULT_OKF_PATH,
  detectOkfPath,
  normalizeOkfPath,
  okfDir,
} from "../src/paths";
import { installedPath } from "../src/installed";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "capshelf-okf-"));
}

describe("okf kind registry", () => {
  test("okf is a registered directory kind", () => {
    expect(ITEM_KINDS).toContain("okf");
    const d = descriptorFor("okf");
    expect(d.shape).toBe("okf");
    expect(d.repoDir).toBe("okf");
    expect(d.canonicalFiles).toEqual([]);
    expect(d.manifestKey).toBe("okf");
  });

  test("okf classifies as directory, not fragment or skill", () => {
    expect(isFragmentItemKind("okf")).toBe(false);
    expect(isSkillKind("okf")).toBe(false);
    expect(isDirectoryKind("okf")).toBe(true);
  });

  test("okf repo path", () => {
    expect(itemRepoRelPath("okf", "sales")).toBe("okf/sales");
  });
});

describe("okf manifest", () => {
  test("manifest carries okf list and optional okfPath", async () => {
    const m = emptyManifest();
    expect(m.okf).toEqual([]);
    addManifestName(m, "okf", "sales");
    expect(manifestNamesForKind(m, "okf")).toEqual(["sales"]);
    expect(manifestNamesForKind(m, "okf")).toBe(m.okf);
  });

  test("okfPath round-trips through save/load", async () => {
    const project = await tempDir();
    const m = emptyManifest();
    m.okfPath = "knowledge";
    m.okf = ["sales"];
    await saveManifest(project, m);
    const loaded = await loadManifest(project);
    expect(loaded.okfPath).toBe("knowledge");
    expect(loaded.okf).toEqual(["sales"]);
  });

  test("invalid okfPath is rejected on load", async () => {
    const project = await tempDir();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({ okfPath: "../escape" }),
    );
    await expect(loadManifest(project)).rejects.toThrow(/okfPath/);
  });
});

describe("okf path resolution", () => {
  test("normalizeOkfPath defaults and validates", () => {
    expect(normalizeOkfPath(undefined)).toBe(DEFAULT_OKF_PATH);
    expect(DEFAULT_OKF_PATH).toBe(".okf");
    expect(normalizeOkfPath("knowledge")).toBe("knowledge");
    expect(normalizeOkfPath("a/b")).toBe("a/b");
    expect(() => normalizeOkfPath("/abs")).toThrow();
    expect(() => normalizeOkfPath("../x")).toThrow();
    expect(() => normalizeOkfPath("a/../b")).toThrow();
  });

  test("okfDir defaults to .okf and honors okfPath in manifest", async () => {
    const project = await tempDir();
    expect(detectOkfPath(project)).toBe(".okf");
    expect(okfDir(project)).toBe(join(project, ".okf"));

    const m = emptyManifest();
    m.okfPath = "knowledge";
    await saveManifest(project, m);
    expect(detectOkfPath(project)).toBe("knowledge");
    expect(okfDir(project)).toBe(join(project, "knowledge"));
  });

  test("installedPath for okf is <okfPath>/<name>", async () => {
    const project = await tempDir();
    expect(installedPath(project, "okf", "sales")).toBe(
      join(project, ".okf", "sales"),
    );
    const m = emptyManifest();
    m.okfPath = "knowledge";
    await saveManifest(project, m);
    expect(installedPath(project, "okf", "sales")).toBe(
      join(project, "knowledge", "sales"),
    );
  });
});
