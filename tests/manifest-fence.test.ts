import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_FENCE } from "../src/manifest-fence";
import { emptyManifest, loadManifest, saveManifest } from "../src/manifest";
import {
  loadLocalConfig,
  localConfigPath,
  saveLocalConfig,
} from "../src/local-config";
import { tempDir } from "./cli-fixtures";

async function project(): Promise<string> {
  const dir = await tempDir("capshelf-fence-");
  await mkdir(join(dir, ".capshelf"), { recursive: true });
  return dir;
}
const manifestFile = (p: string) => join(p, ".capshelf", "capshelf.json");

describe("shelves fence", () => {
  test("a manifest with a plugin is written with the fence", async () => {
    const p = await project();
    await saveManifest(p, { ...emptyManifest(), plugins: ["gh-cli"] });
    const raw = JSON.parse(await readFile(manifestFile(p), "utf-8"));
    expect(raw.shelves).toBe(PLUGIN_FENCE);
    expect(raw.plugins).toEqual(["gh-cli"]);
  });
  test("a manifest with no plugin is written without the fence", async () => {
    const p = await project();
    await saveManifest(p, { ...emptyManifest(), plugins: [] });
    const raw = JSON.parse(await readFile(manifestFile(p), "utf-8"));
    expect("shelves" in raw).toBe(false);
  });
  test("the loader accepts the exact fence and round-trips it", async () => {
    const p = await project();
    await writeFile(
      manifestFile(p),
      JSON.stringify({ shelves: PLUGIN_FENCE, plugins: ["x"] }),
    );
    expect((await loadManifest(p)).plugins).toEqual(["x"]);
  });
  test("any other shelves value is still the federation refusal", async () => {
    const p = await project();
    for (const value of [[], "other", null, { a: 1 }]) {
      await writeFile(manifestFile(p), JSON.stringify({ shelves: value }));
      await expect(loadManifest(p)).rejects.toThrow(/multi-shelf federation/);
    }
  });
  test("the fence without a plugin is refused as inconsistent", async () => {
    const p = await project();
    await writeFile(
      manifestFile(p),
      JSON.stringify({ shelves: PLUGIN_FENCE, plugins: [] }),
    );
    await expect(loadManifest(p)).rejects.toThrow(/fence.*no plugin/);
  });
});

describe("shelves fence, local config", () => {
  test("a local config with a plugin is written with the fence", async () => {
    const p = await project();
    await saveLocalConfig(p, {
      dataRepo: p,
      skills: [],
      plugins: ["gh-cli"],
      piExtensions: [],
      settings: [],
      mcp: [],
    });
    const raw = JSON.parse(await readFile(localConfigPath(p), "utf-8"));
    expect(raw.shelves).toBe(PLUGIN_FENCE);
    expect(raw.plugins).toEqual(["gh-cli"]);
  });
  test("a local config with no plugin is written without the fence", async () => {
    const p = await project();
    await saveLocalConfig(p, {
      dataRepo: p,
      skills: [],
      plugins: [],
      piExtensions: [],
      settings: [],
      mcp: [],
    });
    const raw = JSON.parse(await readFile(localConfigPath(p), "utf-8"));
    expect("shelves" in raw).toBe(false);
  });
  test("the loader accepts the exact fence and round-trips it", async () => {
    const p = await project();
    await writeFile(
      localConfigPath(p),
      JSON.stringify({ dataRepo: p, shelves: PLUGIN_FENCE, plugins: ["x"] }),
    );
    expect((await loadLocalConfig(p))?.plugins).toEqual(["x"]);
  });
  test("any other shelves value is still the federation refusal", async () => {
    const p = await project();
    for (const value of [[], "other", null, { a: 1 }]) {
      await writeFile(
        localConfigPath(p),
        JSON.stringify({ dataRepo: p, shelves: value }),
      );
      await expect(loadLocalConfig(p)).rejects.toThrow(
        /multi-shelf federation/,
      );
    }
  });
  test("the fence without a plugin is refused as inconsistent", async () => {
    const p = await project();
    await writeFile(
      localConfigPath(p),
      JSON.stringify({ dataRepo: p, shelves: PLUGIN_FENCE, plugins: [] }),
    );
    await expect(loadLocalConfig(p)).rejects.toThrow(/fence.*no plugin/);
  });
});
