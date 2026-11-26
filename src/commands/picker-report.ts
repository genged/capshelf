/**
 * Prints the full message plus hint because these loops catch errors before the
 * CLI boundary and later lines carry the resolution commands; the generic retry
 * is added only when none is given.
 */
import { CliError, ResultExitError } from "../errors";

export function reportItemFailure(
  ref: string,
  cause: unknown,
  retryCommand: string,
): void {
  // `ResultExitError` carries no message because the code that threw it
  // already reported the detail.
  if (cause instanceof ResultExitError) {
    console.error(`  retry: ${retryCommand}`);
    return;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const [first = "failed", ...rest] = message.split("\n");
  console.error(`✗ ${ref} — ${first}`);
  for (const line of rest) console.error(line);
  const hint = cause instanceof CliError ? cause.hint : undefined;
  if (hint !== undefined) console.error(`  ${hint}`);
  // A message or hint that names a capshelf command carries its own repair,
  // and the plain retry would fail the same way. Anything else gets the retry.
  const hasOwnCommand = `${message}\n${hint ?? ""}`.includes("capshelf ");
  if (!hasOwnCommand) console.error(`  retry: ${retryCommand}`);
}
