/**
 * Compile-time exhaustiveness guard. Call from a `default:` branch (or any
 * spot that should be unreachable): if the union ever gains a member that
 * isn't handled, `value` stops being `never` and the call fails to type-check,
 * pinpointing the missing case. Throws if somehow reached at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

/**
 * The single definition of a safe item name. Item names become filesystem path
 * segments (installedPath) and git pathspecs (materialize), and they arrive
 * from untrusted, committed inputs — the manifest, the lockfile, the data-repo
 * catalog — in a cloned project. A name that escapes its directory (`..`,
 * absolute, backslash), is empty, or looks like a CLI option (`-…`) must be
 * rejected at every parse boundary, not just some. Keep this the only place the
 * rule lives so the boundaries can't drift apart.
 */
export function isSafeItemName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("/") || name.startsWith("-")) return false;
  if (name.includes("\\")) return false;
  return name
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function assertSafeItemName(name: string, context?: string): void {
  if (isSafeItemName(name)) return;
  throw new Error(
    `invalid item name ${JSON.stringify(name)}${context ? ` (${context})` : ""}`,
  );
}
