/**
 * Every repository-controlled string goes through `safe`, because this text is
 * the only gate before third-party code runs with the user's permissions.
 */
import { confirmationContext } from "./destructive-change";
import { PreconditionError } from "./errors";
import { PRODUCT_NAME } from "./identity";
import { runsHaveEntries, serverCommandLine } from "./plugin-runs";
import type { PluginRunHook, PluginRuns, PluginRunServer } from "./plugin-runs";
import { formatBytes, plural, safe } from "./remote-list-render";

export interface PluginConsentFile {
  path: string;
  bytes: number;
}

export interface PluginConsentInput {
  repo: string;
  ref: string;
  commit: string;
  path: string;
  name: string;
  version: string | null;
  install: string;
  files: readonly PluginConsentFile[];
  runs: PluginRuns;
  license: string;
  description: string | null;
}

const HOOKS_WARNING =
  "These hooks run in every Claude Code session in this project.";

const MAX_NAMES_SHOWN = 20;

const CONTINUATION = "            ";

/**
 * `width` is passed in rather than read from `process` so layout is testable at
 * a chosen width.
 */
export function renderPluginConsent(
  input: PluginConsentInput,
  width: number,
): string[] {
  const version = input.version === null ? "" : ` ${safe(input.version)}`;
  const totalBytes = input.files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    `  repo      ${safe(input.repo)}`,
    `  ref       ${safe(input.ref)}`,
    `  commit    ${safe(input.commit)}`,
    `  path      ${safe(input.path)}`,
    `  plugin    ${safe(input.name)}${version}`,
    `  install   ${safe(input.install)}`,
    `  files     ${input.files.length} ${plural(input.files.length, "file")}, ${formatBytes(totalBytes)}`,
    ...fileGroupLines(input.files),
    ...namedGroupBlocks(input.name, input.files, width),
    ...pluginRunsField(input.runs),
    // capshelf writes nothing for Codex, so the prompt must not claim Codex
    // runs the agents or hooks.
    "  codex     sees the skills only",
    `  license   ${safe(input.license)}`,
    "",
    ...(input.description === null
      ? []
      : [...wrapDescription(input.description, width), ""]),
    "  capshelf does not review this content. Your agent runs it with your permissions.",
  ];
}

export function pluginRunsLines(runs: PluginRuns): string[] {
  const { hooks, mcpServers, unknown } = runs;
  if (hooks.length === 0 && mcpServers.length === 0 && unknown.length === 0) {
    return ["no hooks, no MCP servers"];
  }
  const counts = [
    ...(hooks.length > 0
      ? [`${hooks.length} ${plural(hooks.length, "hook")}`]
      : []),
    ...(mcpServers.length > 0
      ? [`${mcpServers.length} MCP ${plural(mcpServers.length, "server")}`]
      : []),
  ];
  const lines = [
    counts.length > 0
      ? `${counts.join(", ")}, with no request from the agent`
      : "no hooks or MCP servers that capshelf could list",
    ...columns(hooks.map(hookCells)),
    ...columns(mcpServers.map(serverCells)),
    ...unknown.map((entry) => `  unknown: ${safe(entry)}`),
  ];
  if (hooks.length > 0) lines.push(HOOKS_WARNING);
  return lines;
}

export function pluginRunsField(runs: PluginRuns): string[] {
  return labelledLines("runs", pluginRunsLines(runs));
}

export function newPluginRunsField(label: string, runs: PluginRuns): string[] {
  const [first = "", ...rest] = pluginRunsLines(runs);
  const counted = runs.hooks.length > 0 || runs.mcpServers.length > 0;
  return labelledLines(label, [counted ? `+ ${first}` : first, ...rest]);
}

function labelledLines(label: string, lines: readonly string[]): string[] {
  const [first = "", ...rest] = lines;
  return [
    `  ${label.padEnd(CONTINUATION.length - 3)} ${first}`,
    ...rest.map((line) => `${CONTINUATION}${line}`),
  ];
}

