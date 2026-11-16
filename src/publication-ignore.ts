import { isTerminalControlCode } from "./assert";
import type { IgnoreRule } from "./git";

/**
 * A `.gitignore` under an owned root is written by the commit itself, so
 * editing the data-repo copy is undone on the next try; deleting a file only
 * works if the item supplies it.
 */
export function ignoredPublicationMessage(
  paths: readonly string[],
  rules: ReadonlyMap<string, IgnoreRule>,
  ownedRoots: readonly string[],
): string {
  const lines = [
    "the data repo ignores files that this commit must contain",
    "",
  ];
  const writtenSources = new Set<string>();
  let otherRule = false;
  for (const path of paths) {
    lines.push(`    ${displayText(path)}`);
    const rule = rules.get(path);
    if (rule === undefined) {
      otherRule = true;
      continue;
    }
    lines.push(ignoreRuleLine(rule));
    const source = rule.source;
    const written = ownedRoots.some(
      (root) => source === root || source.startsWith(`${root}/`),
    );
    if (written) writtenSources.add(source);
    else otherRule = true;
  }
  lines.push("");
  for (const source of writtenSources) {
    lines.push(
      `  the rule comes from ${displayText(source)}, which this commit writes;`,
      "  change the rule or the file where that .gitignore comes from",
    );
  }
  if (otherRule) {
    lines.push(
      "  remove the rule from the data repo, or, if the item supplies the file,",
      "  delete it from the item",
    );
  }
  lines.push("  the data repo was restored; nothing was published");
  return lines.join("\n");
}

export function ignoreRuleLine(rule: IgnoreRule): string {
  return `      ignored by ${displayText(rule.source)}:${rule.line}  ${displayText(rule.pattern)}`;
}

/**
 * Git paths and ignore patterns can hold any byte but NUL, so each terminal
 * control code is replaced with a space before display.
 */
function displayText(text: string): string {
  return [...text]
    .map((char) =>
      isTerminalControlCode(char.codePointAt(0) ?? 0) ? " " : char,
    )
    .join("");
}
