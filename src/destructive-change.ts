import { createInterface } from "node:readline/promises";
import { PreconditionError } from "./errors";
import { installDifferenceLabel } from "./install-diff";

/**
 * Every kind of local state a consented write can destroy. A reason exists
 * only when a planner emits it: an unimplemented branch of a safety boundary
 * reads as implemented, which is worse than an absent one. `install_target`
 * was declared and never emitted — `add` over a pre-existing unmanaged target
 * is a hard refusal by design (`findInstallConflict`,
 * `assertCanMaterializeInstalled`), not consentable loss — so it is gone.
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
   * PIN-7: a one-line explanation of *what kind* of difference this is, from
   * `installDifferenceLabel`. It labels the prompt and never gates it —
   * whether a write destroys something is decided by `reason` alone, because
   * the cause of a difference is not decidable from bytes and a wrong guess
   * would silently discard a deliberate change.
   */
  detail?: string;
  reviewCommand?: string;
}

export interface DestructiveChangePlan {
  changes: DestructiveChange[];
  snapshot: string;
  /** The sorted snapshot parts, so a mismatch can name what changed. */
  state: readonly string[];
}

export interface DestructiveConfirmationContext {
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  prompt: (message: string) => Promise<string>;
  /** Where the prompt draws. The return value is never read. */
  stderr: { write(text: string): void };
  /** D9 of the remote discovery spec. Absent means "not a terminal". */
  stdoutIsTTY?: boolean;
  /** Terminal height in rows, or null when the terminal does not report it. */
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

/**
 * What differs between two snapshots, as the paths the parts name. A copy or
 * subagent part starts with `<kind>:<absolute path>:`. Any other part names a
 * lock entry or a planned output, and is reported by its kind.
 */
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
 * Replace the confirmation context every command uses, or restore the default
 * with `null`. Returns the context that was installed before, so a caller can
 * restore it instead of clobbering an outer one.
 *
 * This is the one seam that lets the interactive consent path be exercised as
 * it actually ships. The alternative — a command-module wrapper that
 * hardcoded its own prompt strings and had zero production callers — made the
 * TTY prompt, the `y`/`N` parsing, and the cancellation message look covered
 * while none of them were.
 */
export function setDestructiveConfirmationContext(
  context: DestructiveConfirmationContext | null,
): DestructiveConfirmationContext | null {
  const previous = installedConfirmationContext;
  installedConfirmationContext = context;
  return previous;
}

/**
 * One free-text question on the terminal, through the same injectable context
 * the consent prompt uses.
 *
 * The share picker asks for a new item's name after its full-screen frame
 * closes, and that question must be testable without a pseudo-terminal. The
 * seam already exists for consent; reusing it keeps one prompt mechanism and
 * one way to fake it.
 */
export async function askQuestion(
  message: string,
  context: DestructiveConfirmationContext = installedConfirmationContext ??
    defaultDestructiveConfirmationContext(),
): Promise<string> {
  return await context.prompt(message);
}

/**
 * The confirmation context in force.
 *
 * A consent gate that is not a destructive-change plan — the remote-skill
 * install gate, where nothing is destroyed and the question is whether to run
 * someone else's code — still has to ask through this one seam, or it becomes
 * a second prompt mechanism with its own untestable TTY branch.
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

/** Groups larger than this print one line per folder. */
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
 * One line per entry of the deepest folder that holds all of `group`, with
 * the number of listed paths in each subfolder. A Python venv that Git can
 * see is about 1,000 files, and one line for each hides the decision. The
 * plan itself still lists every path.
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
    // `0` means "a terminal is attached but did not report a height" on some
    // hosts; D9 cannot compare a listing's length against that, so it is
    // folded into "unknown" the same as a missing value.
    terminalRows: process.stdout.rows || null,
    prompt: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        // Under Bun 1.3.14, `readline.question()` does not settle on EOF: a
        // closed pipe or `< /dev/null` fires the interface's `close` event
        // right away, but the question promise neither resolves nor rejects
        // — it hangs forever. Racing it against `close` turns that hang into
        // a rejection instead. Before this fix every prompt through this
        // context hung forever on EOF (a closed pipe or `< /dev/null`); now
        // it does not. Ctrl-C at an open prompt takes this path too:
        // readline holds the terminal in raw mode, reads Ctrl-C as a key,
        // and closes, so no SIGINT is sent and the race rejects. A Ctrl-C
        // that arrives before the prompt opens is still a tty SIGINT, and
        // the process exits by signal (130). Most callers —
        // `confirmInstall`, `confirmRemotePinMove`,
        // `confirmDestructiveChanges`, and a direct `askQuestion` — do not
        // catch this rejection, so it reaches `main`'s handler, which prints
        // it and exits 1 before any write (`reportError`, `src/cli.ts:127`).
        // Only the D9 "show all" question (`confirmShowAllSkills`,
        // `src/commands/add-remote.ts`) catches it and treats it as "no".
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