export function pluginConsentReason(runs: PluginRuns): string {
  const parts = [
    ...(runs.hooks.length > 0
      ? [`runs ${runs.hooks.length} ${plural(runs.hooks.length, "hook")}`]
      : []),
    ...(runs.mcpServers.length > 0
      ? [
          `starts ${runs.mcpServers.length} MCP ${plural(runs.mcpServers.length, "server")}`,
        ]
      : []),
  ];
  if (parts.length > 0) {
    return `it ${parts.join(" and ")} in every Claude Code session in this project`;
  }
  if (runs.unknown.length > 0) {
    return "capshelf cannot list everything it runs";
  }
  return "capshelf does not review this content, and your agent runs it with your permissions";
}

export interface PluginConsentPoint {
  kind: "install" | "pin-move" | "project-scope";
  ref: string;
  runs: PluginRuns;
}

export interface PluginConsentOptions {
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  advice?: string;
}

/**
 * A non-empty `unknown` list needs consent like a hook or server does, because
 * a declaration the reader could not read is not proof the plugin runs nothing.
 */
export async function confirmPluginConsent(
  points: readonly PluginConsentPoint[],
  opts: PluginConsentOptions,
): Promise<boolean> {
  const asking = points.filter((point) => runsHaveEntries(point.runs));
  const [first] = asking;
  if (first === undefined || opts.dryRun === true) return true;
  const lines = consentLines(asking);
  if (opts.yes === true) {
    // With `--yes` the authorization goes to stderr, where `--json` output
    // cannot see it.
    for (const line of lines) console.error(line);
    return true;
  }
  const words = consentWords(first, asking);
  const context = confirmationContext();
  if (opts.json === true || !context.stdinIsTTY || !context.stderrIsTTY) {
    const refs = [...new Set(asking.map((point) => point.ref))];
    const shows = refs
      .map((ref) => `${PRODUCT_NAME} show ${safe(ref)}`)
      .join(", ");
    throw new PreconditionError(
      `not ${words.verb} ${refs.map(safe).join(", ")}${words.target} without consent — ${words.reason}`,
      {
        // The error boundary indents the first hint line itself.
        hint: [
          ...lines,
          `  ${opts.advice ?? "review it first, then authorize with --yes"}. See what it runs: ${shows}`,
        ]
          .join("\n")
          .replace(/^ {2}/, ""),
      },
    );
  }
  const answer = await context.prompt(
    `${lines.join("\n")}\n${words.question} [y/N] `,
  );
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  context.stderr.write(`${words.cancelled}\n`);
  return false;
}

function consentLines(points: readonly PluginConsentPoint[]): string[] {
  const listed = new Set(
    points
      .filter((point) => point.kind !== "project-scope")
      .map((point) => point.ref),
  );
  const lines = points.flatMap((point) => pointLines(point, listed));
  return points.some((point) => point.kind !== "project-scope")
    ? [
        ...lines,
        "",
        "  capshelf does not review this content. Your agent runs it with your permissions.",
      ]
    : lines;
}

function pointLines(
  point: PluginConsentPoint,
  listed: ReadonlySet<string>,
): string[] {
  if (point.kind === "project-scope") {
    return [
      ...(listed.has(point.ref)
        ? []
        : [`  ${safe(point.ref)} ${runsSummary(point.runs)}.`]),
      ...teammateLines(point.runs),
    ];
  }
  return [
    `  plugin    ${safe(point.ref)}`,
    ...(point.kind === "install"
      ? pluginRunsField(point.runs)
      : newPluginRunsField("runs", point.runs)),
  ];
}

