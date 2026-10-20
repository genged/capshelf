/**
 * The consent text for a whole plugin (spec D6, D7, D13).
 *
 * Pure: these functions return lines and print nothing. `add <url>` prints
 * them today; the remote `update` and the shelf `add` reuse them. Every
 * repository-controlled string goes through `safe` (`sanitizeDisplayText`),
 * because this text is the one gate before third-party code runs with the
 * user's permissions.
 */
import { confirmationContext } from "./destructive-change";
import { PreconditionError } from "./errors";
import { PRODUCT_NAME } from "./identity";
import { runsHaveEntries, serverCommandLine } from "./plugin-runs";
import type { PluginRunHook, PluginRuns, PluginRunServer } from "./plugin-runs";
import { formatBytes, plural, safe } from "./remote-list-render";

export interface PluginConsentFile {
  /** Plugin-relative, POSIX-separated. */
  path: string;
  bytes: number;
}

export interface PluginConsentInput {
  repo: string;
  ref: string;
  commit: string;
  /** The plugin directory inside the repository. */
  path: string;
  /** The manifest name, which is also the item name (D3). */
  name: string;
  /** The manifest `version`, or null when it has none. */
  version: string | null;
  /** The text after the `install` label: the folder and its scope. */
  install: string;
  files: readonly PluginConsentFile[];
  runs: PluginRuns;
  /** The text after the `license` label. */
  license: string;
  description: string | null;
}

const HOOKS_WARNING =
  "These hooks run in every Claude Code session in this project.";

/** Names shown in a `skills`/`agents` block before "… and N more". */
const MAX_NAMES_SHOWN = 20;

/** The column where a multi-line field's later lines start. */
const CONTINUATION = "            ";

/**
 * The consent block, in the order D6 gives: repo, ref, commit, path,
 * plugin, install, files by top-level directory, the named-item blocks
 * (`skills`, `agents`, …), runs, codex, license, the description, and the
 * closing line. The caller adds the question.
 *
 * `width` is the column count of the terminal the block prints under (80
 * when that stream is not a terminal). It is threaded in rather than read
 * from `process` here, so the layout stays testable at a chosen width.
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
    // D13: capshelf writes nothing for Codex, so the prompt does not claim
    // that Codex runs the agents or the hooks.
    "  codex     sees the skills only",
    `  license   ${safe(input.license)}`,
    "",
    ...(input.description === null
      ? []
      : [...wrapDescription(input.description, width), ""]),
    "  capshelf does not review this content. Your agent runs it with your permissions.",
  ];
}

/**
 * What the plugin runs with no request from the agent (D6). The first line is
 * the summary; detail lines start with two spaces. With hooks, the last line
 * says where they run. Lines carry no field label, so a caller can put them
 * under `runs` or under its own label.
 */
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

/**
 * `pluginRunsLines` under the `runs` label of the consent block. A `--yes`
 * install and a consent refusal print the same lines.
 */
export function pluginRunsField(runs: PluginRuns): string[] {
  return labelledLines("runs", pluginRunsLines(runs));
}

/**
 * The runs entries a pin move adds (D7 point 2), under `label`: `runs` in
 * the update prompt, `would ask` in a dry run. The summary line starts with
 * `+` when it counts new hooks or MCP servers.
 */
export function newPluginRunsField(label: string, runs: PluginRuns): string[] {
  const [first = "", ...rest] = pluginRunsLines(runs);
  const counted = runs.hooks.length > 0 || runs.mcpServers.length > 0;
  return labelledLines(label, [counted ? `+ ${first}` : first, ...rest]);
}

/** Lines under a field label, with later lines at the value column. */
function labelledLines(label: string, lines: readonly string[]): string[] {
  const [first = "", ...rest] = lines;
  return [
    `  ${label.padEnd(CONTINUATION.length - 3)} ${first}`,
    ...rest.map((line) => `${CONTINUATION}${line}`),
  ];
}

/**
 * The reason a consent refusal gives (D7): what the plugin runs, or the
 * general warning when the reader found nothing.
 */
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

/**
 * One write that puts a plugin's commands in reach of Claude Code (D7).
 * `install` and `project-scope` carry everything the plugin runs; `pin-move`
 * carries only the entries the new tree adds.
 */
export interface PluginConsentPoint {
  kind: "install" | "pin-move" | "project-scope";
  /** `plugins/<name>`. */
  ref: string;
  runs: PluginRuns;
}

