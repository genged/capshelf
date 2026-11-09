/**
 * Typed CLI errors. Domain and command code throws these; the boundary in
 * `cli.ts` is the only place that turns them into stderr output and an exit
 * code. Keeping process control at the edge is what makes the rest of the code
 * callable (and testable) without spawning a subprocess.
 *
 * `ExitCode` is the public contract (asserted by tests and documented for
 * scripts). Subclasses bake in their code, so callers never pass an exit code
 * by hand — they pick the error that describes the failure.
 */
export const ExitCode = {
  /** Unexpected/internal failure, or a plain `Error` that reached the boundary. */
  Unknown: 1,
  /** A referenced item/resource was not found or is not tracked. */
  NotFound: 2,
  /** The operation is not allowed in the current state (guard/precondition). */
  Precondition: 3,
  /** A verification or `--strict` check failed (drift, upstream mismatch). */
  CheckFailed: 4,
  /** No data repo is configured for this project (pass --data / set a binding). */
  DataRepoNotConfigured: 6,
  /** Git is required but unavailable on PATH. */
  GitUnavailable: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorOptions {
  /** Optional second line, printed indented under the message. */
  hint?: string;
  cause?: unknown;
}

/**
 * Base class for every *expected* CLI failure. Throw a subclass; the boundary
 * prints `✗ <message>` (plus an indented `<hint>` when present) and exits with
 * `exitCode`. Only `CliError` itself exposes `exitCode` — subclasses fix it.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(
    message: string,
    options: CliErrorOptions & { exitCode?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.exitCode = options.exitCode ?? ExitCode.Unknown;
    this.hint = options.hint;
  }
}

/** Exit 2 — a referenced item is not found or not tracked in this project. */
export class NotFoundError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.NotFound });
  }
}

/** Exit 3 — the operation is refused because a precondition does not hold. */
export class PreconditionError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.Precondition });
  }
}

/** Exit 4 — a verification or strict check failed (drift, upstream mismatch). */
export class CheckFailedError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.CheckFailed });
  }
}

/** Exit 6 — no data repo is configured for this project. */
export class DataRepoNotConfiguredError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.DataRepoNotConfigured });
  }
}

/**
 * Signals a non-zero exit code for a command that has *already* reported its
 * own details (e.g. a per-item summary, or a `--strict` report). Carries no
 * message, so the boundary prints nothing extra — it only sets the code.
 */
export class ResultExitError extends CliError {
  constructor(exitCode: number) {
    super("", { exitCode });
  }
}

/** What a per-item error result keeps from a caught error. */
export interface ItemErrorFields {
  error: string;
  hint?: string;
  /** Not printed. `itemErrorsExitCode` reads it. */
  exitCode?: number;
}

/**
 * A per-item error keeps the message, and a `CliError` also keeps its hint and
 * exit code. A command that collects per-item results would otherwise drop
 * the hint that tells the user how to fix the refusal.
 */
export function itemErrorFields(cause: unknown): ItemErrorFields {
  if (cause instanceof CliError) {
    return {
      error: cause.message,
      ...(cause.hint !== undefined && { hint: cause.hint }),
      exitCode: cause.exitCode,
    };
  }
  return { error: cause instanceof Error ? cause.message : String(cause) };
}

/** A per-item result as JSON prints it: without the internal exit code. */
export function withoutExitCode<T extends { exitCode?: number }>(
  result: T,
): Omit<T, "exitCode"> {
  const { exitCode: _exitCode, ...rest } = result;
  return rest;
}

/**
 * The exit code for a run with per-item errors: the code that every error
 * shares, or 1 when they differ or one is a plain `Error`.
 */
export function itemErrorsExitCode(
  results: readonly { action: string; exitCode?: number }[],
): number {
  const codes = new Set(
    results
      .filter((result) => result.action === "error")
      .map((result) => result.exitCode ?? ExitCode.Unknown),
  );
  const [only] = codes;
  return codes.size === 1 && only !== undefined ? only : ExitCode.Unknown;
}

/**
 * The first line of a caught error, for one-line diagnostics (catalog rows,
 * per-item failure summaries) where a multi-line git message would break the
 * layout.
 */
export function firstErrorLine(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).split(
    "\n",
  )[0]!;
}
