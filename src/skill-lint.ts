/**
 * Pure skill checks for `capshelf validate`. The caller supplies the item's
 * file list and SKILL.md text, so one rule set covers a data-repo working
 * tree, a bundled system item, and an installed project copy.
 */
import { posix } from "node:path";
import { isConfigString } from "./config-values";
import type { ConfigValue } from "./config-values";
import { extractFrontmatter, parseFrontmatterDocument } from "./metadata";
import {
  parseBlocks,
  parseInlines,
  splitFrontmatter,
} from "./ui/shared/markdown";
import type { Block, Inline } from "./ui/shared/markdown";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type LintResult = "pass" | "warn" | "fail";

export const CHECK_IDS = [
  "skill-md",
  "frontmatter",
  "name",
  "description",
  "body-lines",
  "links",
  "file-refs",
  "steps",
  "error-recovery",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface LintCheck {
  id: CheckId;
  status: CheckStatus;
  message: string;
  details?: string[];
}

export interface SkillLintInput {
  /** The directory name, which is the canonical skill name. */
  name: string;
  /** Item-relative POSIX paths of every file in the item. */
  files: readonly string[];
  /** SKILL.md text, or null when the item has no SKILL.md. */
  skillMd: string | null;
}

/** Characters per token for the description estimate. */
export const CHARS_PER_TOKEN = 4;
export const DESCRIPTION_TOKEN_BUDGET = 100;
export const MAX_DESCRIPTION_CHARS = 1024;
export const BODY_LINE_BUDGET = 500;

const FILE_REF_TOKEN =
  /^(?:\.\/)?(?:scripts|references|assets)\/[^\s*?$`{}<>]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RECOVERY_HEADING =
  /\b(?:errors?|troubleshoot\w*|recover\w*|failures?|problems?)\b/i;
const NUMBERED_HEADING = /^(?:step\s+\d+\b|\d+[.):]\s)/i;
const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const RETRY_ONLY = /^(?:just\s+)?(?:try\s+again|retry|re-?run(?:\s+it)?)\.?$/i;

export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / CHARS_PER_TOKEN);
}

export function lintSkill(input: SkillLintInput): LintCheck[] {
  if (input.skillMd === null) {
    return [
      {
        id: "skill-md",
        status: "fail",
        message: "SKILL.md is missing",
      },
      ...CHECK_IDS.slice(1).map(
        (id): LintCheck => ({
          id,
          status: "skip",
          message: "no SKILL.md",
        }),
      ),
    ];
  }
  const checks: LintCheck[] = [
    { id: "skill-md", status: "pass", message: "SKILL.md is present" },
  ];
  checks.push(...frontmatterChecks(input.name, input.skillMd));
  const blocks = parseBlocks(splitFrontmatter(input.skillMd).body);
  checks.push(bodyLinesCheck(input.skillMd));
  checks.push(linksCheck(blocks, input.files));
  checks.push(fileRefsCheck(blocks, input.files));
  checks.push(stepsCheck(blocks));
  checks.push(errorRecoveryCheck(blocks));
  return checks;
}

export function lintResult(checks: readonly LintCheck[]): LintResult {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function frontmatterChecks(name: string, skillMd: string): LintCheck[] {
  const skipped = (message: string): LintCheck[] => [
    { id: "name", status: "skip", message },
    { id: "description", status: "skip", message },
  ];
  const block = extractFrontmatter(skillMd);
  if (block.malformed) {
    return [
      {
        id: "frontmatter",
        status: "fail",
        message: 'frontmatter has no closing "---"',
      },
      ...skipped("frontmatter is not readable"),
    ];
  }
  if (block.text === null) {
    return [
      {
        id: "frontmatter",
        status: "fail",
        message: 'SKILL.md does not start with a "---" frontmatter block',
      },
      ...skipped("no frontmatter"),
    ];
  }
  const doc = parseFrontmatterDocument(block.text, `skills/${name}`);
  if (!doc.ok) {
    return [
      {
        id: "frontmatter",
        status: "fail",
        message:
          doc.warnings[0] ?? "frontmatter is not a YAML mapping of fields",
      },
      ...skipped("frontmatter is not readable"),
    ];
  }
  const raw = doc.value;
  return [
    { id: "frontmatter", status: "pass", message: "frontmatter parses" },
    nameCheck(name, raw.name),
    descriptionCheck(raw.description),
  ];
}

function nameCheck(name: string, value: ConfigValue | undefined): LintCheck {
  if (value === undefined) {
    return {
      id: "name",
      status: "warn",
      message: `frontmatter has no "name"; add name: ${name}`,
    };
  }
  if (!isConfigString(value)) {
    return {
      id: "name",
      status: "fail",
      message: '"name" is not a string',
    };
  }
  if (value !== name) {
    return {
      id: "name",
      status: "fail",
      message: `"name" is "${value}" but the directory is "${name}"`,
    };
  }
  return { id: "name", status: "pass", message: `"name" is "${name}"` };
}

function descriptionCheck(value: ConfigValue | undefined): LintCheck {
  if (value === undefined) {
    return {
      id: "description",
      status: "fail",
      message: 'frontmatter has no "description"',
    };
  }
  if (!isConfigString(value)) {
    return {
      id: "description",
      status: "fail",
      message: '"description" is not a string',
    };
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return {
      id: "description",
      status: "fail",
      message: '"description" is empty',
    };
  }
  const chars = [...text].length;
  const tokens = estimateTokens(text);
  if (chars > MAX_DESCRIPTION_CHARS) {
    return {
      id: "description",
      status: "fail",
      message: `description has ${chars} characters; the limit is ${MAX_DESCRIPTION_CHARS}`,
    };
  }
  if (tokens > DESCRIPTION_TOKEN_BUDGET) {
    return {
      id: "description",
      status: "warn",
      message: `description is about ${tokens} tokens; the budget is ${DESCRIPTION_TOKEN_BUDGET}`,
    };
  }
  return {
    id: "description",
    status: "pass",
    message: `description is about ${tokens} tokens`,
  };
}

function bodyLinesCheck(skillMd: string): LintCheck {
  const lines = splitFrontmatter(skillMd).body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const count = lines.length;
  if (count > BODY_LINE_BUDGET) {
    return {
      id: "body-lines",
      status: "warn",
      message: `body has ${count} lines; the budget is ${BODY_LINE_BUDGET}. Move detail into reference files`,
    };
  }
  return {
    id: "body-lines",
    status: "pass",
    message: `body has ${plural(count, "line")}`,
  };
}

function linksCheck(
  blocks: readonly Block[],
  files: readonly string[],
): LintCheck {
  const hrefs = new Set<string>();
  for (const inline of blockInlines(blocks)) {
    if (inline.type === "link") hrefs.add(inline.href);
  }
  let checked = 0;
  const broken: string[] = [];
  for (const href of [...hrefs].sort()) {
    const target = localLinkTarget(href);
    if (target === null) continue;
    checked += 1;
    const problem = resolveProblem(target, files);
    if (problem !== null) broken.push(`${href}: ${problem}`);
  }
  if (broken.length > 0) {
    return {
      id: "links",
      status: "fail",
      message: `${broken.length} of ${plural(checked, "relative link")} do not resolve inside the item`,
      details: broken,
    };
  }
  return {
    id: "links",
    status: "pass",
    message: `${plural(checked, "relative link")} checked, all resolve`,
  };
}

function fileRefsCheck(
  blocks: readonly Block[],
  files: readonly string[],
): LintCheck {
  const refs = new Set<string>();
  const addTokens = (text: string): void => {
    for (const raw of text.split(/\s+/)) {
      const token = raw.replace(/^["'(]+|["'),;:.]+$/g, "");
      if (FILE_REF_TOKEN.test(token)) refs.add(token);
    }
  };
  for (const block of blocks) {
    if (block.type === "code") addTokens(block.text);
  }
  for (const inline of blockInlines(blocks)) {
    if (inline.type === "code") addTokens(inline.text);
  }
  const missing = [...refs]
    .sort()
    .filter((ref) => resolveProblem(ref, files) !== null);
  if (missing.length > 0) {
    return {
      id: "file-refs",
      status: "warn",
      message: `${missing.length} of ${plural(refs.size, "referenced file")} are not in the item`,
      details: missing,
    };
  }
  return {
    id: "file-refs",
    status: "pass",
    message: `${plural(refs.size, "referenced file")} checked, all in the item`,
  };
}

function stepsCheck(blocks: readonly Block[]): LintCheck {
  let listSteps = 0;
  let headingSteps = 0;
  for (const block of blocks) {
    if (block.type === "list" && block.ordered) {
      listSteps = Math.max(listSteps, block.items.length);
    }
    if (
      block.type === "heading" &&
      NUMBERED_HEADING.test(inlineText(block.children))
    ) {
      headingSteps += 1;
    }
  }
  const steps = Math.max(listSteps, headingSteps);
  if (steps < 2) {
    return {
      id: "steps",
      status: "warn",
      message:
        "no numbered steps; write the procedure as a numbered list with one objective per step",
    };
  }
  return {
    id: "steps",
    status: "pass",
    message: `${plural(steps, "numbered step")}`,
  };
}

function errorRecoveryCheck(blocks: readonly Block[]): LintCheck {
  const start = blocks.findIndex(
    (block) =>
      block.type === "heading" &&
      RECOVERY_HEADING.test(inlineText(block.children)),
  );
  const heading = blocks[start];
  if (heading === undefined || heading.type !== "heading") {
    return {
      id: "error-recovery",
      status: "warn",
      message:
        "no error-recovery section; add a heading such as Troubleshooting with a table of failures and fixes",
    };
  }
  const title = inlineText(heading.children);
  const fixes: string[] = [];
  for (const block of blocks.slice(start + 1)) {
    if (block.type === "heading" && block.level <= heading.level) break;
    if (block.type === "pre") fixes.push(...tableFixCells(block.text));
  }
  if (fixes.length === 0) {
    return {
      id: "error-recovery",
      status: "warn",
      message: `section "${title}" has no table of failures and fixes`,
    };
  }
  if (fixes.every((fix) => RETRY_ONLY.test(fix))) {
    return {
      id: "error-recovery",
      status: "warn",
      message: `section "${title}" only says to try again; give a concrete fix for each failure`,
    };
  }
  return {
    id: "error-recovery",
    status: "pass",
    message: `section "${title}" has ${plural(fixes.length, "failure row")}`,
  };
}

/** Returns the last cell of each data row, or nothing when it is not a table. */
function tableFixCells(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length < 3 || !TABLE_SEPARATOR.test(lines[1] ?? "")) return [];
  return lines
    .slice(2)
    .map((line) => {
      const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      return cells.at(-1) ?? "";
    })
    .filter((cell) => cell.length > 0);
}

/** Returns the item-relative target, or null for a link this check skips. */
function localLinkTarget(href: string): string | null {
  if (href.startsWith("#")) return null;
  if (href.startsWith("//") || URL_SCHEME.test(href)) return null;
  return href.replace(/[?#].*$/, "");
}

function resolveProblem(
  target: string,
  files: readonly string[],
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return "not a valid URL path";
  }
  if (decoded.startsWith("/")) return "absolute path";
  const normalized = posix.normalize(decoded).replace(/\/$/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    return "points outside the item";
  }
  if (normalized === "." || normalized === "") return null;
  const prefix = `${normalized}/`;
  if (files.some((file) => file === normalized || file.startsWith(prefix))) {
    return null;
  }
  return "no such file";
}

/** Every inline node in the body, tables included, nested nodes flattened. */
function blockInlines(blocks: readonly Block[]): Inline[] {
  const out: Inline[] = [];
  const visit = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.type !== "text" && node.type !== "code") visit(node.children);
    }
  };
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "quote":
        visit(block.children);
        break;
      case "list":
        for (const item of block.items) visit(item);
        break;
      case "pre":
        for (const line of block.text.split("\n")) visit(parseInlines(line));
        break;
      case "code":
      case "rule":
        break;
    }
  }
  return out;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : inlineText(node.children),
    )
    .join("");
}
