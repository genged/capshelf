/**
 * The single content-hashing convention for items and fragments.
 *
 * Every place that pins or verifies content — add-time working-tree hashing,
 * at-commit hashing for `apply`/`status`, and rebind verification (`set-data`)
 * — MUST agree byte-for-byte, or a project's locked shas stop matching their
 * source and every item looks drifted. That agreement used to live as five
 * hand-copied loops that silently drifted (a missing sidecar filter here, a
 * localeCompare sort there). This is now the one definition:
 *
 *   for each entry, sorted by name (UTF-16 code-unit order):
 *     sha256 <- name, NUL, content, NUL
 *   digest -> first 12 hex chars
 *
 * `name` is the caller's stable key (item-relative path for copy items,
 * repo-relative path for fragments); both sides of any comparison must use the
 * same key convention. Content is hashed as raw bytes (Buffer/Uint8Array) or
 * UTF-8 (string).
 */
export function hashNamedContents(
  entries: Array<{ name: string; content: string | Uint8Array }>,
): string {
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  for (const { name, content } of sorted) {
    hasher.update(name);
    hasher.update("\0");
    hasher.update(content);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}
