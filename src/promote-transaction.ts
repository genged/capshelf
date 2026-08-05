import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gitBuffer, gitText, headSha, literalPathspec } from "./git";
import type { NamedFile } from "./merge-tree";
import { METADATA_SIDECAR } from "./metadata";

export interface PromoteTransactionHooks {
  afterPrepared?: () => Promise<void>;
  afterPathReplaced?: () => Promise<void>;
  beforeHeadAdvance?: () => Promise<void>;
}

export interface CommitNamedFilesInput {
  repo: string;
  repoRelPath: string;
  files: NamedFile[];
  sidecar: Buffer | null;
  expectedHead: string;
  message: string;
  beforePersistentMutation?: () => Promise<void>;
  hooks?: PromoteTransactionHooks;
}

export interface PromoteTransactionLocations {
  dataDir: string;
  itemBackupParent: string;
  indexPath: string;
  indexReplacementParent: string;
}

export async function promoteTransactionLocations(
  repo: string,
  repoRelPath: string,
): Promise<PromoteTransactionLocations> {
  const dataDir = join(repo, ...repoRelPath.split("/"));
  const indexPath = resolve(
    repo,
    (await gitText(repo, ["rev-parse", "--git-path", "index"])).trim(),
  );
  return {
    dataDir,
    itemBackupParent: dirname(dataDir),
    indexPath,
    indexReplacementParent: dirname(indexPath),
  };
}

export async function commitNamedFilesTransaction(
  input: CommitNamedFilesInput,
): Promise<string> {
  const transactionDir = await mkdtemp(
    join(tmpdir(), "capshelf-promote-index-"),
  );
  const alternateIndex = join(transactionDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: alternateIndex };
  let backupDir: string | null = null;
  let indexReplacementDir: string | null = null;
  let pathReplaced = false;
  let headAdvanced = false;

  try {
    await gitBuffer(input.repo, ["read-tree", input.expectedHead], { env });
    const tracked = (
      await gitText(
        input.repo,
        ["ls-files", "-z", "--", literalPathspec(input.repoRelPath)],
        { env },
      )
    )
      .split("\0")
      .filter(Boolean);
    if (tracked.length > 0) {
      await gitBuffer(
        input.repo,
        ["update-index", "--force-remove", "--", ...tracked],
        { env },
      );
    }
    for (const file of [
      ...input.files,
      ...(input.sidecar === null
        ? []
        : [
            {
              path: METADATA_SIDECAR,
              content: input.sidecar,
              mode: "100644" as const,
            },
          ]),
    ]) {
      const object = (
        await gitText(input.repo, ["hash-object", "-w", "--stdin"], {
          env,
          stdin: file.content,
        })
      ).trim();
      await gitBuffer(
        input.repo,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          file.mode,
          object,
          `${input.repoRelPath}/${file.path}`,
        ],
        { env },
      );
    }
    const tree = (await gitText(input.repo, ["write-tree"], { env })).trim();
    const candidate = (
      await gitText(
        input.repo,
        ["commit-tree", tree, "-p", input.expectedHead, "-m", input.message],
        { env },
      )
    ).trim();
    await input.hooks?.afterPrepared?.();
    if ((await headSha(input.repo)) !== input.expectedHead) {
      throw new Error("data repo HEAD changed while preparing merged promote");
    }
    await input.beforePersistentMutation?.();

    const locations = await promoteTransactionLocations(
      input.repo,
      input.repoRelPath,
    );
    backupDir = await mkdtemp(
      join(locations.itemBackupParent, ".capshelf-promote-item-"),
    );
    indexReplacementDir = await mkdtemp(
      join(locations.indexReplacementParent, ".capshelf-promote-index-"),
    );
    const replacementIndex = join(indexReplacementDir, "index");
    await copyFile(alternateIndex, replacementIndex);
    const backupPath = join(backupDir, "original");
    await rename(locations.dataDir, backupPath);
    pathReplaced = true;
    try {
      await writeNamedFiles(locations.dataDir, input.files, input.sidecar);
      await input.hooks?.afterPathReplaced?.();
      await input.hooks?.beforeHeadAdvance?.();
      await gitBuffer(input.repo, [
        "update-ref",
        "HEAD",
        candidate,
        input.expectedHead,
      ]);
      headAdvanced = true;

      await rename(replacementIndex, locations.indexPath);
    } catch (error) {
      if (headAdvanced) {
        await gitBuffer(input.repo, [
          "update-ref",
          "HEAD",
          input.expectedHead,
          candidate,
        ]);
        headAdvanced = false;
      }
      await rm(locations.dataDir, { recursive: true, force: true });
      await rename(backupPath, locations.dataDir);
      pathReplaced = false;
      throw error;
    }

    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    backupDir = null;
    await rm(indexReplacementDir, { recursive: true, force: true }).catch(
      () => {},
    );
    indexReplacementDir = null;
    pathReplaced = false;
    return candidate;
  } finally {
    if (pathReplaced && backupDir !== null && !headAdvanced) {
      const dataDir = join(input.repo, ...input.repoRelPath.split("/"));
      await rm(dataDir, { recursive: true, force: true });
      await rename(join(backupDir, "original"), dataDir);
    }
    if (backupDir !== null && !headAdvanced) {
      await rm(backupDir, { recursive: true, force: true });
    }
    if (indexReplacementDir !== null) {
      await rm(indexReplacementDir, { recursive: true, force: true });
    }
    await rm(transactionDir, { recursive: true, force: true });
  }
}

