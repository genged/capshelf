import { constants, existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { PreconditionError } from "./errors";
import { currentFragmentSourcesForItem } from "./fragments";
import { itemRepoRelPath } from "./master";
import type { FragmentItemKind } from "./master";
import type { GitFileMode, NamedFile } from "./merge-tree";
import { subagentSourceCandidates } from "./subagents";

/** The canonical fragment bytes that a commit of the current worktree uses. */
export async function currentFragmentCandidateFiles(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<NamedFile[]> {
  const root = itemRepoRelPath(kind, name);
  const files: NamedFile[] = [];
  for (const source of await currentFragmentSourcesForItem(
    dataRepo,
    kind,
    name,
  )) {
    const fullPath = join(dataRepo, ...source.relPath.split("/"));
    const stats = await lstat(fullPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — canonical source is not a regular file: ${source.relPath}`,
      );
    }
    files.push({
      path: posix.relative(root, source.relPath),
      content: await readFile(fullPath),
      mode: fileMode(stats.mode),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every canonical subagent source that the next commit will contain.
 *
 * `pending` holds installed targets that differ from the locked source. Other
 * targets stay at their current data-repo bytes. This is the same hybrid tree
 * that `promoteSubagent` commits.
 */
export async function promotedSubagentFiles(
  project: string,
  dataRepo: string,
  name: string,
  pending: Array<{ relPath: string; raw: Buffer }>,
): Promise<NamedFile[]> {
  const pendingByRelPath = new Map(
    pending.map(({ relPath, raw }) => [relPath, raw]),
  );
  const files: NamedFile[] = [];
  for (const source of subagentSourceCandidates(project, name)) {
    const sourcePath = join(dataRepo, ...source.relPath.split("/"));
    const content =
      pendingByRelPath.get(source.relPath) ??
      (existsSync(sourcePath) ? await readFile(sourcePath) : null);
    if (content === null) continue;
    files.push({
      path: basename(source.relPath),
      content,
      mode: "100644",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fileMode(mode: number): GitFileMode {
  return (mode & constants.S_IXUSR) !== 0 ? "100755" : "100644";
}
