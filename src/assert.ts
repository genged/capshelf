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
 * C0, DEL, and C1. C1 (U+0080–U+009F) carries single-byte CSI and OSC, so
 * text holding one can drive a terminal the moment a picker or a listing
 * renders it — the same reason C0 is rejected. The single definition of the
 * range: `isSafeItemName`, `sanitizeDisplayText` (pick-core), and
 * `isPickableKey` (config-paths) must agree on it or a name one boundary
 * accepts reaches a renderer another boundary trusted to be clean.
 */
export function isTerminalControlCode(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
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
  if (
    // `pick-core.ts` leaves refs unsanitized on the strength of this rule.
    [...name].some((character) =>
      isTerminalControlCode(character.codePointAt(0)!),
    )
  ) {
    return false;
  }
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

/**
 * The single definition of a safe item root: a repository-relative,
 * POSIX-separated directory an item's bytes are read from. `.` is the
 * repository root and is the one segment that may be a bare dot.
 *
 * The root becomes a git pathspec and a `posix.relative` base, and for a
 * remote skill it arrives from a URL a user pasted. A root that escapes the
 * repository, is absolute, or looks like a CLI option must be rejected before
 * it reaches either.
 */
export function isSafeItemRoot(root: string): boolean {
  if (root === ".") return true;
  if (root.length === 0) return false;
  if (root.startsWith("/") || root.startsWith("-")) return false;
  if (root.includes("\\")) return false;
  if (
    [...root].some((character) =>
      isTerminalControlCode(character.codePointAt(0)!),
    )
  ) {
    return false;
  }
  return root
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function assertSafeItemRoot(root: string, context?: string): void {
  if (isSafeItemRoot(root)) return;
  throw new Error(
    `invalid item root ${JSON.stringify(root)}${context ? ` (${context})` : ""}`,
  );
}

/**
 * A branch or tag name capshelf is willing to put in a git argv. Deliberately
 * narrower than `git check-ref-format`: capshelf only ever records a ref a
 * user typed or a URL carried, so the useful question is whether it is a plain
 * name rather than whether Git would tolerate it.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (ref.includes("..") || ref.endsWith(".lock")) return false;
  if (/[\s~^:?*[\]\\]/u.test(ref)) return false;
  if (
    [...ref].some((character) =>
      isTerminalControlCode(character.codePointAt(0)!),
    )
  ) {
    return false;
  }
  return ref.split("/").every((seg) => seg !== "" && !seg.startsWith("."));
}