export interface InstalledReconciliation {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function beginDirectoryReplacement(
  target: string,
  prepare: (replacement: string) => Promise<void>,
): Promise<InstalledReconciliation> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const transactionDir = await mkdtemp(join(parent, ".capshelf-materialize-"));
  const replacement = join(transactionDir, "replacement");
  const backup = join(transactionDir, "original");
  let hadOriginal = false;

  try {
    await prepare(replacement);
    try {
      await rename(target, backup);
      hadOriginal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(replacement, target);
    } catch (error) {
      if (hadOriginal) await rename(backup, target);
      throw error;
    }
  } catch (error) {
    await rm(transactionDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await rm(transactionDir, { recursive: true, force: true }).catch(
        () => {},
      );
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await rm(target, { recursive: true, force: true });
      if (hadOriginal) await rename(backup, target);
      await rm(transactionDir, { recursive: true, force: true }).catch(
        () => {},
      );
    },
  };
}

export async function beginInstalledReconciliation(
  installedDir: string,
  localFiles: NamedFile[],
  mergedFiles: NamedFile[],
): Promise<InstalledReconciliation> {
  const parent = dirname(installedDir);
  const backupDir = await mkdtemp(join(parent, ".capshelf-promote-"));
  const backup = join(backupDir, "original");
  await rename(installedDir, backup);
  try {
    await cp(backup, installedDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    for (const file of [...localFiles].sort(
      (a, b) => b.path.length - a.path.length,
    )) {
      const path = join(installedDir, ...file.path.split("/"));
      await rm(path, { force: true });
      await pruneEmptyParents(dirname(path), installedDir);
    }
    for (const file of mergedFiles) {
      const path = join(installedDir, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
      await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
    }
  } catch (error) {
    await rm(installedDir, { recursive: true, force: true });
    await rename(backup, installedDir);
    await rm(backupDir, { recursive: true, force: true });
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await rm(installedDir, { recursive: true, force: true });
      await rename(backup, installedDir);
      await rm(backupDir, { recursive: true, force: true });
    },
  };
}

async function writeNamedFiles(
  root: string,
  files: NamedFile[],
  sidecar: Buffer | null,
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
  }
  if (sidecar !== null) {
    await writeFile(join(root, METADATA_SIDECAR), sidecar);
  }
}

async function pruneEmptyParents(path: string, root: string): Promise<void> {
  let current = path;
  while (current !== root && current.startsWith(`${root}/`)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
