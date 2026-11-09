import { isTerminalControlCode } from "./assert";
import type { IgnoreRule } from "./git";

/**
 * The refusal text for files that a publication commit must contain but that
 * the data repo ignores. Pure, so the guard in `git.ts` and the tests share
 * one rendering.
 *
 * The fix depends on where the rule lives. A `.gitignore` under an owned root
 * is one the commit itself writes, from the project item or from a canonical
 * skill that a projection copies, so editing the data-repo copy is undone by
 * the next try. Any other rule can be removed in the data repo. Deleting the
 * file works only when the item supplies it: capshelf writes some files
 * itself, such as the adopt provenance sidecar.
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

/** The row line that names an ignore rule, shared with the PIN-11 refusal. */
export function ignoreRuleLine(rule: IgnoreRule): string {
  return `      ignored by ${displayText(rule.source)}:${rule.line}  ${displayText(rule.pattern)}`;
}

/**
 * A path or ignore pattern from Git can hold any byte but NUL. A terminal
 * control code in it must not reach the terminal.
 */
function displayText(text: string): string {
  return [...text]
    .map((char) =>
      isTerminalControlCode(char.codePointAt(0) ?? 0) ? " " : char,
    )
    .join("");
}
