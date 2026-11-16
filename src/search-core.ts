import { METADATA_SIDECAR } from "./identity";

export type SearchFieldName = "name" | "tags" | "description" | "content";

export const FIELD_WEIGHTS: Record<SearchFieldName, number> = {
  name: 8,
  tags: 4,
  description: 2,
  content: 1,
};

/** Larger files are skipped as likely binary or logs. */
export const MAX_SEARCHABLE_CONTENT_BYTES = 256 * 1024;

export interface SearchContentFile {
  relPath: string;
  content: string;
}

export interface SearchableItem {
  name: string;
  tags: string[];
  description?: string;
  files: SearchContentFile[];
}

export interface SearchMatch {
  term: string;
  field: SearchFieldName;
  file?: string;
  detail?: string;
}

export interface SearchScore {
  score: number;
  matches: SearchMatch[];
}

export function splitTerms(query: string): string[] {
  return query.split(/\s+/).filter((term) => term.length > 0);
}

export function isSearchableContent(
  relPath: string,
  content: Uint8Array,
): boolean {
  if (relPath === METADATA_SIDECAR) return false;
  if (content.byteLength > MAX_SEARCHABLE_CONTENT_BYTES) return false;
  if (content.includes(0)) return false;
  return true;
}

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

export function compareResults(
  a: { score: number; name: string },
  b: { score: number; name: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

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