export interface PluginConsentOptions {
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  /**
   * What the refusal tells the user to do, for a write that cannot take
   * `--yes`. The default is `review it first, then authorize with --yes`.
   */
  advice?: string;
}

/**
 * Asks once for every point that has an entry (D7, M2). Returns true when
 * the write may go on: no point has an entry, `--yes` is set, the user
 * answered yes, or this is a dry run (the caller reports the points as
 * `would ask`). Returns false when the user answered no. With `--json` or no
 * terminal, and no `--yes`, it refuses with exit 3.
 *
 * A point with an empty runs set asks nothing, but a non-empty `unknown`
 * list always asks: a declaration the reader could not read is not proof
 * that the plugin runs nothing (D6).
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
    // `--yes` skips the question, so what the write authorizes goes to
    // stderr, where `--json` cannot see it. A `--yes` remote add does the
    // same.
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

/**
 * The block a consent point shows. Point 3 repeats no runs list when point 1
 * for the same plugin already shows one: one prompt, one list.
 */
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

/** D7 point 3: what project scope means for a plugin's commands (R2, R3). */
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

/** `5 hooks`, `1 hook and 1 MCP server`, or null when it counts neither. */
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

/** `runs 5 hooks`, or the unknown case. */
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

/**
 * The refusal, the question, and the cancel line, chosen by the write the
 * points belong to: an update moves a pin, an add installs, and a move
 * commits to the project.
 */
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

/** Rows of cells, sanitized, padded to aligned columns, indented two spaces. */
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

/**
 * One line per top-level directory, with a file count and a size — never
 * item names; those move to `namedGroupBlocks`. Files at the plugin root
 * form the `./` group: one file shows its own name as the label, several
 * show `(plugin root)` instead of listing them.
 */
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
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || compare(a, b))
    .map(([key, groupFiles]) => ({
      label:
        key === "./"
          ? groupFiles.length === 1
            ? safe(groupFiles[0]!.path)
            : "(plugin root)"
          : safe(key),
      count: groupFiles.length,
      bytes: groupFiles.reduce((sum, file) => sum + file.bytes, 0),
    }));
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

/**
 * The file-group table: label (left-aligned), count (the digits
 * right-aligned, the "file"/"files" word left as-is), size (the whole
 * formatted value right-aligned in one shared column — spec rule: "sizes
 * right-aligned in one column, counts aligned"). Two-space gaps throughout,
 * the same gap the `skills`/`agents` name columns use.
 */
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

/**
 * The `skills` block, and the `agents` block when the plugin has agents, in
 * that order: how Claude Code calls each item (`<plugin>:<name>`), then the
 * bare names in columns. A group with no match prints nothing, so a
 * commands-only plugin shows neither block.
 */
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

/**
 * One named-item block. Sorts and counts the raw names first (as the old
 * group row did), then sanitizes only the ones it shows — sanitizing cannot
 * change a name's sort position, since it only ever swaps one character for
 * a space of the same width.
 */
function namedGroupBlock(
  noun: string,
  names: readonly string[],
  pluginName: string,
  width: number,
): string[] {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, MAX_NAMES_SHOWN).map(safe);
  const more = sorted.length - shown.length;
  const heading = `${sorted.length}, called as ${safe(pluginName)}:<${noun}>`;
  return labelledLines(`${noun}s`, [
    heading,
    ...nameColumns(shown, width),
    ...(more > 0 ? [`… and ${more} more`] : []),
  ]);
}

/**
 * `shown`, padded to the widest name and laid out row-major in as many
 * columns as fit `width` minus the continuation indent, two spaces between
 * columns.
 */
function nameColumns(shown: readonly string[], width: number): string[] {
  if (shown.length === 0) return [];
  const available = Math.max(width - CONTINUATION.length, 1);
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

/**
 * Greedy word-wrap: as many words as fit on a line, one word alone on its
 * own line when even that word does not fit.
 */
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
 * The description, split into paragraphs on its own blank lines *before*
 * sanitizing — `safe` turns every control character, a bare `\n` included,
 * into a space, so finding the paragraph breaks has to happen first or
 * there would be none left to find. Each paragraph is then sanitized,
 * reflowed, and word-wrapped at `width` minus the 2-space indent every line
 * carries; a blank line separates wrapped paragraphs.
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
