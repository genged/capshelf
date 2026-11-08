import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import { isIgnoredDotDirent } from "./dotfiles";
import { PreconditionError } from "./errors";

interface IgnoreScope {
  relDir: string;
  matcher: ReturnType<typeof ignore>;
}

export async function gitignoreVisibleFiles(
  root: string,
  options: {
    /**
     * List a visible symlink as a path instead of refusing it. A reader that
     * only classifies installed paths uses this. A source read must refuse.
     */
    listSymlinks?: boolean;
  } = {},
): Promise<string[]> {
  const out: string[] = [];

  async function walk(
    relDir: string,
    scopes: readonly IgnoreScope[],
  ): Promise<void> {
    const activeScopes = await scopesWithLocalGitignore(root, relDir, scopes);
    const abs = relDir ? join(root, ...relDir.split("/")) : root;
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (isIgnoredDotDirent(entry)) continue;

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isIgnoredByScopes(rel, entry.isDirectory(), activeScopes)) continue;

      if (entry.isDirectory()) await walk(rel, activeScopes);
      else if (entry.isFile()) out.push(rel);
      else if (entry.isSymbolicLink() && options.listSymlinks === true) {
        out.push(rel);
      } else if (entry.isSymbolicLink()) {
        throw new PreconditionError(
          `${root} contains an unsupported symlink: ${rel}; copy items support regular files only`,
          {
            hint: "Dependency installs create symlinks, for example node_modules from pnpm. Delete the path, or list it in a .gitignore inside the item. Only .gitignore files inside the item apply here.",
          },
        );
      } else {
        throw new PreconditionError(
          `${root} contains an unsupported filesystem object: ${rel}; copy items support regular files only`,
        );
      }
    }
  }

  await walk("", []);
  return out.sort();
}

/**
 * The paths that the given item `.gitignore` files ignore. The files are
 * held in memory, for example the ones a write is about to install, so a
 * caller can ask "will Git see this path after the write". A path below an
 * ignored folder is ignored, as in Git.
 */
export function ignoredByItemGitignores(
  gitignores: readonly { path: string; content: Buffer }[],
  paths: readonly string[],
): Set<string> {
  const scopes: IgnoreScope[] = gitignores
    .filter(
      (file) => file.path === ".gitignore" || file.path.endsWith("/.gitignore"),
    )
    .map((file) => ({
      relDir:
        file.path === ".gitignore"
          ? ""
          : file.path.slice(0, -"/.gitignore".length),
      matcher: ignore().add(file.content.toString("utf-8")),
    }))
    // Outer files first, so a nested file can re-include a path.
    .sort((left, right) => left.relDir.length - right.relDir.length);
  const ignored = new Set<string>();
  if (scopes.length === 0) return ignored;
  for (const path of paths) {
    const parts = path.split("/");
    const hidden = parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      const isDirectory = index < parts.length - 1;
      return isIgnoredByScopes(prefix, isDirectory, scopes);
    });
    if (hidden) ignored.add(path);
  }
  return ignored;
}

export interface LocalTreeObject {
  path: string;
  type: "symlink" | "other";
}

export interface LocalTreeInventory {
  /** Regular files, sorted. */
  files: string[];
  /** Everything that is not a regular file or directory, sorted by path. */
  irregular: LocalTreeObject[];
}

/**
 * Inventory every physical object below an installed item, including paths
 * hidden by nested `.gitignore` rules. This is row 4 of the object-model
 * table in `master.ts`: the population is the user's own local state, so
 * non-regular objects are classified rather than refused and the caller
 * decides whether to preserve, list, or delete them. `gitignoreVisibleFiles`
 * keeps its throw — that is the row-1 trust boundary and it does not move.
 */
export async function inventoryLocalTree(
  root: string,
): Promise<LocalTreeInventory> {
  const files: string[] = [];
  const irregular: LocalTreeObject[] = [];

  async function walk(relDir: string): Promise<void> {
    const abs = relDir ? join(root, ...relDir.split("/")) : root;
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) files.push(rel);
      else {
        irregular.push({
          path: rel,
          type: entry.isSymbolicLink() ? "symlink" : "other",
        });
      }
    }
  }

  await walk("");
  return {
    files: files.sort(),
    irregular: irregular.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

async function scopesWithLocalGitignore(
  root: string,
  relDir: string,
  scopes: readonly IgnoreScope[],
): Promise<readonly IgnoreScope[]> {
  const path = join(root, ...(relDir ? relDir.split("/") : []), ".gitignore");
  if (!existsSync(path)) return scopes;

  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new PreconditionError(
      `${root} contains an unsupported symlink: ${relDir ? `${relDir}/` : ""}.gitignore; copy items support regular files only`,
    );
  }
  if (!info.isFile()) return scopes;

  const content = await readFile(path, "utf-8");
  const matcher = ignore().add(content);
  return [...scopes, { relDir, matcher }];
}

function isIgnoredByScopes(
  relPath: string,
  isDirectory: boolean,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const scopedRelPath = relativeToScope(relPath, scope.relDir);
    if (scopedRelPath === null) continue;
    const pathForMatch = isDirectory ? `${scopedRelPath}/` : scopedRelPath;
    const result = scope.matcher.test(pathForMatch);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function relativeToScope(relPath: string, relDir: string): string | null {
  if (!relDir) return relPath;
  if (relPath === relDir) return "";
  const prefix = `${relDir}/`;
  if (!relPath.startsWith(prefix)) return null;
  return relPath.slice(prefix.length);
}
