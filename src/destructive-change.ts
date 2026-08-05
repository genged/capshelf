import { createInterface } from "node:readline/promises";
import { PreconditionError } from "./errors";

export type DestructiveChangeReason =
  | "managed_content"
  | "executable_mode"
  | "extra_local_path"
  | "subagent_target"
  | "fragment_contribution"
  | "config_comments"
  | "dirty_projection"
  | "install_target";

export interface DestructiveChange {
  scope: "project" | "local" | "data-repo";
  item?: string;
  path: string;
  reason: DestructiveChangeReason;
  reviewCommand?: string;
}

export interface DestructiveChangePlan {
  changes: DestructiveChange[];
  snapshot: string;
}

export interface DestructiveConfirmationContext {
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  prompt: (message: string) => Promise<string>;
  stderr: { write(text: string): unknown };
}

interface DestructiveConfirmationOptions {
  operation: string;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  rerunCommand: string;
}

const reasonLabels: Record<DestructiveChangeReason, string> = {
  managed_content: "overwrite managed content",
  executable_mode: "replace an executable-mode change",
  extra_local_path: "delete a local-only path",
  subagent_target: "overwrite a subagent target",
  fragment_contribution: "replace a managed config contribution",
  config_comments: "remove config comments",
  dirty_projection: "replace a dirty generated projection",
  install_target: "replace an existing install target",
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
  return {
    changes: normalized,
    snapshot: JSON.stringify({
      changes: normalized,
      state: [...snapshotParts].sort(),
    }),
  };
}

export function assertDestructivePlanUnchanged(
  accepted: DestructiveChangePlan,
  current: DestructiveChangePlan,
): void {
  if (accepted.snapshot !== current.snapshot) {
    throw new PreconditionError(
      "local state changed after destructive-change preflight; no changes were written",
      { hint: "Review the affected paths again, then rerun the command." },
    );
  }
}

export async function confirmDestructiveChanges(
  plan: DestructiveChangePlan,
  options: DestructiveConfirmationOptions,
  context: DestructiveConfirmationContext = defaultDestructiveConfirmationContext(),
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
  return [
    `${operation} would destroy local state:`,
    ...normalized.map((change) => {
      const item = change.item ? `${change.item} — ` : "";
      return `  ${item}${change.path} — ${reasonLabels[change.reason]}`;
    }),
    ...(normalized.some((change) => change.scope === "local")
      ? [
          "  Warning: local-scope files are excluded from project Git and may not be recoverable.",
        ]
      : []),
  ].join("\n");
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
    prompt: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await readline.question(message);
      } finally {
        readline.close();
      }
    },
    stderr: process.stderr,
  };
}
