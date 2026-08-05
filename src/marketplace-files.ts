import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PreconditionError } from "./errors";
import { atomicWriteFile } from "./fs-utils";
import {
  assertRepoClean,
  assertRepoCleanOutsidePaths,
  commitLiteralPathsInRepo,
  gitBuffer,
  gitTry,
  headSha,
  literalPathspec,
} from "./git";
import {
  type ProjectionFile,
  validateProjectionFiles,
} from "./plugin-projection";
import { assertNoSymlinkAncestors } from "./path-safety";

export const CODEX_PROJECTION_ROOTS = [
  ".agents/plugins/marketplace.json",
  "codex/generated",
] as const;

export async function readFilesBelow(
  root: string,
  relRoots: readonly string[],
): Promise<ProjectionFile[]> {
  const files: ProjectionFile[] = [];
  for (const relRoot of relRoots) {
    await assertNoSymlinkAncestors(root, relRoot);
    await walk(root, relRoot, files);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(
  root: string,
  relPath: string,
  files: ProjectionFile[],
): Promise<void> {
  const path = join(root, ...relPath.split("/"));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new PreconditionError(`${relPath} is a symlink`);
  }
  if (info.isFile()) {
    files.push({
      path: relPath,
      bytes: await readFile(path),
      executable: (info.mode & 0o111) !== 0,
    });
    return;
  }
  if (!info.isDirectory()) {
    throw new PreconditionError(
      `${relPath} is not a regular file or directory`,
    );
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await walk(root, `${relPath}/${entry.name}`, files);
  }
}

export function diffFileSets(
  current: ProjectionFile[],
  expected: ProjectionFile[],
): { created: string[]; updated: string[]; deleted: string[] } {
  const currentMap = new Map(current.map((file) => [file.path, file]));
  const expectedMap = new Map(expected.map((file) => [file.path, file]));
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const [path, file] of expectedMap) {
    const old = currentMap.get(path);
    if (!old) created.push(path);
    else if (
      !old.bytes.equals(file.bytes) ||
      old.executable !== file.executable
    ) {
      updated.push(path);
    }
  }
  for (const path of currentMap.keys()) {
    if (!expectedMap.has(path)) deleted.push(path);
  }
  return { created, updated, deleted };
}

export async function replaceOwnedFiles(
  root: string,
  ownedRoots: readonly string[],
  files: ProjectionFile[],
): Promise<void> {
  validateProjectionFiles(files);
  for (const relRoot of ownedRoots) {
    await assertNoSymlinkAncestors(root, relRoot);
    await rm(join(root, ...relRoot.split("/")), {
      recursive: true,
      force: true,
    });
  }
  for (const file of files) {
    await assertNoSymlinkAncestors(root, file.path);
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, file.bytes);
    await chmod(path, file.executable ? 0o755 : 0o644);
  }
}

export async function commitMarketplaceMutation(options: {
  dataRepo: string;
  expectedHead: string;
  message: string;
  ownedRoots: string[];
  files: ProjectionFile[];
}): Promise<string> {
  const { dataRepo, expectedHead, message, ownedRoots, files } = options;
  return await commitDataRepoMutation({
    dataRepo,
    expectedHead,
    message,
    ownedRoots,
    mutate: async () => {
      await replaceOwnedFiles(dataRepo, ownedRoots, files);
    },
  });
}

export async function commitDataRepoMutation(options: {
  dataRepo: string;
  expectedHead: string | null;
  message: string;
  ownedRoots: string[];
  mutate: () => Promise<void>;
}): Promise<string> {
  const { dataRepo, expectedHead, message, ownedRoots, mutate } = options;
  await assertRepoClean(dataRepo);
  if ((await currentHead(dataRepo)) !== expectedHead) {
    throw new PreconditionError(
      "data repo HEAD changed during marketplace mutation",
    );
  }
  const before = await readFilesBelow(dataRepo, ownedRoots);
  const gitDir = (await gitBuffer(dataRepo, ["rev-parse", "--git-dir"]))
    .toString()
    .trim();
  const indexPath = resolve(dataRepo, gitDir, "index");
  const backupRoot = await mkdtemp(join(tmpdir(), "capshelf-marketplace-"));
  const backupIndex = join(backupRoot, "index");
  let createdCommit: string | null = null;
  let hadIndex = true;
  try {
    await copyFile(indexPath, backupIndex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") hadIndex = false;
    else throw error;
  }
  try {
    await mutate();
    if ((await currentHead(dataRepo)) !== expectedHead) {
      throw new PreconditionError(
        "data repo HEAD changed during marketplace mutation",
      );
    }
    await assertRepoCleanOutsidePaths(dataRepo, ownedRoots);
    createdCommit = await commitLiteralPathsInRepo(
      dataRepo,
      ownedRoots,
      message,
    );
    return createdCommit;
  } catch (error) {
    const current = await currentHead(dataRepo);
    if (createdCommit !== null && current === createdCommit) {
      const revertArgs =
        expectedHead === null
          ? ["update-ref", "-d", "HEAD", createdCommit]
          : ["update-ref", "HEAD", expectedHead, createdCommit];
      const reverted = await gitBuffer(dataRepo, revertArgs)
        .then(() => true)
        .catch(() => false);
      if (!reverted) throw error;
    } else if (current !== expectedHead) {
      if (expectedHead === null || current === null) throw error;
      const ownedTrees = await gitTry(dataRepo, [
        "diff",
        "--quiet",
        expectedHead,
        current,
        "--",
        ...ownedRoots.map(literalPathspec),
      ]);
      if (ownedTrees.exitCode === 0) {
        await replaceOwnedFiles(dataRepo, ownedRoots, before).catch(() => {});
      }
      throw error;
    }
    await replaceOwnedFiles(dataRepo, ownedRoots, before).catch(() => {});
    if (hadIndex) {
      await copyFile(backupIndex, indexPath).catch(() => {});
    } else {
      await rm(indexPath, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function currentHead(dataRepo: string): Promise<string | null> {
  return await headSha(dataRepo).catch(() => null);
}

export async function publishDirectoryAtomically(
  output: string,
  files: ProjectionFile[],
): Promise<void> {
  validateProjectionFiles(files);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${basename(output)}.tmp-`));
  try {
    for (const file of files) {
      const path = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes, {
        mode: file.executable ? 0o755 : 0o644,
      });
    }
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