function teammateLines(runs: PluginRuns): string[] {
  const subject =
    runs.hooks.length > 0 && runs.mcpServers.length > 0
      ? "The hooks and MCP servers"
      : runs.hooks.length > 0
        ? "The hooks"
        : runs.mcpServers.length > 0
          ? "The MCP servers"
          : "Its commands";
  return [
    `  project scope commits it. ${subject} then run in every teammate's`,
    "  Claude Code session after they trust this workspace.",
  ];
}

function runsCounts(runs: PluginRuns): string | null {
  const parts = [
    ...(runs.hooks.length > 0
      ? [`${runs.hooks.length} ${plural(runs.hooks.length, "hook")}`]
      : []),
    ...(runs.mcpServers.length > 0
      ? [
          `${runs.mcpServers.length} MCP ${plural(runs.mcpServers.length, "server")}`,
        ]
      : []),
  ];
  return parts.length > 0 ? parts.join(" and ") : null;
}

function runsSummary(runs: PluginRuns): string {
  const counts = runsCounts(runs);
  return counts === null
    ? "runs commands that capshelf cannot list"
    : `runs ${counts}`;
}

interface ConsentWords {
  verb: string;
  target: string;
  reason: string;
  question: string;
  cancelled: string;
}

function consentWords(
  first: PluginConsentPoint,
  points: readonly PluginConsentPoint[],
): ConsentWords {
  const pinMove = points.find((point) => point.kind === "pin-move");
  if (pinMove !== undefined) {
    const counts = runsCounts(pinMove.runs);
    return {
      verb: "updating",
      target: "",
      reason:
        counts === null
          ? "capshelf cannot list everything the new tree runs"
          : `the new tree adds ${counts}`,
      question: "Move the pin?",
      cancelled: "Update cancelled; no changes were written.",
    };
  }
  const install = points.find((point) => point.kind === "install");
  if (install !== undefined) {
    return {
      verb: "installing",
      target: "",
      reason: pluginConsentReason(install.runs),
      question: "Install it?",
      cancelled: "Add cancelled; nothing was installed.",
    };
  }
  return {
    verb: "moving",
    target: " to project scope",
    reason: `project scope commits it, and it ${runsSummary(first.runs)} in every teammate's Claude Code session after they trust this workspace`,
    question: "Commit it to the project?",
    cancelled: "Move cancelled; no changes were written.",
  };
}

function hookCells(hook: PluginRunHook): string[] {
  return [
    hook.event,
    hook.command ?? `(${hook.type} hook)`,
    ...(hook.matcher === null ? [] : [hook.matcher]),
  ];
}

function serverCells(server: PluginRunServer): string[] {
  return [
    server.name,
    serverCommandLine(server) ?? server.url ?? "(no command)",
  ];
}

function columns(rows: readonly string[][]): string[] {
  const cleaned = rows.map((row) => row.map(safe));
  const widths: number[] = [];
  for (const row of cleaned) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return cleaned.map((row) =>
    `  ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("   ")}`.trimEnd(),
  );
}

interface FileGroupRow {
  label: string;
  count: number;
  bytes: number;
}

function fileGroupLines(files: readonly PluginConsentFile[]): string[] {
  const groups = new Map<string, PluginConsentFile[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const key = slash === -1 ? "./" : `${file.path.slice(0, slash)}/`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [file]);
    else group.push(file);
  }
  const rows: FileGroupRow[] = [...groups.entries()]
    .map(([key, groupFiles]) => ({
      rank: groupRank(key),
      label:
        key === "./"
          ? groupFiles.length === 1
            ? safe(groupFiles[0]!.path)
            : "(plugin root)"
          : safe(key),
      count: groupFiles.length,
      bytes: groupFiles.reduce((sum, file) => sum + file.bytes, 0),
    }))
    .sort((a, b) => a.rank - b.rank || compare(a.label, b.label));
  return formatFileGroupRows(rows).map((line) => `${CONTINUATION}${line}`);
}

