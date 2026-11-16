/**
 * Display-safe text is not shell-safe: a path like `x$(cmd)` would run `cmd`
 * when a printed command is pasted, so printed arguments need shell quoting.
 */
const PLAIN = /^[A-Za-z0-9_./:@=+-]+$/;

export function shellQuote(arg: string): string {
  if (PLAIN.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}
