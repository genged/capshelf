/**
 * Home-relative display of an absolute path in the browser, the way
 * `homeRelative` in `src/paths.ts` prints it. The overview carries the home
 * directory, so the client never guesses it.
 */
export function homeDisplay(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
