import { createInterface } from "node:readline/promises";
import { PreconditionError } from "./errors";
import { installDifferenceLabel } from "./install-diff";

/**
 * A reason exists only when a planner emits it: an unimplemented branch of a
 * safety boundary reads as implemented.
 */
export type DestructiveChangeReason =
  | "managed_content"
  | "executable_mode"
  | "extra_local_path"
  | "subagent_target"
  | "fragment_contribution"
  | "config_comments"
  | "dirty_projection";

export interface DestructiveChange {
  scope: "project" | "local" | "data-repo";
  item?: string;
  path: string;
  reason: DestructiveChangeReason;
  /**
   * Labels the prompt and never gates it: `reason` alone decides destruction,
   * since a difference's cause isn't decidable from bytes.
   */
  detail?: string;
  reviewCommand?: string;
}

export interface DestructiveChangePlan {
  changes: DestructiveChange[];
  snapshot: string;
  state: readonly string[];
}

export interface DestructiveConfirmationContext {
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  prompt: (message: string) => Promise<string>;
  stderr: { write(text: string): void };
  stdoutIsTTY?: boolean;
  terminalRows?: number | null;
}

interface DestructiveConfirmationOptions {
  operation: string;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  rerunCommand: string;
}

export const DESTRUCTIVE_CHANGE_REASON_LABELS: Record<
  DestructiveChangeReason,
  string
> = {
  managed_content: "overwrite managed content",
  executable_mode: "replace an executable-mode change",
  extra_local_path: "delete a local-only path",
  subagent_target: "overwrite a subagent target",
  fragment_contribution: "replace a managed config contribution",
  config_comments: "remove config comments",
  dirty_projection: "replace a dirty generated projection",
};

export function normalizeDestructiveChanges(
  changes: DestructiveChange[],
): DestructiveChange[] {
  const unique = new Map<string, DestructiveChange>();
  for (const change of changes) {
    const normalized = {
      scope: change.scope,
      ...(change.item && { item: change.item }),
      path: change.path,
      reason: change.reason,
      ...(change.detail && { detail: change.detail }),
      ...(change.reviewCommand && { reviewCommand: change.reviewCommand }),
    } satisfies DestructiveChange;
    const key = changeKey(normalized);
    const current = unique.get(key);
    if (
      !current ||
      (normalized.reviewCommand !== undefined &&
        (current.reviewCommand === undefined ||
          normalized.reviewCommand.localeCompare(current.reviewCommand) < 0))
    ) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()].sort((left, right) =>
    changeKey(left).localeCompare(changeKey(right)),
  );
}

export function createDestructiveChangePlan(
  changes: DestructiveChange[],
  snapshotParts: string[] = [],
): DestructiveChangePlan {
  const normalized = normalizeDestructiveChanges(changes);
  const state = [...snapshotParts].sort();
  return {
    changes: normalized,
    snapshot: JSON.stringify({ changes: normalized, state }),
    state,
  };
}

export function assertDestructivePlanUnchanged(
  accepted: DestructiveChangePlan,
  current: DestructiveChangePlan,
): void {
  if (accepted.snapshot !== current.snapshot) {
    const changed = changedSnapshotSubjects(accepted.state, current.state);
    const shown = changed.slice(0, CHANGED_PATHS_SHOWN);
    const rest = changed.length - shown.length;
    const lines = [
      "local state changed after destructive-change preflight; no changes were written",
      ...shown.map((subject) => `  changed: ${subject}`),
      ...(rest > 0 ? [`  and ${rest} more`] : []),
    ];
    throw new PreconditionError(lines.join("\n"), {
      hint: "Review the affected paths again, then rerun the command.",
    });
  }
}

const CHANGED_PATHS_SHOWN = 5;

function changedSnapshotSubjects(
  accepted: readonly string[],
  current: readonly string[],
): string[] {
  const before = new Set(accepted);
  const after = new Set(current);
  const subjects = new Set<string>();
  for (const part of [
    ...accepted.filter((item) => !after.has(item)),
    ...current.filter((item) => !before.has(item)),
  ]) {
    const separator = part.indexOf(":");
    const kind = part.slice(0, separator);
    const rest = part.slice(separator + 1);
    subjects.add(
      kind === "copy" || kind === "subagent"
        ? (rest.split(":")[0] ?? rest)
        : `${kind} (a lock entry or planned output)`,
    );
  }
  if (subjects.size === 0) subjects.add("the planned changes");
  return [...subjects].sort();
}

let installedConfirmationContext: DestructiveConfirmationContext | null = null;

/**
 * The one seam that lets the interactive consent path be tested as shipped;
 * returns the previous context so callers can restore it.
 */
export function setDestructiveConfirmationContext(
  context: DestructiveConfirmationContext | null,
): DestructiveConfirmationContext | null {
  const previous = installedConfirmationContext;
  installedConfirmationContext = context;
  return previous;
}

/**
 * Reuses the consent prompt's injectable context so the picker's name question
 * is testable without a pseudo-terminal.
 */
export async function askQuestion(
  message: string,
  context: DestructiveConfirmationContext = installedConfirmationContext ??
    defaultDestructiveConfirmationContext(),
): Promise<string> {
  return await context.prompt(message);
}

/**
 * Non-destructive consent gates must ask through this one seam, or they become
 * a second untestable prompt mechanism.
 */
export function confirmationContext(): DestructiveConfirmationContext {
  return (
    installedConfirmationContext ?? defaultDestructiveConfirmationContext()
  );
}

