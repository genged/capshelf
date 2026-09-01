import bash from "@speed-highlight/core/languages/bash.js";
import c from "@speed-highlight/core/languages/c.js";
import css from "@speed-highlight/core/languages/css.js";
import docker from "@speed-highlight/core/languages/docker.js";
import go from "@speed-highlight/core/languages/go.js";
import html from "@speed-highlight/core/languages/html.js";
import ini from "@speed-highlight/core/languages/ini.js";
import js from "@speed-highlight/core/languages/js.js";
import json from "@speed-highlight/core/languages/json.js";
import make from "@speed-highlight/core/languages/make.js";
import md from "@speed-highlight/core/languages/md.js";
import py from "@speed-highlight/core/languages/py.js";
import rs from "@speed-highlight/core/languages/rs.js";
import sql from "@speed-highlight/core/languages/sql.js";
import toml from "@speed-highlight/core/languages/toml.js";
import ts from "@speed-highlight/core/languages/ts.js";
import xml from "@speed-highlight/core/languages/xml.js";
import yaml from "@speed-highlight/core/languages/yaml.js";
import { tokenizeWith } from "@speed-highlight/core/tokenize";
import type { ShjLanguageData, ShjToken } from "@speed-highlight/core/tokenize";
import { basename, extname } from "node:path";
import { isTerminalControlCode } from "./assert";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const GRAY = "\x1b[90m";

const TOKEN_STYLE: Partial<Record<ShjToken, string>> = {
  deleted: RED,
  err: RED,
  var: WHITE,
  section: CYAN,
  kwd: MAGENTA,
  class: CYAN,
  cmnt: GRAY,
  insert: GREEN,
  type: CYAN,
  func: BLUE,
  bool: YELLOW,
  num: YELLOW,
  oper: CYAN,
  str: GREEN,
  esc: YELLOW,
};

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, ShjLanguageData>> = {
  ".bash": bash,
  ".c": c,
  ".cc": c,
  ".cjs": js,
  ".cpp": c,
  ".css": css,
  ".cts": ts,
  ".go": go,
  ".h": c,
  ".hpp": c,
  ".htm": html,
  ".html": html,
  ".ini": ini,
  ".js": js,
  ".json": json,
  ".jsx": js,
  ".md": md,
  ".mdx": md,
  ".mjs": js,
  ".mts": ts,
  ".py": py,
  ".pyi": py,
  ".pyw": py,
  ".rs": rs,
  ".sh": bash,
  ".sql": sql,
  ".toml": toml,
  ".ts": ts,
  ".tsx": ts,
  ".xml": xml,
  ".yaml": yaml,
  ".yml": yaml,
};

const MAX_RENDERED_LINES = 10_000;

/** Render a safe ANSI diff. Syntax colours come from the current file path. */
export function highlightTerminalDiff(diff: string): string[] {
  if (diff.length === 0) return [`${DIM}no content changes${RESET}`];
  const rawLines = diff.split("\n");
  const limited = rawLines.slice(0, MAX_RENDERED_LINES);
  const out: string[] = [];
  let oldPath: string | null = null;
  let language: ShjLanguageData | undefined;

  for (const rawLine of limited) {
    const line = sanitizeTerminalLine(rawLine);
    if (line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
      out.push(`${BOLD}${RED}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = diffPath(line.slice(4));
      language = languageForPath(newPath ?? oldPath);
      out.push(`${BOLD}${GREEN}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("@@")) {
      out.push(`${CYAN}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push(`${GREEN}+${RESET}${highlightCode(line.slice(1), language)}`);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      out.push(`${RED}-${RESET}${highlightCode(line.slice(1), language)}`);
      continue;
    }
    if (line.startsWith(" ")) {
      out.push(`${DIM} ${RESET}${highlightCode(line.slice(1), language)}`);
      continue;
    }
    out.push(`${DIM}${line}${RESET}`);
  }
  if (rawLines.length > MAX_RENDERED_LINES) {
    out.push(
      `${YELLOW}preview limited to ${MAX_RENDERED_LINES} lines; use capshelf status --diff for the full diff${RESET}`,
    );
  }
  return out;
}

/** Cut one ANSI line to terminal cells without cutting an escape sequence. */
export function truncateAnsiLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(text) <= width) return text;
  const target = Math.max(0, width - 1);
  let out = "";
  let cells = 0;
  let index = 0;
  while (index < text.length && cells < target) {
    if (text[index] === "\x1b") {
      const end = text.indexOf("m", index + 2);
      const parameters = end === -1 ? "" : text.slice(index + 2, end);
      if (
        text[index + 1] === "[" &&
        end !== -1 &&
        /^[0-9;]*$/.test(parameters)
      ) {
        out += text.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const char = String.fromCodePoint(point);
    const next = Bun.stringWidth(char);
    if (cells + next > target) break;
    out += char;
    cells += next;
    index += char.length;
  }
  return `${out}…${RESET}`;
}

function languageForPath(path: string | null): ShjLanguageData | undefined {
  if (path === null) return undefined;
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return docker;
  if (name === "makefile") return make;
  return LANGUAGE_BY_EXTENSION[extname(name)];
}

function highlightCode(
  code: string,
  language: ShjLanguageData | undefined,
): string {
  if (!language || code.length === 0) return code;
  let out = "";
  tokenizeWith(code, language, (text, token) => {
    const style = token ? TOKEN_STYLE[token] : undefined;
    out += style ? `${style}${text}${RESET}` : text;
  });
  return out;
}

function diffPath(label: string): string | null {
  if (label === "/dev/null") return null;
  return label.startsWith("a/") || label.startsWith("b/")
    ? label.slice(2)
    : label;
}

function sanitizeTerminalLine(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\t") {
      out += "  ";
      continue;
    }
    const point = char.codePointAt(0) ?? 0;
    out += isTerminalControlCode(point) ? " " : char;
  }
  return out;
}
