/**
 * The text that `capshelf add <url> --list` prints, and the plugin facts
 * block that a consent prompt prints.
 *
 * Pure: these functions return lines and print nothing. They live outside
 * `src/commands/add-remote.ts` so that `src/commands/update.ts` can print the
 * same facts block without importing another command module.
 */
import { PRODUCT_NAME } from "./identity";
import { sanitizeDisplayText } from "./pick-core";
import {
  CLAUDE_CATALOG_PATH,
  CODEX_CATALOG_PATH,
  lastSegment,
} from "./plugin-discovery";
import type {
  DiscoveredPlugin,
  PluginCatalog,
  PluginPart,
} from "./plugin-discovery";
import type { PluginFactReason, SkillPluginFacts } from "./plugin-facts";
import type { RemoteDiscovery, RemoteSkillCandidate } from "./remote-discovery";
import { shellCommand } from "./shell-quote";

/**
 * Whether a consent prompt (install's, or `src/commands/update.ts`'s pin-move
 * prompt) owes the reader the `renderPluginFacts` block: a plugin skill that
 * uses something outside itself, or whose facts could not all be read.
 */
export function factsWarnOnInstall(
  facts: SkillPluginFacts | undefined,
): boolean {
  return (
    facts !== undefined &&
    (facts.usesPluginParts.length > 0 || !facts.factsComplete)
  );
}

/**
 * Repository-controlled text, made safe to paint.
 *
 * File paths come from `ls-tree` and a description comes from the item's YAML;
 * Git allows almost any byte in a path and YAML carries escapes freely. The
 * consent prompt is the one gate authorizing third-party code to run with the
 * user's permissions, so a repository able to emit ESC or OSC bytes into it
 * could redraw the prompt's own text — hide a file from the list, fake a
 * license line, or drive the terminal. `sanitizeDisplayText` is the same filter
 * the picker applies to the same class of text.
 */
export function safe(text: string): string {
  return sanitizeDisplayText(text);
}

/** Singular everywhere a count can be one: "1 skill", "2 skills". */
export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** A size for a person: bytes, then kB and MB in powers of 1000. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

/**
 * The skill row's "uses" column. "" when the candidate is not a plugin
 * skill or matches none of the four checks and its facts are complete.
 */
export function usesLabel(facts: SkillPluginFacts | undefined): string {
  if (facts === undefined) return "";
  const reasons = facts.usesPluginParts.map(
    (use) => USE_PART_LABELS[use.reason],
  );
  if (reasons.length === 0) {
    return facts.factsComplete ? "" : "facts incomplete";
  }
  const labels = facts.factsComplete
    ? reasons
    : [...reasons, "facts incomplete"];
  return `uses ${labels.join(", ")}`;
}

const USE_PART_LABELS: Record<PluginFactReason, string> = {
  "plugin-root": "plugin root",
  "plugin-agents": "agents",
  "plugin-workflows": "workflows",
  "outside-links": "outside links",
};

// A template string, not interpolation: this is the literal text the facts
// block prints, the plugin-root variable name a skill's own source reads.
const PLUGIN_ROOT_VARIABLE = `\${CLAUDE_PLUGIN_ROOT}`;

/**
 * The consent prompt's facts block: what a plugin skill reaches outside its
 * own directory, by reason, and what that costs an install that copies the
 * skill directory only. Exported so `src/commands/update.ts` can print the
 * same block when a skill's plugin facts change at the new commit.
 *
 * Pure: the caller decides whether anything here is worth printing at all
 * (`factsWarnOnInstall`) — this only renders the lines once that is decided.
 */