export async function confirmDestructiveChanges(
  plan: DestructiveChangePlan,
  options: DestructiveConfirmationOptions,
  context: DestructiveConfirmationContext = installedConfirmationContext ??
    defaultDestructiveConfirmationContext(),
): Promise<boolean> {
  if (plan.changes.length === 0 || options.dryRun || options.yes) return true;

  const warning = renderDestructiveChanges(options.operation, plan.changes);
  const reviewCommands = [
    ...new Set(
      plan.changes.flatMap((change) =>
        change.reviewCommand ? [change.reviewCommand] : [],
      ),
    ),
  ].sort();
  const guidance = reviewCommands.length
    ? [
        "Review local changes with:",
        ...reviewCommands.map((command) => `  ${command}`),
      ].join("\n")
    : "Review the affected paths before continuing.";
  const hint = `${guidance.replaceAll("\n", " ")} Rerun with \`${options.rerunCommand}\` to authorize the listed loss.`;

  if (options.json || !context.stdinIsTTY || !context.stderrIsTTY) {
    throw new PreconditionError(warning, { hint });
  }

  const answer = await context.prompt(
    `${warning}\n${guidance}\nContinue? [y/N] `,
  );
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  context.stderr.write(
    `${options.operation} cancelled; no changes were written.\n`,
  );
  return false;
}

export function renderDestructiveChanges(
  operation: string,
  changes: DestructiveChange[],
): string {
  const normalized = normalizeDestructiveChanges(changes);
  const groups = new Map<string, DestructiveChange[]>();
  for (const change of normalized) {
    const key = groupKey(change);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  const printed = new Set<string>();
  return [
    `${operation} would destroy local state:`,
    ...normalized.flatMap((change) => {
      const key = groupKey(change);
      const group = groups.get(key) ?? [change];
      if (group.length > FOLD_ABOVE) {
        if (printed.has(key)) return [];
        printed.add(key);
        return foldedLines(group);
      }
      const line = `  ${itemPrefix(change)}${change.path} — ${DESTRUCTIVE_CHANGE_REASON_LABELS[change.reason]}`;
      return change.detail ? [line, `      ${change.detail}`] : [line];
    }),
    ...(normalized.some((change) => change.detail === VISIBLE_EXTRA_DETAIL)
      ? [
          "  To keep a local-only path, add it to a .gitignore file, then rerun the command.",
        ]
      : []),
    ...(normalized.some((change) => change.scope === "local")
      ? [
          "  Warning: local-scope files are excluded from project Git and may not be recoverable.",
        ]
      : []),
  ].join("\n");
}

const FOLD_ABOVE = 10;

const VISIBLE_EXTRA_DETAIL = installDifferenceLabel({
  path: "",
  kind: "visible-extra",
});

function itemPrefix(change: DestructiveChange): string {
  return change.item ? `${change.item} — ` : "";
}

function groupKey(change: DestructiveChange): string {
  return [
    change.scope,
    change.item ?? "",
    change.reason,
    change.detail ?? "",
  ].join("\0");
}

/**
 * Folds large listings per subfolder because one line per file (a visible venv
 * is ~1,000) hides the decision; the plan still lists every path.
 */
function foldedLines(group: readonly DestructiveChange[]): string[] {
  const [first] = group;
  if (first === undefined) return [];
  const parts = group.map((change) => change.path.split("/"));
  let depth = 0;
  while (
    parts.every(
      (path) => path.length > depth + 1 && path[depth] === parts[0]?.[depth],
    )
  ) {
    depth++;
  }
  const base = parts[0]?.slice(0, depth).join("/") ?? "";
  const counts = new Map<string, number>();
  for (const path of parts) {
    const entry = path[depth] ?? "";
    const isFolder = path.length > depth + 1;
    const key = isFolder ? `${entry}/` : entry;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const label = DESTRUCTIVE_CHANGE_REASON_LABELS[first.reason];
  const entries = [...counts.entries()];
  const lines = entries.slice(0, FOLD_ABOVE).map(([entry, count]) => {
    const path = base ? `${base}/${entry}` : entry;
    const suffix = entry.endsWith("/") ? ` (${count} paths in it)` : "";
    return `  ${itemPrefix(first)}${path}${suffix} — ${label}`;
  });
  const rest = entries.length - FOLD_ABOVE;
  if (rest > 0)
    lines.push(
      `  ${itemPrefix(first)}and ${rest} more entries in ${base || "."}`,
    );
  lines.push(
    `      ${group.length} paths${first.detail ? `: ${first.detail}` : ""}`,
  );
  return lines;
}

function changeKey(change: DestructiveChange): string {
  return [change.scope, change.item ?? "", change.path, change.reason].join(
    "\0",
  );
}

function defaultDestructiveConfirmationContext(): DestructiveConfirmationContext {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    // Some hosts report `0` rows for an attached terminal with no height, so
    // treat it as unknown.
    terminalRows: process.stdout.rows || null,
    prompt: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        // Bun 1.3.14 `readline.question()` never settles on EOF or Ctrl-C at an
        // open prompt, so race it against `close` to reject instead of hanging.
        const closedBeforeAnswer = new Promise<never>((_, reject) => {
          readline.once("close", () =>
            reject(new Error("prompt closed before an answer")),
          );
        });
        return await Promise.race([
          readline.question(message),
          closedBeforeAnswer,
        ]);
      } finally {
        readline.close();
      }
    },
    stderr: process.stderr,
  };
}
