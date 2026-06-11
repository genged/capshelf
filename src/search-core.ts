/**
 * Pure search machinery for `capshelf search`: whitespace-split terms, AND
 * semantics, case-insensitive substring matching over four weighted fields,
 * and deterministic result ordering. No fuzzy matching, no index, no
 * dependencies — predictable for agents and trivially testable.
 */
import { METADATA_SIDECAR } from "./metadata";

export type SearchFieldName = "name" | "tags" | "description" | "content";

/** Per-field weights: an item's score sums the best field each term hit. */
export const FIELD_WEIGHTS: Record<SearchFieldName, number> = {
  name: 8,
  tags: 4,
  description: 2,
  content: 1,
};

/** Content files larger than this are skipped (binary/log heuristics). */
export const MAX_SEARCHABLE_CONTENT_BYTES = 256 * 1024;

export interface SearchContentFile {
  /** Path relative to the item root, e.g. "SKILL.md". */
  relPath: string;
  content: string;
}

export interface SearchableItem {
  /** Kind-qualified name, e.g. "skills/security-review". */
  name: string;
  tags: string[];
  description?: string;
  files: SearchContentFile[];
}

export interface SearchMatch {
  term: string;
  field: SearchFieldName;
  /** For content matches: the first matching file's relative path. */
  file?: string;
  /** Human annotation detail (matched tag value or content file path). */
  detail?: string;
}

export interface SearchScore {
  score: number;
  matches: SearchMatch[];
}

export function splitTerms(query: string): string[] {
  return query.split(/\s+/).filter((term) => term.length > 0);
}

/**
 * Whether a file's content participates in search. Skips the metadata
 * sidecar itself (its fields are already structured inputs), oversize files,
 * and files containing a NUL byte (binary heuristic).
 */
export function isSearchableContent(
  relPath: string,
  content: Uint8Array,
): boolean {
  if (relPath === METADATA_SIDECAR) return false;
  if (content.byteLength > MAX_SEARCHABLE_CONTENT_BYTES) return false;
  if (content.includes(0)) return false;
  return true;
}

/**
 * Match every term (AND) against the item's fields. Each term scores the
 * best (highest-weight) field it hits; a term hitting nothing disqualifies
 * the item. Returns null on no match or an empty term list.
 */
export function matchItem(
  terms: string[],
  item: SearchableItem,
): SearchScore | null {
  if (terms.length === 0) return null;
  const matches: SearchMatch[] = [];
  let score = 0;
  for (const term of terms) {
    const match = bestMatchForTerm(term, item);
    if (!match) return null;
    score += FIELD_WEIGHTS[match.field];
    matches.push(match);
  }
  return { score, matches };
}

/** Sort by score descending, then kind-qualified name ascending. */
export function compareResults(
  a: { score: number; name: string },
  b: { score: number; name: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Unique `field(detail)` annotations for the human `matched:` column. */
export function matchAnnotations(matches: SearchMatch[]): string[] {
  const out: string[] = [];
  for (const match of matches) {
    const annotation = match.detail
      ? `${match.field}(${match.detail})`
      : match.field;
    if (!out.includes(annotation)) out.push(annotation);
  }
  return out;
}

function bestMatchForTerm(
  term: string,
  item: SearchableItem,
): SearchMatch | null {
  const needle = term.toLowerCase();
  if (item.name.toLowerCase().includes(needle)) {
    return { term, field: "name" };
  }
  const tag = item.tags.find((t) => t.toLowerCase().includes(needle));
  if (tag !== undefined) {
    return { term, field: "tags", detail: tag };
  }
  if (item.description?.toLowerCase().includes(needle)) {
    return { term, field: "description" };
  }
  const file = item.files.find((f) => f.content.toLowerCase().includes(needle));
  if (file) {
    return { term, field: "content", file: file.relPath, detail: file.relPath };
  }
  return null;
}
