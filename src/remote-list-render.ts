/**
 * Lives outside `add-remote.ts` so `update.ts` can print the same facts block
 * without importing another command module.
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
import { pickerOffer } from "./remote-discovery";
import type {
  PickerOffer,
  RemoteDiscovery,
  RemoteSkillCandidate,
} from "./remote-discovery";
import { shellCommand } from "./shell-quote";

export function factsWarnOnInstall(
  facts: SkillPluginFacts | undefined,
): boolean {
  return (
    facts !== undefined &&
    (facts.usesPluginParts.length > 0 || !facts.factsComplete)
  );
}

/**
 * Repository-controlled text is sanitized because the consent prompt gates
 * third-party code, and ESC/OSC bytes in paths or descriptions could redraw it
 * or drive the terminal.
 */
export function safe(text: string): string {
  return sanitizeDisplayText(text);
}

export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

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

const PLUGIN_ROOT_VARIABLE = `\${CLAUDE_PLUGIN_ROOT}`;

export function renderPluginFacts(facts: SkillPluginFacts): string[] {
  const lines: string[] = [
    `  ! this skill uses parts of the ${safe(facts.plugin.name)} plugin that are not installed:`,
  ];
  // Width is based on the labels present, not all four, so the widest shown
  // label always keeps its own gutter.
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

export function unitCount(offer: PickerOffer): string {
  const skills = `${offer.skills.length} ${plural(offer.skills.length, "skill")}`;
  if (offer.plugins.length === 0) return skills;
  const plugins = `${offer.plugins.length} ${plural(offer.plugins.length, "plugin")}`;
  return offer.skills.length === 0 ? plugins : `${plugins} and ${skills}`;
}

/**
 * Hooks are read only at consent on the pinned tree, so this row names `hooks/`
 * without a count.
 */
export function pluginPickDetail(
  plugin: DiscoveredPlugin,
  agents: number,
): string {
  const skills = plugin.skillDirs.length;
  const counts = `plugin: ${skills} ${plural(skills, "skill")}, ${agents} ${plural(agents, "agent")}`;
  const others = plugin.ships.filter((part) => part !== "agents");
  return others.length === 0
    ? counts
    : `${counts} · also ships: ${others.join(", ")}`;
}

function englishJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export interface CandidateListRender {
  lines: string[];
  summaryLength: number;
}

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

  const offer = pickerOffer(discovery);
  const whole = new Map(
    offer.plugins.map((offered) => [offered.plugin.source, offered.whole]),
  );
  const skillPlugins = discovery.plugins.filter(hasSkills);
  const catalogsUsed = new Set<PluginCatalog>();
  for (const plugin of discovery.plugins) {
    if (!hasSkills(plugin) && !whole.has(plugin.source)) continue;
    for (const catalog of plugin.catalogs) catalogsUsed.add(catalog);
  }
  const catalogPaths = [
    ...(catalogsUsed.has("claude") ? [CLAUDE_CATALOG_PATH] : []),
    ...(catalogsUsed.has("codex") ? [CODEX_CATALOG_PATH] : []),
  ];
  const usingCount = candidates.filter(
    (c) => c.plugin !== undefined && c.plugin.usesPluginParts.length > 0,
  ).length;

  const catalogSuffix =
    catalogPaths.length > 0 ? `  (${catalogPaths.join(", ")})` : "";
  if (whole.size > 0) {
    lines.push(`  found     ${unitCount(offer)}${catalogSuffix}`);
  } else {
    const inPlugins =
      skillPlugins.length === 0
        ? ""
        : ` in ${skillPlugins.length} ${plural(skillPlugins.length, "plugin")}${catalogSuffix}`;
    lines.push(
      `  found     ${candidates.length} ${plural(candidates.length, "skill")}${inPlugins}`,
    );
  }
  if (usingCount > 0) {
    lines.push(
      `            ${usingCount} ${usingCount === 1 ? "uses" : "use"} plugin parts outside the skill directory`,
    );
  }
  const noSkillPlugins = discovery.plugins.filter(
    (p) => !hasSkills(p) && !whole.has(p.source),
  );
  if (noSkillPlugins.length > 0) {
    const dirs = noSkillPlugins.map((p) => safe(p.source)).join(", ");
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
  const firstWhole = offer.plugins[0]?.plugin;
  const footer = [
    ...(firstWhole === undefined ? [] : [wholePluginLine(url, firstWhole)]),
    CODEX_SKILLS_ONLY_LINE,
  ];
  if (candidates.length === 0 && whole.size === 0) {
    lines.push(...footer);
    return { lines, summaryLength: lines.length };
  }
  const summaryLength = lines.length;

  const renderOrder: RemoteSkillCandidate[] = [];
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
    if (rows.length === 0 && !whole.has(plugin.source)) continue;
    const shipsSuffix =
      plugin.ships.length > 0
        ? `   also ships: ${plugin.ships.join(", ")}`
        : "";
    const offered = whole.get(plugin.source);
    const wholeLabel =
      offered === undefined
        ? ""
        : `   plugin ${safe(plugin.name)}${offered.description === null ? "" : `: ${safe(offered.description)}`}`;
    lines.push(`  ${safe(plugin.source)}${wholeLabel}${shipsSuffix}`);
    for (const candidate of rows) {
      renderOrder.push(candidate);
      lines.push(
        `    ${safe(lastSegment(candidate.subpath)).padEnd(nameWidth)}   ${usesLabel(candidate.plugin).padEnd(usesWidth)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
  }

  const layout = candidates.filter((c) => c.plugin === undefined);
  if (layout.length > 0) {
    const width = Math.max(...layout.map((c) => c.subpath.length));
    for (const candidate of layout) {
      renderOrder.push(candidate);
      lines.push(
        `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
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

  if (renderOrder.length > 0) {
    const firstSubpath = firstSubpathWithNoFacts(renderOrder).subpath;
    lines.push(
      `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", firstSubpath]))}`,
    );
  }
  lines.push(
    `  install some:  ${safe(shellCommand([PRODUCT_NAME, "add", url]))}`,
  );
  lines.push(
    `  details:       ${safe(shellCommand([PRODUCT_NAME, "add", url, "--list", "--json"]))}`,
  );
  lines.push(...footer);
  return { lines, summaryLength };
}

function wholePluginLine(url: string, plugin: DiscoveredPlugin): string {
  return `  install a whole plugin:  ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", plugin.source]))}`;
}

/**
 * Capshelf writes nothing for Codex, so the listing footer says Codex sees only
 * a plugin's skills.
 */
const CODEX_SKILLS_ONLY_LINE = "  Codex sees the skills only.";

export function hasSkills(plugin: DiscoveredPlugin): boolean {
  return plugin.skillDirs.length > 0;
}

function elsewhereLine(discovery: RemoteDiscovery): string | null {
  const elsewhere = discovery.skipped.filter(
    (s) => s.reason === "external-source",
  );
  if (elsewhere.length === 0) return null;
  return `  elsewhere  ${elsewhere.map((s) => safe(s.name)).join(", ")}  (sources outside this repository, not read)`;
}

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
  const footer = [
    ...((discovery.wholePlugins ?? []).length > 0
      ? [wholePluginLine(url, plugin)]
      : []),
    CODEX_SKILLS_ONLY_LINE,
  ];
  if (candidates.length === 0) {
    lines.push(...footer);
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
  lines.push(...footer);
  return { lines, summaryLength };
}

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
