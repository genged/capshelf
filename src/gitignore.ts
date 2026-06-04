import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import { isIgnoredDotDirent } from "./dotfiles";

interface IgnoreScope {
  relDir: string;
  matcher: ReturnType<typeof ignore>;
}

export async function gitignoreVisibleFiles(root: string): Promise<string[]> {
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
    }
  }

  await walk("", []);
  return out.sort();
}

async function scopesWithLocalGitignore(
  root: string,
  relDir: string,
  scopes: readonly IgnoreScope[],
): Promise<readonly IgnoreScope[]> {
  const path = join(root, ...(relDir ? relDir.split("/") : []), ".gitignore");
  if (!existsSync(path)) return scopes;

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
