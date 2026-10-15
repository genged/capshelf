/**
 * POSIX shell quoting for commands that capshelf prints for a person to copy.
 *
 * `sanitizeDisplayText` makes text safe for a terminal. It does not make an
 * argument safe for a shell: a repository path such as `x$(cmd)` would run
 * `cmd` when the printed command is pasted. Display text and shell text are
 * two different safety properties, so each has its own function.
 */
const PLAIN = /^[A-Za-z0-9_./:@=+-]+$/;

export function shellQuote(arg: string): string {
  if (PLAIN.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}