export function renderPluginFacts(facts: SkillPluginFacts): string[] {
  const lines: string[] = [
    `  ! this skill uses parts of the ${safe(facts.plugin.name)} plugin that are not installed:`,
  ];
  // The column width is the widest label *present in this block*, plus a
  // two-space gutter — not the widest of all four possible labels. Basing it
  // on every possible label would give "outside links" (already the widest)
  // zero gutter of its own whenever it is the longest one shown.
  const labelWidth =
    Math.max(
      ...facts.usesPluginParts.map((use) => USE_PART_LABELS[use.reason].length),
    ) + 2;
  for (const use of facts.usesPluginParts) {
    const refs = use.refs.map(safe).join(", ");
    const suffix =
      use.reason === "plugin-root"
        ? ` ${use.refs.length === 1 ? "reads" : "read"} ${PLUGIN_ROOT_VARIABLE}`
        : "";
    lines.push(
      `      ${USE_PART_LABELS[use.reason].padEnd(labelWidth)}${refs}${suffix}`,
    );
  }
  lines.push(
    `    ${facts.filesOutsideSkill} ${plural(facts.filesOutsideSkill, "file")} outside the skill directory ${facts.filesOutsideSkill === 1 ? "is" : "are"} not copied.`,
  );
  lines.push("    The skill can fail or run with less than it expects.");
  if (!facts.factsComplete) {
    const unread = facts.unread.length;
    lines.push(
      `    ${unread} ${plural(unread, "file")} ${unread === 1 ? "was" : "were"} not checked, so this list can be incomplete.`,
    );
  }
  return lines;
}

/**
 * Join parts as English prose: one part alone, two joined by "and", three
 * or more comma-separated with a final "and".
 */
function englishJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * `summaryLength` is the line count up to and including the `elsewhere`
 * line, or the last header line present when there is no `elsewhere` line,
 * plus the one blank line printed after it. A caller can slice `lines` at
 * this index to print the D9 "ask before a long list" summary before
 * asking whether to show the rest.
 */
export interface CandidateListRender {
  lines: string[];
  summaryLength: number;
}

/**
 * The `--list` text output, as plain lines, with no console calls — exported
 * so the D9 summary and the picker's plugin detail can reuse these lines.
 */
export function renderCandidateList(input: {
  url: string;
  upstream: string;
  ref: string;
  commit: string;
  discovery: RemoteDiscovery;
  scope: "repository" | { plugin: DiscoveredPlugin };
}): CandidateListRender {
  const lines: string[] = [
    `  repo      ${safe(input.upstream)}`,
    `  ref       ${safe(input.ref)}`,
    `  commit    ${input.commit}`,
  ];
  if (input.scope === "repository") {
    return renderRepositoryList(lines, input.url, input.discovery);
  }
  return renderPluginList(
    lines,
    input.url,
    input.discovery,
    input.scope.plugin,
  );
}

/** The `found 0 skills` early return, and the layout-only format unchanged
 * by byte, for a repository with no plugin at all. */
