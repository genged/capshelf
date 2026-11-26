/**
 * Every pinning and verifying path must hash identically byte-for-byte, or
 * locked shas stop matching and every item looks drifted. Hash is sha256 of
 * name, NUL, content, NUL per entry sorted by UTF-16 order, truncated to 12 hex
 * chars.
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
