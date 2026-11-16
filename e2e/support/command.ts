import { spawn } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A bare exit code cannot distinguish a refusal from a signal kill, a timeout,
 * or a spawn failure, which each need different diagnosis.
 */
export type CommandOutcome =
  | { kind: "exit"; exitCode: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout"; timeoutMs: number }
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
   * Safety deadline only; not a performance assertion and never passed to
   * capshelf.
   */
  timeoutMs?: number;
  graceMs?: number;
  /**
   * A grandchild that inherited the pipe can hold it open after the child
   * exits, so the runner destroys the streams after this delay.
   */
  drainMs?: number;
  stdin?: string;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_GRACE_MS = 2_000;
export const DEFAULT_DRAIN_MS = 2_000;
const ESCALATION_SETTLE_MS = 100;

/**
 * Registered values never reach diagnostics; compatibility lanes carry
 * credentials and share this renderer.
 */
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= 4) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

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
      // A new process group lets the deadline bound the whole tree; killing
      // only the child leaves a grandchild running.
      detached: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
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
      // Once a timeout is escalating it owns the result, since the direct child
      // exiting says nothing about a grandchild that ignored SIGTERM.
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
        // Escalate unconditionally because a grandchild ignoring SIGTERM is
        // invisible from here; which signal ended the tree is not reported
        // since telling live from zombie processes needs /proc.
        signalGroup("SIGKILL");
        setTimeout(
          () => finish({ kind: "timeout", timeoutMs }),
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
      return `timed out after ${outcome.timeoutMs} ms`;
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
 * CI failure text is read after the world is deleted, so it must contain
 * everything needed to reproduce or diagnose.
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
 * Bounded because a failing world can hold a Git object store that buries the
 * relevant paths.
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
