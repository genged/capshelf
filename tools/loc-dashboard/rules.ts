/**
 * What counts as production code and what counts as test code. Edit this
 * table to point the dashboard at another layout. A path that matches no
 * rule is not counted at all: docs, configuration, generated files, and
 * assets do not move the lines.
 */
import type { LocRuleText, SeriesId } from "./shared/types";

export interface LocRule {
  series: SeriesId;
  /** A directory prefix ending in `/`, or an exact file path. */
  prefix: string;
  extensions: readonly string[];
  /** Only paths whose file name passes this test count. */
  fileName?: RegExp;
  /** Paths under this prefix are skipped even when the rule matches. */
  exclude?: readonly string[];
  description: string;
}

export const RULES: readonly LocRule[] = [
  {
    series: "prod",
    prefix: "src/",
    extensions: [".ts", ".tsx", ".css"],
    exclude: ["src/ui/generated/"],
    description: "src/**/*.{ts,tsx,css}",
  },
  {
    series: "test",
    prefix: "tests/",
    extensions: [".ts", ".tsx", ".sh", ".py"],
    description: "tests/**/*.{ts,tsx,sh,py}",
  },
  {
    series: "test",
    prefix: "e2e/",
    extensions: [".ts", ".tsx", ".sh", ".py"],
    description: "e2e/**/*.{ts,tsx,sh,py}",
  },
  {
    series: "test",
    prefix: "scripts/",
    extensions: [".sh"],
    fileName: /^smoke-.*\.sh$/,
    description: "scripts/smoke-*.sh",
  },
];

export function classify(path: string): SeriesId | null {
  for (const rule of RULES) {
    if (!path.startsWith(rule.prefix)) continue;
    if (rule.exclude?.some((skip) => path.startsWith(skip))) continue;
    if (!rule.extensions.some((extension) => path.endsWith(extension))) {
      continue;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (rule.fileName && !rule.fileName.test(name)) continue;
    return rule.series;
  }
  return null;
}

export function ruleTexts(): LocRuleText[] {
  return RULES.map((rule) => ({
    series: rule.series,
    description: rule.description,
  }));
}

/**
 * The directory a file is grouped under in the breakdown: the first two
 * path segments, or the first one for a file that sits at the top of its
 * root directory.
 */
export function groupDirectory(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return parts[0] ?? path;
  return `${parts[0]}/${parts[1]}`;
}
