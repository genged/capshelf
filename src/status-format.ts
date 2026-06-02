import { homeRelative } from "./paths";
import { formatRuntimeWarnings } from "./runtime-warnings";
import type { ExternalClaudePlugin, ExternalSkill } from "./external";
import type {
  ExternalPersonalClaudeSkill,
  State,
  StatusRow,
} from "./status-core";

export function glyph(s: State): string {
  switch (s) {
    case "ok":
      return "✓";
    case "update_available":
      return "⚠";
    case "drifted_local":
      return "✎";
    case "drifted_and_update":
      return "✎⚠";
    case "missing_installed":
      return "?";
    case "missing_output":
      return "?";
    case "missing_upstream":
      return "!";
    case "upstream_dirty":
      return "!";
    case "source_dirty":
      return "!";
    case "drifted_and_upstream_dirty":
      return "✎!";
    case "output_drift":
      return "✎";
    case "source_dirty_and_output_drift":
      return "✎!";
    case "kept-local":
      return "≠";
  }
}

export function describe(r: StatusRow): string {
  switch (r.state) {
    case "ok":
      return "up-to-date";
    case "update_available":
      return r.source === "system"
        ? `update available → ${r.upstreamSha} (cli upgraded)`
        : `update available → ${r.upstreamSha}`;
    case "drifted_local":
      return `drifted (current ${r.currentSha})`;
    case "drifted_and_update":
      return `drifted + update available → ${r.upstreamSha}`;
    case "missing_installed":
      return "installed files missing — run: capshelf apply";
    case "missing_output":
      return "generated output missing — run: capshelf apply";
    case "missing_upstream":
      return r.source === "data"
        ? "no longer in data repo"
        : "no longer bundled in CLI";
    case "upstream_dirty":
      return "data repo has uncommitted changes for this item";
    case "source_dirty":
      return "data repo has uncommitted changes for this fragment";
    case "drifted_and_upstream_dirty":
      return "drifted + data repo has uncommitted changes for this item";
    case "output_drift":
      return "generated output drifted — run: capshelf apply";
    case "source_dirty_and_output_drift":
      return "generated output drifted + data repo has uncommitted fragment changes";
    case "kept-local":
      return r.localReason ? `kept local (${r.localReason})` : "kept local";
  }
}

export interface FormatStatusHumanInput {
  project: string;
  dataRepo: string | null;
  rows: StatusRow[];
  external: ExternalSkill[];
  externalClaudePlugins: ExternalClaudePlugin[];
  personalClaudeExternal: ExternalPersonalClaudeSkill[];
}

/**
 * Render the human-readable status report as a list of lines. Returning lines
 * (rather than calling console.log) keeps this pure and unit-testable; the
 * command shell joins them with "\n" and prints once, which reproduces the
 * original per-line console.log output exactly.
 */
export function formatStatusHuman(input: FormatStatusHumanInput): string[] {
  const {
    project,
    dataRepo,
    rows,
    external,
    externalClaudePlugins,
    personalClaudeExternal,
  } = input;
  if (
    rows.length === 0 &&
    external.length === 0 &&
    externalClaudePlugins.length === 0 &&
    personalClaudeExternal.length === 0
  ) {
    return ["(no items tracked)"];
  }
  const lines: string[] = [];
  lines.push(
    `${project}  (${rows.length} item${rows.length === 1 ? "" : "s"})`,
  );
  lines.push("");

  const projectRows = rows.filter((r) => r.scope === "project");
  const localRows = rows.filter((r) => r.scope === "local");

  if (projectRows.length > 0) {
    lines.push("project/");
    for (const r of projectRows) lines.push(...formatRow(r));
  }
  if (projectRows.length > 0 && localRows.length > 0) lines.push("");
  if (localRows.length > 0) {
    const repoLabel = dataRepo
      ? `from ${homeRelative(dataRepo)}`
      : "no data repo configured — pass --data, set $CAPSHELF_HOME, or run init";
    lines.push(`local/  (${repoLabel})`);
    for (const r of localRows) lines.push(...formatRow(r));
  }
  if (external.length > 0) {
    if (rows.length > 0) lines.push("");
    lines.push("external/  (managed by skills.sh)");
    for (const skill of external) {
      const id = `skills/${skill.name}`.padEnd(34);
      lines.push(`  •   ${id} ${skill.source}`);
    }
  }
  if (externalClaudePlugins.length > 0) {
    if (rows.length > 0 || external.length > 0) {
      lines.push("");
    }
    lines.push("external/  (Claude plugins)");
    for (const plugin of externalClaudePlugins) {
      const id = `plugins/${plugin.id}`.padEnd(34);
      const status = plugin.enabled ? "enabled" : "disabled";
      lines.push(
        `  •   ${id} ${status} ${plugin.scope} ${homeRelative(plugin.settingsPath)}`,
      );
    }
  }
  if (personalClaudeExternal.length > 0) {
    if (
      rows.length > 0 ||
      external.length > 0 ||
      externalClaudePlugins.length > 0
    ) {
      lines.push("");
    }
    lines.push("external/  (Personal Claude)");
    for (const skill of personalClaudeExternal) {
      const id = `skills/${skill.name}`.padEnd(34);
      lines.push(`  ⚠   ${id} ${homeRelative(skill.path)}`);
      lines.push(`      ${skill.warning.message}`);
    }
  }
  return lines;
}

function formatRow(r: StatusRow): string[] {
  const g = glyph(r.state).padEnd(3);
  const id = `${r.source}/${r.kind}/${r.name}`.padEnd(39);
  const label = r.label ? ` ${r.label}` : "";
  return [
    `  ${g} ${id} ${r.lockedSha}${label}  ${describe(r)}`,
    ...formatRuntimeWarnings(r.runtimeWarnings, "    "),
  ];
}
