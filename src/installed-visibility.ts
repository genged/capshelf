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
 * Git answers ignore policy (nested files, info/exclude, core.excludesFile,
 * negation) exactly, so it is delegated instead of reimplemented; local scope
 * omits capshelf's own exclude lines.
 */
export async function installedVisiblePaths(opts: {
  project: string;
  root: string;
  kind: ItemKind;
  name: string;
  candidates: readonly string[];
  scope: Scope;
  /**
   * Incoming files' .gitignore files also decide visibility, since the folder
   * may hold none yet (e.g. after `rm` kept a volume).
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
