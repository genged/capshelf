/**
 * Mirrors `homeRelative` in `src/paths.ts`; the home directory comes from the
 * overview because the browser cannot know it.
 */
export function homeDisplay(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
