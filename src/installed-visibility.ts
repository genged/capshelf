import { relative } from "node:path";
import {
  gitPolicyVisiblePathsUnderPath,
  gitPolicyVisiblePathsWithoutExcludes,
} from "./git";
import { gitignoreVisibleFiles, ignoredByItemGitignores } from "./gitignore";
import { localExcludeLines } from "./local-config";
import type { ItemKind } from "./master";
import type { Scope } from "./promote-core";

/**
 * PIN-5's classifier for *unpinned* paths under an installed item: which of
 * `candidates` the project sees in Git. Every reader of installed paths uses
 * this one rule, so `status`, the preflight, and the post-write check agree.
 *
 * | destination                        | classifier                                                     |
 * | ---------------------------------- | -------------------------------------------------------------- |
 * | project scope in a Git worktree    | project Git, with the complete ignore stack                     |
 * | local scope in a Git worktree      | project Git without the exclude lines capshelf wrote for the item |
 * | outside Git                        | the item-root ignore walker                                     |
 *
 * Reimplementing Git's ignore stack in process was rejected: exact parity needs
 * nested and parent `.gitignore` files, `.git/info/exclude`,
 * `core.excludesFile`, negation, directory pruning, and the tracked-file rule.
 * Git owns that policy and answers it exactly. Capshelf puts a local-scope item
 * in `.git/info/exclude`, so for that scope Git gets the stack without those
 * lines. A visible symlink is a visible path, not an error.
 *
 * A project ignore edit may therefore move an extra between visible and
 * ignored. That is intentional: it changes who owns an unpinned file, not what
 * the lock manages.
 */
export async function installedVisiblePaths(opts: {
  project: string;
  root: string;
  kind: ItemKind;
  name: string;
  candidates: readonly string[];
  scope: Scope;
  /**
   * The files a write is about to install. Their `.gitignore` files decide
   * too: a path they ignore is not visible after the write, even when the
   * folder holds no `.gitignore` yet (for example after `rm` kept a volume).
   */
  incoming?: readonly { path: string; content: Buffer }[];
}): Promise<Set<string>> {
  if (opts.candidates.length === 0) return new Set();
  const candidates = new Set(opts.candidates);
  const relPath = relative(opts.project, opts.root);
  const fromGit =
    opts.scope === "project"
      ? await gitPolicyVisiblePathsUnderPath(opts.project, relPath)
      : await gitPolicyVisiblePathsWithoutExcludes(
          opts.project,
          relPath,
          new Set(localExcludeLines(opts.kind, opts.name)),
        );
  const visible =
    fromGit ??
    (await gitignoreVisibleFiles(opts.root, { listSymlinks: true }).catch(
      () => [...candidates],
    ));
  const hiddenAfterWrite = ignoredByItemGitignores(
    opts.incoming ?? [],
    opts.candidates,
  );
  return new Set(
    visible.filter(
      (path) => candidates.has(path) && !hiddenAfterWrite.has(path),
    ),
  );
}
