import { readFile } from "node:fs/promises";
import { PreconditionError } from "./errors";
import { headSha, showAtCommit } from "./git";
import {
  installedSnapshot,
  namedFilesFromInstalledSnapshot,
} from "./item-snapshot";
import { dataKey } from "./lock";
import type { LockV4 } from "./lock";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "./master";
import type { ItemKind } from "./master";
import type { NamedFile } from "./merge-tree";
import { dataEntryV4OrThrow } from "./promote-core";
import {
  currentFragmentCandidateFiles,
  promotedSubagentFiles,
} from "./promote-candidate";
import {
  hashWidthOf,
  itemTreeEntriesAtCommit,
  namedFilesTreeEntries,
  sourcePinDigest,
} from "./pin";
import { unifiedDiffBytes } from "./status-diff";
import { lstatOrNull } from "./fs-utils";
import { subagentSourcesAtCommit } from "./subagents";
import type { Scope } from "./promote-core";
import { sanitizeDisplayText } from "./pick-core";

export interface PromotePreviewGuard {
  baseDigest: string;
  candidateDigest: string;
}

export interface PreparedPromotePreview {
  text: string;
  guard: PromotePreviewGuard;
}

export async function preparePromotePreview(input: {
  project: string;
  dataRepo: string;
  lock: LockV4;
  scope: Scope;
  kind: ItemKind;
  name: string;
}): Promise<PreparedPromotePreview> {
  const { project, dataRepo, lock, scope, kind, name } = input;
  const entry = dataEntryV4OrThrow(
    lock.items[dataKey(kind, name)],
    dataKey(kind, name),
  );
  const head = await headSha(dataRepo);
  const baseEntries = await itemTreeEntriesAtCommit(dataRepo, kind, name, head);
  const baseFiles = await filesFromEntries(dataRepo, head, baseEntries);
  let candidateFiles: NamedFile[];

  if (isFragmentItemKind(kind)) {
    candidateFiles = await currentFragmentCandidateFiles(dataRepo, kind, name);
  } else if (isCopyTargetFileItemKind(kind)) {
    candidateFiles = await subagentCandidateFiles(
      project,
      dataRepo,
      name,
      entry.sourceCommit,
    );
  } else if (isCopyDirectoryItemKind(kind)) {
    const snapshot = await installedSnapshot(project, kind, name, scope);
    if (!snapshot) {
      throw new PreconditionError(
        `installed files are missing: ${kind}/${name}`,
      );
    }
    candidateFiles = await namedFilesFromInstalledSnapshot(snapshot);
  } else {
    throw new Error(`no preview strategy for ${kind}/${name}`);
  }

  const width = hashWidthOf(baseEntries);
  return {
    text: await diffNamedFiles(baseFiles, candidateFiles),
    guard: {
      baseDigest: sourcePinDigest(baseEntries),
      candidateDigest: sourcePinDigest(
        namedFilesTreeEntries(candidateFiles, width),
      ),
    },
  };
}

export async function validatePromotePreview(input: {
  dataRepo: string;
  kind: ItemKind;
  name: string;
  candidateFiles: NamedFile[];
  guard: PromotePreviewGuard;
}): Promise<string> {
  const head = await headSha(input.dataRepo);
  const baseEntries = await itemTreeEntriesAtCommit(
    input.dataRepo,
    input.kind,
    input.name,
    head,
  );
  const candidateDigest = sourcePinDigest(
    namedFilesTreeEntries(input.candidateFiles, hashWidthOf(baseEntries)),
  );
  if (
    sourcePinDigest(baseEntries) !== input.guard.baseDigest ||
    candidateDigest !== input.guard.candidateDigest
  ) {
    throw new PreconditionError(
      `the diff preview for ${input.kind}/${input.name} is stale; press Ctrl-V to review the current diff, then promote it again`,
    );
  }
  return head;
}

export function encodePromotePreviewGuard(guard: PromotePreviewGuard): string {
  return `v1:${guard.baseDigest}:${guard.candidateDigest}`;
}

export function decodePromotePreviewGuard(
  encoded: string | undefined,
): PromotePreviewGuard | undefined {
  if (encoded === undefined) return undefined;
  const match = /^v1:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(encoded);
  if (!match) throw new Error("invalid promote preview guard");
  const [, baseDigest, candidateDigest] = match;
  if (baseDigest === undefined || candidateDigest === undefined) {
    throw new Error("invalid promote preview guard");
  }
  return { baseDigest, candidateDigest };
}

async function subagentCandidateFiles(
  project: string,
  dataRepo: string,
  name: string,
  lockedCommit: string,
): Promise<NamedFile[]> {
  const pending: Array<{ relPath: string; raw: Buffer }> = [];
  for (const source of await subagentSourcesAtCommit(
    project,
    dataRepo,
    name,
    lockedCommit,
  )) {
    const stat = lstatOrNull(source.outputPath);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new PreconditionError(
        `managed runtime target is missing or not a regular file: ${source.outputPath}`,
      );
    }
    const raw = await readFile(source.outputPath);
    const locked = await showAtCommit(dataRepo, lockedCommit, source.relPath);
    if (!raw.equals(locked)) pending.push({ relPath: source.relPath, raw });
  }
  return await promotedSubagentFiles(project, dataRepo, name, pending);
}

async function filesFromEntries(
  dataRepo: string,
  commit: string,
  entries: Awaited<ReturnType<typeof itemTreeEntriesAtCommit>>,
): Promise<NamedFile[]> {
  return await Promise.all(
    entries.map(async (entry) => ({
      path: entry.path,
      content: await showAtCommit(dataRepo, commit, entry.repoRelPath),
      mode: entry.mode,
    })),
  );
}

export async function diffNamedFiles(
  base: NamedFile[],
  candidate: NamedFile[],
): Promise<string> {
  const baseByPath = new Map(base.map((file) => [file.path, file]));
  const candidateByPath = new Map(candidate.map((file) => [file.path, file]));
  const paths = [
    ...new Set([...baseByPath.keys(), ...candidateByPath.keys()]),
  ].sort();
  const parts: string[] = [];
  for (const path of paths) {
    const displayPath = sanitizeDisplayText(path);
    const before = baseByPath.get(path);
    const after = candidateByPath.get(path);
    const diff = await unifiedDiffBytes(
      before ? `a/${displayPath}` : "/dev/null",
      after ? `b/${displayPath}` : "/dev/null",
      before?.content ?? null,
      after?.content ?? null,
      {
        fromExecutable: before?.mode === "100755",
        toExecutable: after?.mode === "100755",
      },
    );
    if (diff) parts.push(diff);
  }
  return parts.join("");
}
