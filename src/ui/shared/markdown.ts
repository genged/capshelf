/**
 * A small Markdown reader for SKILL.md files, enough for the shelf view to
 * show a skill the way its author laid it out. It produces a block tree, not
 * HTML, so the renderer builds elements and untrusted text never becomes
 * markup. Pure: no DOM, no Node.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; children: Inline[]; href: string };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" }
  | { type: "pre"; text: string };

export interface MarkdownDocument {
  frontmatter: string | null;
  blocks: Block[];
}

/**
 * Split a leading `---` YAML block from the body. The same rules as
 * `extractFrontmatter` in `src/metadata.ts`: a byte-order mark and CRLF line
 * endings do not hide it. An unclosed block is body text.
 */
export interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if ((lines[0] ?? "").trimEnd() !== "---") {
    return { frontmatter: null, body: lines.join("\n") };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trimEnd() === "---") {
      return {
        frontmatter: lines.slice(1, index).join("\n"),
        body: lines.slice(index + 1).join("\n"),
      };
    }
  }
  return { frontmatter: null, body: lines.join("\n") };
}

const FENCE = /^(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+/;
const QUOTE = /^>\s?(.*)$/;

export function parseMarkdown(text: string): MarkdownDocument {
  const { frontmatter, body } = splitFrontmatter(text);
  return { frontmatter, blocks: parseBlocks(body) };
}

export function parseBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: "paragraph",
      children: parseInlines(paragraph.join(" ")),
    });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (
          candidate.trimEnd().startsWith(marker[0] ?? "`") &&
          new RegExp(
            `^${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`,
          ).test(candidate.trimEnd())
        ) {
          break;
        }
        code.push(candidate);
        index += 1;
      }
      blocks.push({
        type: "code",
        lang: fence[2] ?? "",
        text: code.join("\n"),
      });
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length,
        children: parseInlines(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = ORDERED_ITEM.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const next = LIST_ITEM.exec(candidate);
        if (next && ORDERED_ITEM.test(candidate) === ordered) {
          items.push(next[2] ?? "");
          index += 1;
          continue;
        }
        // An indented continuation line belongs to the item above it.
        if (
          candidate.trim().length > 0 &&
          /^\s+/.test(candidate) &&
          items.length > 0
        ) {
          items[items.length - 1] =
            `${items[items.length - 1]} ${candidate.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: "list",
        ordered,
        items: items.map((text) => parseInlines(text)),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index] ?? "");
        if (!next) break;
        quoted.push(next[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", children: parseInlines(quoted.join(" ")) });
      continue;
    }

    if (line.startsWith("|")) {
      flushParagraph();
      const table: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("|")) {
        table.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "pre", text: table.join("\n") });
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

const INLINE =
  /(`+)([\s\S]+?)\1|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>/;

export function parseInlines(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) {
      out.push({ type: "text", text: rest.slice(0, match.index) });
    }
    if (match[2] !== undefined) {
      out.push({ type: "code", text: match[2] });
    } else if (match[3] !== undefined) {
      out.push({ type: "strong", children: parseInlines(match[3]) });
    } else if (match[4] !== undefined) {
      out.push({ type: "em", children: parseInlines(match[4]) });
    } else if (match[5] !== undefined && match[6] !== undefined) {
      out.push({
        type: "link",
        children: parseInlines(match[5]),
        href: match[6],
      });
    } else if (match[7] !== undefined) {
      out.push({
        type: "link",
        children: [{ type: "text", text: match[7] }],
        href: match[7],
      });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

/**
 * A link target the page may open: http, https, mailto, or a relative path.
 * Anything else, `javascript:` included, renders as plain text.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}
