import { spawn } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * One process result, rich enough to tell a normal refusal apart from a
 * crash. A bare `exitCode` cannot: a command killed by a signal, one stopped
 * at the safety deadline, and one that never started all look like "not zero",
 * and each needs a different diagnosis.
 */
export type CommandOutcome =
  | { kind: "exit"; exitCode: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout"; timeoutMs: number; finalSignal: string }
  | { kind: "spawn-error"; message: string };

export interface CommandResult {
  command: readonly string[];
  cwd: string;
  outcome: CommandOutcome;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  /**
   * Safety deadline. This is not a performance assertion and is never passed
   * to capshelf as a user option.
   */
  timeoutMs?: number;
  /** Delay between the group SIGTERM and the group SIGKILL. */
  graceMs?: number;
  /**
   * How long to wait for output pipes to close after the child exits. A
   * grandchild that inherited the pipe can hold it open after its parent is
   * gone; at this point the runner destroys the streams instead of waiting.
   */
  drainMs?: number;
  stdin?: string;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_GRACE_MS = 2_000;
export const DEFAULT_DRAIN_MS = 2_000;
/** Time for a group SIGKILL to take effect before the result is reported. */
const ESCALATION_SETTLE_MS = 100;

/**
 * Values that must never reach a diagnostic. The required lane carries no
 * credentials, but a compatibility lane does, and both use this renderer.
 */
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= 4) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

/** Names whose *values* are treated as secrets when a world declares them. */
const SECRET_NAME_PATTERN =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^GH_/i;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export async function runCommand(
  command: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("runCommand needs at least an executable");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...options.env },
      // A new process group is what makes the deadline able to bound the whole
      // tree. Killing the child alone leaves a grandchild running.
      detached: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
    let finalSignal = "";
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (killer) clearTimeout(killer);
      if (drainTimer) clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        command,
        cwd: options.cwd,
        outcome,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
        // Recorded only once the signal is delivered. An escalation that finds
        // the group already gone must not claim it sent SIGKILL: whether the
        // escalation was needed is the fact a timeout diagnostic exists to
        // report.
        finalSignal = signal;
      } catch {
        // The group is already gone; nothing left to bound.
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
    });

    child.on("error", (err: Error) => {
      finish({ kind: "spawn-error", message: err.message });
    });

    child.on("exit", (code, signal) => {
      if (deadline) clearTimeout(deadline);
      // Once a timeout is escalating, the escalation owns the result. The
      // direct child exiting says nothing about a grandchild that ignored
      // SIGTERM, and cancelling the escalation here would leave that
      // grandchild running after the runner reported a bounded process tree.
      if (timedOut) return;
      // Prefer "close" so late output is not lost, but never block on it: a
      // grandchild holding the inherited pipe would otherwise hang the run.
      let closed = false;
      child.on("close", () => {
        closed = true;
        settleExit(code, signal);
      });
      drainTimer = setTimeout(() => {
        if (!closed) settleExit(code, signal);
      }, drainMs);
    });

    // Only the non-timeout paths reach this. A timeout finishes after its
    // escalation, so the reported `finalSignal` is the last one actually sent.
    const settleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (signal !== null) {
        finish({ kind: "signal", signal });
        return;
      }
      finish({ kind: "exit", exitCode: code ?? 0 });
    };

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }

    deadline = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killer = setTimeout(() => {
        // Escalate unconditionally. Whether the direct child is still alive
        // is not the question — a grandchild that ignores SIGTERM is, and it
        // is invisible from here. Sending SIGKILL to a group that is already
        // gone raises ESRCH, which signalGroup swallows.
        signalGroup("SIGKILL");
        setTimeout(
          () => finish({ kind: "timeout", timeoutMs, finalSignal }),
          ESCALATION_SETTLE_MS,
        );
      }, graceMs);
    }, timeoutMs);
  });
}

export function describeOutcome(outcome: CommandOutcome): string {
  switch (outcome.kind) {
    case "exit":
      return `exit ${outcome.exitCode}`;
    case "signal":
      return `killed by signal ${outcome.signal}`;
    case "timeout":
      return `timed out after ${outcome.timeoutMs} ms (last signal sent to the process group: ${outcome.finalSignal})`;
    case "spawn-error":
      return `could not start the process: ${outcome.message}`;
  }
}

export interface DiagnosticExtras {
  /** Names only. A value can be a credential. */
  envNames?: readonly string[];
  preservedWorkspace?: string | null;
  notes?: readonly string[];
}

/**
 * The failure text a reader gets in CI, where the world is already deleted.
 * Everything needed to reproduce or diagnose must be in here.
 */
export function describeCommand(
  result: CommandResult,
  extras: DiagnosticExtras = {},
): string {
  const lines = [
    `command: ${result.command.join(" ")}`,
    `cwd: ${result.cwd}`,
    `outcome: ${describeOutcome(result.outcome)}`,
    "stdout:",
    indent(result.stdout || "(empty)"),
    "stderr:",
    indent(result.stderr || "(empty)"),
    "tree:",
    indent(directoryTree(result.cwd)),
  ];
  if (extras.envNames && extras.envNames.length > 0) {
    lines.push(
      `environment variables: ${[...extras.envNames].sort().join(", ")}`,
    );
  }
  if (extras.preservedWorkspace) {
    lines.push(`preserved workspace: ${extras.preservedWorkspace}`);
  }
  for (const note of extras.notes ?? []) lines.push(note);
  return redact(lines.join("\n"));
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * A short tree. Bounded on purpose: a failing world can hold a Git object
 * store, and an unbounded listing buries the two paths that matter.
 */
export function directoryTree(root: string, limit = 60, maxDepth = 4): string {
  const found: string[] = [];
  // A bare repository's object store is never the interesting part of a
  // failure, and it is large enough to bury what is.
  const skip = new Set([
    ".git",
    "node_modules",
    "objects",
    "refs",
    "hooks",
    "logs",
  ]);
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) {
        return;
      }
      const full = join(dir, entry);
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(full, { throwIfNoEntry: true });
      } catch {
        found.push(`${relative(root, full)} (unreadable)`);
        continue;
      }
      if (stats.isSymbolicLink()) {
        found.push(`${relative(root, full)} -> (symlink)`);
      } else if (stats.isDirectory()) {
        found.push(`${relative(root, full)}/`);
        if (!skip.has(entry)) walk(full, depth + 1);
      } else {
        found.push(relative(root, full));
      }
    }
  };
  walk(root, 0);
  if (found.length === 0) return "(empty)";
  const shown = found.slice(0, limit).join("\n");
  return found.length >= limit ? `${shown}\n… (truncated)` : shown;
}
