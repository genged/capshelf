/**
 * Only the boundary in `cli.ts` turns errors into stderr and an exit code, so
 * other code stays callable without a subprocess; `ExitCode` is a public
 * contract.
 */
export const ExitCode = {
  Unknown: 1,
  NotFound: 2,
  Precondition: 3,
  CheckFailed: 4,
  DataRepoNotConfigured: 6,
  GitUnavailable: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorOptions {
  hint?: string;
  cause?: unknown;
}

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

export class NotFoundError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.NotFound });
  }
}

export class PreconditionError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.Precondition });
  }
}

export class CheckFailedError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.CheckFailed });
  }
}

export class DataRepoNotConfiguredError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, { ...options, exitCode: ExitCode.DataRepoNotConfigured });
  }
}

/**
 * For commands that already reported their details; carries no message so the
 * boundary prints nothing extra.
 */
export class ResultExitError extends CliError {
  constructor(exitCode: number) {
    super("", { exitCode });
  }
}

export interface ItemErrorFields {
  error: string;
  hint?: string;
  exitCode?: number;
}

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

export function withoutExitCode<T extends { exitCode?: number }>(
  result: T,
): Omit<T, "exitCode"> {
  const { exitCode: _exitCode, ...rest } = result;
  return rest;
}

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
 * First line only, because a multi-line git message would break one-line
 * diagnostics layout.
 */
export function firstErrorLine(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).split(
    "\n",
  )[0]!;
}
