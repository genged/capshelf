import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { PreconditionError } from "./errors";
import { isErrno } from "./errno";

/**
 * The one confinement rule for every managed write.
 *
 * "inside": a symlink is allowed when every real path it resolves to stays
 * inside `realpath(root)`. Project paths use this. The codex-compatible alias
 * `.claude/skills/<name> -> ../../.agents/skills/<name>` is the main case.
 * "deny": no component may be a symlink. Data repo paths use this.
 */
export type ConfinementPolicy = "inside" | "deny";

/**
 * Where a mutation helper may act. A helper that writes, deletes, or moves
 * takes a `MutationScope`, so a caller cannot skip the check by accident.
 * `{ root }` confines the path. `{ exempt }` names the reason the path may
 * lie outside any root, for example a cache in the user's config folder.
 */
export type MutationScope =
  | { root: string; policy?: ConfinementPolicy }
  | { exempt: string };

/** The scope of a write into the data repo: no symlink in the path. */
export function dataRepoScope(dataRepo: string): MutationScope {
  return { root: dataRepo, policy: "deny" };
}

type WalkPolicy = ConfinementPolicy | "follow";

interface Walked {
  /** The real path of the target. A missing tail is appended as written. */
  real: string;
  /** The first component that is a symlink, as a path below the start. */
  link: string | null;
}

/**
 * Split a `/` path below the root. "." and the empty string are never valid
 * as a relative path. The root itself is named by an absolute target.
 */
function safeRelativeParts(relPath: string): string[] {
  const parts = relPath.split("/").filter((part) => part.length > 0);
  if (
    relPath === "" ||
    isAbsolute(relPath) ||
    relPath.includes("\\") ||
    parts.includes(".") ||
    parts.includes("..")
  ) {
    throw new PreconditionError(`unsafe repository path "${relPath}"`);
  }
  return parts;
}

/**
 * The only symlink walk in the code base. It starts at `start` (a real path)
 * and takes one component of `parts` at a time with `lstat`. A symlink is
 * resolved with `realpath`, and the walk goes on from there. A missing
 * component ends the walk, because nothing below it exists yet.
 *
 * `shown` is the path that an error message names.
 */
function walk(
  start: string,
  parts: readonly string[],
  policy: WalkPolicy,
  rootReal: string,
  shown: string,
): Walked {
  let current = start;
  let link: string | null = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const next = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
        return { real: resolve(current, ...parts.slice(index)), link };
      }
      throw error;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    link ??= parts.slice(0, index + 1).join("/");
    if (policy === "deny") {
      throw new PreconditionError(`${shown} has symlink component "${part}"`);
    }
    let real: string;
    try {
      real = realpathSync(next);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      if (policy === "follow") {
        return { real: resolve(current, ...parts.slice(index)), link };
      }
      throw new PreconditionError(
        `${shown} has a dangling symlink at "${part}"; capshelf does not write through a link that points nowhere`,
      );
    }
    if (policy === "inside" && !isInside(rootReal, real)) {
      throw new PreconditionError(
        `${shown} resolves to ${real}, outside the project ${rootReal}; capshelf writes managed files inside the project only`,
        {
          hint: `The symlink "${part}" leaves the project. Replace it with a real folder, or point it at a path inside the project.`,
        },
      );
    }
    current = real;
  }
  return { real: current, link };
}

/**
 * A root that does not exist has no symlink below it. A root that is a
 * dangling symlink does exist as a link, and capshelf refuses it.
 */
function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    let isLink = false;
    try {
      isLink = lstatSync(root).isSymbolicLink();
    } catch (statError) {
      if (!isErrno(statError, "ENOENT") && !isErrno(statError, "ENOTDIR")) {
        throw statError;
      }
    }
    if (isLink) {
      throw new PreconditionError(
        `the project root ${root} is a dangling symlink; capshelf does not write through a link that points nowhere`,
      );
    }
    return resolve(root);
  }
}

function isInside(rootReal: string, path: string): boolean {
  const rel = relative(rootReal, path);
  return (
    rel === "" ||
    !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  );
}

/**
 * Check that `target` stays inside `root` under `policy`, and return its real
 * path. `target` is an absolute path inside `root`, or a `/` path relative to
 * `root`. Throws `PreconditionError` (exit 3) for an unsafe relative path, an
 * escape, a dangling symlink, or (under "deny") any symlink.
 */
export function assertConfinedSync(
  root: string,
  target: string,
  policy: ConfinementPolicy = "inside",
): string {
  let relPath = target;
  let parts: string[];
  if (!isAbsolute(target)) {
    parts = safeRelativeParts(relPath);
  } else {
    const lexicalRoot = resolve(root);
    const lexicalTarget = resolve(target);
    if (
      lexicalTarget !== lexicalRoot &&
      !lexicalTarget.startsWith(lexicalRoot + sep)
    ) {
      throw new PreconditionError(
        `refusing path outside project: ${target}\n  (resolved to ${lexicalTarget}, project root ${lexicalRoot})`,
      );
    }
    relPath = relative(lexicalRoot, lexicalTarget).split(sep).join("/");
    parts = relPath === "" ? [] : safeRelativeParts(relPath);
  }
  const rootReal = realRoot(root);
  return walk(rootReal, parts, policy, rootReal, relPath).real;
}

/**
 * The real path of an absolute `path` that may not exist. Every existing
 * ancestor is resolved through symlinks, and the missing tail is kept whole.
 * It checks no confinement. A dangling link ends the walk like a missing one.
 */
export function resolveThroughExistingSync(path: string): string {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  return walk(root, parts, "follow", root, absolute).real;
}

/** The async entry point. It shares `assertConfinedSync`'s walk. */
export async function assertConfined(
  root: string,
  target: string,
  policy: ConfinementPolicy = "inside",
): Promise<string> {
  return assertConfinedSync(root, target, policy);
}

/** Apply `scope` to `path`. An exempt scope checks nothing. */
export function assertInScopeSync(scope: MutationScope, path: string): void {
  if ("exempt" in scope) return;
  assertConfinedSync(scope.root, path, scope.policy);
}

export async function assertInScope(
  scope: MutationScope,
  path: string,
): Promise<void> {
  assertInScopeSync(scope, path);
}

/**
 * Refuse a `candidate` whose real path is `root` or below it. This is not a
 * confinement check: a path outside the root is the allowed case. It follows
 * every symlink, with the same walk.
 */
export async function assertRealPathOutsideRoot(
  root: string,
  candidate: string,
  message: string,
): Promise<void> {
  const rootReal = realpathSync(root);
  const absolute = resolve(candidate);
  const { root: top } = parse(absolute);
  const parts = absolute.slice(top.length).split(sep).filter(Boolean);
  const { real } = walk(
    realpathSync(top),
    parts,
    "follow",
    rootReal,
    candidate,
  );
  if (isInside(rootReal, real)) throw new PreconditionError(message);
}