function renderRepositoryList(
  lines: string[],
  url: string,
  discovery: RemoteDiscovery,
): CandidateListRender {
  const candidates = discovery.candidates;
  const elsewhere = elsewhereLine(discovery);
  if (discovery.plugins.length === 0) {
    lines.push(
      `  found     ${candidates.length} ${plural(candidates.length, "skill")}`,
    );
    // D3: a catalog can name only sources outside this repository. A
    // capshelf shelf names none, so its listing stays as it was (D2).
    if (elsewhere !== null) lines.push(elsewhere);
    if (candidates.length === 0) return { lines, summaryLength: lines.length };
    lines.push("");
    const width = Math.max(...candidates.map((c) => c.subpath.length));
    for (const candidate of candidates) {
      lines.push(
        `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
    lines.push(
      `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", candidates[0]!.subpath]))}`,
    );
    lines.push(
      `  install some:  ${safe(shellCommand([PRODUCT_NAME, "add", url]))}`,
    );
    return { lines, summaryLength: lines.length };
  }

  // The plugin count and the catalogs beside it name only plugins that hold
  // a skill. A commands-only plugin gets the `no skills` line instead.
  const skillPlugins = discovery.plugins.filter(hasSkills);
  const catalogsUsed = new Set<PluginCatalog>();
  for (const plugin of skillPlugins) {
    for (const catalog of plugin.catalogs) catalogsUsed.add(catalog);
  }
  const catalogPaths = [
    ...(catalogsUsed.has("claude") ? [CLAUDE_CATALOG_PATH] : []),
    ...(catalogsUsed.has("codex") ? [CODEX_CATALOG_PATH] : []),
  ];
  const usingCount = candidates.filter(
    (c) => c.plugin !== undefined && c.plugin.usesPluginParts.length > 0,
  ).length;

  const inPlugins =
    skillPlugins.length === 0
      ? ""
      : ` in ${skillPlugins.length} ${plural(skillPlugins.length, "plugin")}` +
        (catalogPaths.length > 0 ? `  (${catalogPaths.join(", ")})` : "");
  lines.push(
    `  found     ${candidates.length} ${plural(candidates.length, "skill")}${inPlugins}`,
  );
  if (usingCount > 0) {
    lines.push(
      `            ${usingCount} ${usingCount === 1 ? "uses" : "use"} plugin parts outside the skill directory`,
    );
  }
  const noSkillPlugins = discovery.plugins.filter((p) => !hasSkills(p));
  if (noSkillPlugins.length > 0) {
    const dirs = noSkillPlugins.map((p) => safe(p.source)).join(", ");
    // Each part in the order its first no-skill plugin ships it, not
    // `PLUGIN_PARTS`'s own order: "plugins/insecure-defaults,
    // plugins/git-cleanup  (commands and workflows only)" names `commands`
    // first because `insecure-defaults` (listed first) ships it, even
    // though `PLUGIN_PARTS` puts `workflows` ahead of `commands`.
    const ships: PluginPart[] = [];
    for (const plugin of noSkillPlugins) {
      for (const part of plugin.ships) {
        if (!ships.includes(part)) ships.push(part);
      }
    }
    const shipsSuffix =
      ships.length > 0 ? `  (${englishJoin(ships)} only)` : "";
    lines.push(`  no skills  ${dirs}${shipsSuffix}`);
  }
  if (elsewhere !== null) lines.push(elsewhere);
  lines.push("");
  if (candidates.length === 0) {
    lines.push(WHOLE_PLUGIN_LINE, CODEX_SKILLS_ONLY_LINE);
    return { lines, summaryLength: lines.length };
  }
  const summaryLength = lines.length;

  const layout = candidates.filter((c) => c.plugin === undefined);
  const renderOrder: RemoteSkillCandidate[] = [...layout];
  if (layout.length > 0) {
    const width = Math.max(...layout.map((c) => c.subpath.length));
    for (const candidate of layout) {
      lines.push(
        `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
  }

  const pluginRows = candidates.filter((c) => c.plugin !== undefined);
  const nameWidth =
    pluginRows.length > 0
      ? Math.max(...pluginRows.map((c) => lastSegment(c.subpath).length))
      : 0;
  const usesWidth =
    pluginRows.length > 0
      ? Math.max(...pluginRows.map((c) => usesLabel(c.plugin).length))
      : 0;
  for (const plugin of discovery.plugins) {
    const rows = pluginRows.filter(
      (c) => c.plugin!.plugin.source === plugin.source,
    );
    if (rows.length === 0) continue;
    const shipsSuffix =
      plugin.ships.length > 0
        ? `   also ships: ${plugin.ships.join(", ")}`
        : "";
    lines.push(`  ${safe(plugin.source)}${shipsSuffix}`);
    for (const candidate of rows) {
      renderOrder.push(candidate);
      lines.push(
        `    ${safe(lastSegment(candidate.subpath)).padEnd(nameWidth)}   ${usesLabel(candidate.plugin).padEnd(usesWidth)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
  }

  if (usingCount > 0) {
    lines.push(
      `  ${usingCount} ${plural(usingCount, "skill")} ${usingCount === 1 ? "uses" : "use"} plugin parts that live outside the skill directory.`,
    );
    lines.push(
      "  --path copies the skill directory only. Those parts are not installed.",
    );
    lines.push("");
  }

  const firstSubpath = firstSubpathWithNoFacts(renderOrder).subpath;
  lines.push(
    `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", firstSubpath]))}`,
  );
  lines.push(
    `  install some:  ${safe(shellCommand([PRODUCT_NAME, "add", url]))}`,
  );
  lines.push(
    `  details:       ${safe(shellCommand([PRODUCT_NAME, "add", url, "--list", "--json"]))}`,
  );
  lines.push(WHOLE_PLUGIN_LINE, CODEX_SKILLS_ONLY_LINE);
  return { lines, summaryLength };
}

/**
 * Plugin D5: one footer line when the listing holds a plugin. The listing
 * does not read each plugin's manifest, so the line names the command shape,
 * not one plugin.
 */
const WHOLE_PLUGIN_LINE = `  install a whole plugin:  ${PRODUCT_NAME} add <url> --path plugins/<plugin>`;

/**
 * Plugin D13: capshelf writes nothing for Codex, so a listing that offers a
 * whole plugin says what Codex reads from it. Printed under the footer line.
 */
const CODEX_SKILLS_ONLY_LINE = "  Codex sees the skills only.";

/**
 * Whether a plugin holds a skill. Every plugin count in the listing uses this
 * one test: the `found` line, the `no skills` line, and the D9 question.
 */
export function hasSkills(plugin: DiscoveredPlugin): boolean {
  return plugin.skillDirs.length > 0;
}

/** D3: one line that names every catalog entry whose source is outside this
 * repository, or null when there is none. */
function elsewhereLine(discovery: RemoteDiscovery): string | null {
  const elsewhere = discovery.skipped.filter(
    (s) => s.reason === "external-source",
  );
  if (elsewhere.length === 0) return null;
  return `  elsewhere  ${elsewhere.map((s) => safe(s.name)).join(", ")}  (sources outside this repository, not read)`;
}

/** D10: `--list --path <plugin dir>` lists one plugin's skills. */
function renderPluginList(
  lines: string[],
  url: string,
  discovery: RemoteDiscovery,
  plugin: DiscoveredPlugin,
): CandidateListRender {
  const candidates = discovery.candidates;
  const shipsSuffix =
    plugin.ships.length > 0 ? `   also ships: ${plugin.ships.join(", ")}` : "";
  lines.push(
    `  found     ${candidates.length} ${plural(candidates.length, "skill")} in ${safe(plugin.source)}${shipsSuffix}`,
  );
  lines.push("");
  const wholePluginLine = `  install a whole plugin:  ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", plugin.source]))}`;
  if (candidates.length === 0) {
    lines.push(wholePluginLine, CODEX_SKILLS_ONLY_LINE);
    return { lines, summaryLength: lines.length };
  }
  const summaryLength = lines.length;

  const nameWidth = Math.max(
    ...candidates.map((c) => lastSegment(c.subpath).length),
  );
  const usesWidth = Math.max(
    ...candidates.map((c) => usesLabel(c.plugin).length),
  );
  for (const candidate of candidates) {
    lines.push(
      `    ${safe(lastSegment(candidate.subpath)).padEnd(nameWidth)}   ${usesLabel(candidate.plugin).padEnd(usesWidth)}   ${safe(candidate.description ?? "")}`.trimEnd(),
    );
  }
  lines.push("");
  const firstSubpath = firstSubpathWithNoFacts(candidates).subpath;
  lines.push(
    `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", firstSubpath]))}`,
  );
  lines.push(wholePluginLine, CODEX_SKILLS_ONLY_LINE);
  return { lines, summaryLength };
}

/**
 * The first plugin skill in listing order with no `usesPluginParts` and
 * complete facts, for the "install one" example. Falls back to the first
 * candidate in that order when none qualifies — which may itself be a
 * layout skill with no plugin facts at all.
 */
function firstSubpathWithNoFacts(
  renderOrder: readonly RemoteSkillCandidate[],
): RemoteSkillCandidate {
  const noFacts = renderOrder.find(
    (c) =>
      c.plugin !== undefined &&
      c.plugin.usesPluginParts.length === 0 &&
      c.plugin.factsComplete,
  );
  // `renderOrder` is only ever built from a non-empty candidate list by both
  // callers, so the fallback always finds one.
  return noFacts ?? renderOrder[0]!;
}
