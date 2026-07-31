import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCodexProjection, loadCodexState } from "./codex-marketplace";
import { CODEX_PROJECTION_ROOTS, replaceOwnedFiles } from "./marketplace-files";
import type { NamedFile } from "./merge-tree";
import { METADATA_SIDECAR } from "./metadata";
import {
  assertNoSymlinkAncestors,
  assertNoSymlinkAncestorsSync,
} from "./path-safety";

export function hasCodexMarketplace(dataRepo: string): boolean {
  assertNoSymlinkAncestorsSync(
    dataRepo,
    "codex/plugin-definitions/marketplace.json",
  );
  return existsSync(`${dataRepo}/codex/plugin-definitions/marketplace.json`);
}

export async function refreshCodexProjection(dataRepo: string): Promise<void> {
  if (!hasCodexMarketplace(dataRepo)) return;
  const state = await loadCodexState(dataRepo);
  const projection = await buildCodexProjection(dataRepo, state);
  await replaceOwnedFiles(dataRepo, CODEX_PROJECTION_ROOTS, projection);
}

export async function replaceSkillWithNamedFiles(
  dataRepo: string,
  repoRelPath: string,
  files: NamedFile[],
  sidecar: Buffer | null,
): Promise<void> {
  await assertNoSymlinkAncestors(dataRepo, repoRelPath);
  const root = join(dataRepo, ...repoRelPath.split("/"));
  await rm(root, { recursive: true, force: true });
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
  }
  if (sidecar !== null) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, METADATA_SIDECAR), sidecar);
  }
}