function groupRank(label: string): number {
  if (label === "skills/") return 0;
  if (label === "agents/") return 1;
  if (label === "./") return 3;
  return 2;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatFileGroupRows(rows: readonly FileGroupRow[]): string[] {
  if (rows.length === 0) return [];
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const digitWidth = Math.max(...rows.map((row) => String(row.count).length));
  const counts = rows.map(
    (row) =>
      `${String(row.count).padStart(digitWidth)} ${plural(row.count, "file")}`,
  );
  const countWidth = Math.max(...counts.map((count) => count.length));
  const sizes = rows.map((row) => formatBytes(row.bytes));
  const sizeWidth = Math.max(...sizes.map((size) => size.length));
  return rows.map((row, index) =>
    `  ${row.label.padEnd(labelWidth)}  ${counts[index]!.padEnd(countWidth)}  ${sizes[index]!.padStart(sizeWidth)}`.trimEnd(),
  );
}

const NAMED_GROUPS: ReadonlyMap<string, { noun: string; pattern: RegExp }> =
  new Map([
    ["skills/", { noun: "skill", pattern: /^skills\/([^/]+)\/SKILL\.md$/ }],
    ["agents/", { noun: "agent", pattern: /^agents\/([^/]+)\.md$/ }],
  ]);

function namedGroupBlocks(
  pluginName: string,
  files: readonly PluginConsentFile[],
  width: number,
): string[] {
  const lines: string[] = [];
  for (const { noun, pattern } of NAMED_GROUPS.values()) {
    const names = files.flatMap((file) => {
      const match = pattern.exec(file.path);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    if (names.length === 0) continue;
    lines.push(...namedGroupBlock(noun, names, pluginName, width));
  }
  return lines;
}

const NAME_ROW_GUTTER = "  ";

/**
 * Names are sanitized before sorting and counting, because distinct control
 * characters collapse to the same space and a raw sort could order differently
 * than what is shown.
 */
function namedGroupBlock(
  noun: string,
  names: readonly string[],
  pluginName: string,
  width: number,
): string[] {
  const sorted = names.map(safe).sort();
  const shown = sorted.slice(0, MAX_NAMES_SHOWN);
  const more = sorted.length - shown.length;
  const heading = `${sorted.length}, called as ${safe(pluginName)}:<${noun}>`;
  return labelledLines(`${noun}s`, [
    heading,
    ...nameColumns(shown, width).map((row) => `${NAME_ROW_GUTTER}${row}`),
    ...(more > 0 ? [`${NAME_ROW_GUTTER}… and ${more} more`] : []),
  ]);
}

function nameColumns(shown: readonly string[], width: number): string[] {
  if (shown.length === 0) return [];
  const available = Math.max(
    width - CONTINUATION.length - NAME_ROW_GUTTER.length,
    1,
  );
  const nameWidth = Math.max(...shown.map((name) => name.length));
  const perColumn = nameWidth + 2;
  const perRow = Math.max(1, Math.floor((available + 2) / perColumn));
  const rows: string[] = [];
  for (let index = 0; index < shown.length; index += perRow) {
    rows.push(
      shown
        .slice(index, index + perRow)
        .map((name) => name.padEnd(nameWidth))
        .join("  ")
        .trimEnd(),
    );
  }
  return rows;
}

function wrapWords(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > width && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/**
 * Paragraphs are split before sanitizing, because `safe` turns every control
 * character, including a bare `\n`, into a space and would erase the breaks.
 */
function wrapDescription(description: string, width: number): string[] {
  const innerWidth = Math.max(width - 2, 1);
  const paragraphs = description
    .split(/\n\s*\n/)
    .map((paragraph) => safe(paragraph.replace(/\s+/g, " ").trim()))
    .filter((paragraph) => paragraph.length > 0);
  const blocks = paragraphs.map((paragraph) =>
    wrapWords(paragraph, innerWidth).map((line) => `  ${line}`),
  );
  return blocks.flatMap((block, index) =>
    index === 0 ? block : ["", ...block],
  );
}
