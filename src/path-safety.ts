import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { PreconditionError } from "./errors";
import { isErrno } from "./errno";

/**
 * "inside" allows a symlink when every real path it resolves to stays inside
 * `realpath(root)`, such as the alias `.claude/skills/<name> ->
 * ../../.agents/skills/<name>`. "deny" allows no symlink component, and data
 * repo paths use it.
 */
export type ConfinementPolicy = "inside" | "deny";

/**
 * Mutation helpers take a `MutationScope`, so a caller cannot skip the check by
 * accident. `{ root }` confines the path. `{ exempt }` records why a path may
 * lie outside any root.
 */
export type MutationScope =
  | { root: string; policy?: ConfinementPolicy }
  | { exempt: string };

export function dataRepoScope(dataRepo: string): MutationScope {
  return { root: dataRepo, policy: "deny" };
}

type WalkPolicy = ConfinementPolicy | "follow";

interface Walked {
  real: string;
  link: string | null;
}

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
 * A missing root has no symlink below it, but a dangling-symlink root exists as
 * a link and is refused.
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

export function resolveThroughExistingSync(path: string): string {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  return walk(root, parts, "follow", root, absolute).real;
}

export async function assertConfined(
  root: string,
  target: string,
  policy: ConfinementPolicy = "inside",
): Promise<string> {
  return assertConfinedSync(root, target, policy);
}

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
 * Refuse a `candidate` whose real path is `root` or below it. This is the
 * inverse of a confinement check: a path outside the root is the allowed case.
 * Every symlink is followed.
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
