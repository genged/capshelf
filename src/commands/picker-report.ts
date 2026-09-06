/**
 * Failure reporting for the interactive per-item loops.
 *
 * A per-item failure used to print only the first line of its message. For
 * simple refusals that was the whole story, but promote's stale refusal is a
 * multi-line teaching text whose later lines carry the resolution commands —
 * truncating it left the user with a diagnosis and no repair, and the generic
 * `retry:` line then named a command that fails the same way. So the full
 * message is printed, a structured hint is printed with it (these loops catch
 * errors before the CLI boundary that normally prints hints), and the generic
 * retry line is added only when the message brought no recovery command of
 * its own.
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
