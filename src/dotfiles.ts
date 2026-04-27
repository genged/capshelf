interface DirentLike {
  name: string;
  isFile(): boolean;
}

const SHAREABLE_DOTENV_NAMES = new Set([
  ".env.1password",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);

const COMMON_PRIVATE_DOTENV_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test.local",
  ".env.staging",
  ".env.staging.local",
]);

export function isIgnoredDotEntry(name: string): boolean {
  // Dotfiles are item content when they are present in git. Top-level hidden
  // item directories are still skipped by discovery in master.ts.
  return false;
}

export function isIgnoredDotDirent(entry: DirentLike): boolean {
  return false;
}

export function hasIgnoredDotSegment(relPath: string): boolean {
  return false;
}

export function isPrivateDotenvPath(relPath: string): boolean {
  const name = relPath.split("/").at(-1) ?? relPath;
  if (SHAREABLE_DOTENV_NAMES.has(name)) return false;
  if (COMMON_PRIVATE_DOTENV_NAMES.has(name)) return true;
  return name.startsWith(".env.") && name.endsWith(".local");
}

export function privateDotenvFiles(relPaths: Iterable<string>): string[] {
  return [...relPaths].filter(isPrivateDotenvPath).sort();
}
