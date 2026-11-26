export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

/**
 * C1 (U+0080–U+009F) includes single-byte CSI and OSC, so it can drive a
 * terminal like C0. This is the single definition of the range.
 * `isSafeItemName`, `sanitizeDisplayText` and `isPickableKey` must agree on it,
 * or a name one boundary accepts reaches a renderer that another boundary
 * trusted to be clean.
 */
export function isTerminalControlCode(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Item names become path segments and git pathspecs from untrusted committed
 * inputs, so every parse boundary must reject escaping, empty, option-like or
 * control-char names via this one rule.
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
 * A root becomes a git pathspec and `posix.relative` base and can come from a
 * pasted URL, so escaping, absolute or option-like roots must be rejected
 * first.
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
 * A branch or tag name safe to put in a git argv. Deliberately narrower than
 * `git check-ref-format`: capshelf only records refs a user typed or a URL
 * carried, so it only needs to know the ref is a plain name.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (ref.includes("..") || ref.endsWith(".lock")) return false;
  if (ref === "@" || ref.includes("@{") || ref.endsWith(".")) return false;
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
