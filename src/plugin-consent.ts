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
import { PLUGIN_MANIFEST_REL } from "./master";
import { runsHaveEntries } from "./plugin-runs";
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

/** Names shown beside a `skills/` or `agents/` group before the `…`. */
const MAX_GROUP_NAMES = 3;

/** The column where a multi-line field's later lines start. */
const CONTINUATION = "            ";

/**
 * The consent block, in the order D6 gives: repo, ref, commit, path,
 * plugin, install, files by top-level directory, runs, codex, license, the
 * description, and the closing line. The caller adds the question.
 */
export function renderPluginConsent(input: PluginConsentInput): string[] {
  const version = input.version === null ? "" : ` ${safe(input.version)}`;
  const totalBytes = input.files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    `  repo      ${safe(input.repo)}`,
    `  ref       ${safe(input.ref)}`,
    `  commit    ${safe(input.commit)}`,
    `  path      ${safe(input.path)}`,
    `  plugin    ${safe(input.name)}${version}  (${PLUGIN_MANIFEST_REL})`,
    `  install   ${safe(input.install)}`,
    `  files     ${input.files.length} ${plural(input.files.length, "file")}, ${formatBytes(totalBytes)}`,
    ...fileGroupLines(input.name, input.files),
    ...pluginRunsField(input.runs),
    // D13: capshelf writes nothing for Codex, so the prompt does not claim
    // that Codex runs the agents or the hooks.
    "  codex     sees the skills only",
    `  license   ${safe(input.license)}`,
    "",
    ...(input.description === null
      ? []
      : [`  ${safe(input.name)}: ${safe(input.description)}`, ""]),
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
  return [server.name, server.command ?? server.url ?? "(no command)"];
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

interface FileGroup {
  label: string;
  files: PluginConsentFile[];
}

/**
 * One line per top-level directory, with a count and a size. `skills/` and
 * `agents/` count their items and name them as Claude Code calls them,
 * `<plugin>:<item>` (spec R5). Files at the plugin root form the `./` group.
 */
function fileGroupLines(
  pluginName: string,
  files: readonly PluginConsentFile[],
): string[] {
  const groups = new Map<string, FileGroup>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const label = slash === -1 ? "./" : `${file.path.slice(0, slash)}/`;
    const group = groups.get(label);
    if (group === undefined) groups.set(label, { label, files: [file] });
    else group.files.push(file);
  }
  const rows = [...groups.values()]
    .sort((a, b) => groupRank(a.label) - groupRank(b.label) || compare(a, b))
    .map((group) => {
      const items = namedItems(group);
      const count =
        items === null
          ? `${group.files.length} ${plural(group.files.length, "file")}`
          : `${items.names.length} ${plural(items.names.length, items.noun)}`;
      const bytes = group.files.reduce((sum, file) => sum + file.bytes, 0);
      const names =
        items === null ? "" : namespacedList(pluginName, items.names);
      return [group.label, count, formatBytes(bytes), names];
    });
  return columns(rows).map((line) => `${CONTINUATION}${line}`);
}

function groupRank(label: string): number {
  if (label === "skills/") return 0;
  if (label === "agents/") return 1;
  if (label === "./") return 3;
  return 2;
}

function compare(a: FileGroup, b: FileGroup): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

const NAMED_GROUPS: ReadonlyMap<string, { noun: string; pattern: RegExp }> =
  new Map([
    ["skills/", { noun: "skill", pattern: /^skills\/([^/]+)\/SKILL\.md$/ }],
    ["agents/", { noun: "agent", pattern: /^agents\/([^/]+)\.md$/ }],
  ]);

/**
 * The skills (`skills/<x>/SKILL.md`) or agents (`agents/<x>.md`) a group
 * holds. Null for any other group, and for one of these two that holds no
 * such item, so its line counts files instead.
 */
function namedItems(
  group: FileGroup,
): { noun: string; names: string[] } | null {
  const named = NAMED_GROUPS.get(group.label);
  if (named === undefined) return null;
  const names = group.files.flatMap((file) => {
    const match = named.pattern.exec(file.path);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return names.length === 0 ? null : { noun: named.noun, names };
}

function namespacedList(pluginName: string, names: readonly string[]): string {
  const shown = [...names]
    .sort()
    .slice(0, MAX_GROUP_NAMES)
    .map((name) => `${pluginName}:${name}`);
  return names.length > MAX_GROUP_NAMES
    ? `${shown.join(", ")}, …`
    : shown.join(", ");
}
