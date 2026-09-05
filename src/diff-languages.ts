/**
 * The syntax-highlighting languages a diff can use, keyed by file extension.
 *
 * One table for the terminal preview and the web UI. The module imports only
 * `@speed-highlight/core` language data, so a browser bundle can carry it.
 */
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
import type { ShjLanguageData } from "@speed-highlight/core/tokenize";

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, ShjLanguageData>> =
  {
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

/** The language for a bare file name (no directory part), or undefined. */
export function languageForFileName(name: string): ShjLanguageData | undefined {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return docker;
  if (lower === "makefile") return make;
  const dot = lower.lastIndexOf(".");
  // A dotfile such as `.bashrc` has no extension, which matches `extname`.
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION[lower.slice(dot)];
}
