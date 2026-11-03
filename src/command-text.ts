/**
 * The text of a printed `capshelf` command. Pure, with no Node import, so
 * the web UI bundle and the CLI build commands with one function. Every
 * command a person copies must run as printed.
 */

/**
 * One argument of a shell command capshelf prints for a user to copy.
 *
 * Single quotes, not double, and not `JSON.stringify`. A double-quoted string
 * still runs a command substitution: verified in bash 5, `p="$(echo PWNED)"`
 * assigns `PWNED`, while the single-quoted form keeps the text. Inside single
 * quotes a shell expands nothing at all, so the only character needing an
 * escape is the quote itself.
 *
 * This matters because the arguments are not always the user's own words.
 * Item names reach these commands from the manifest, the lockfile, and the
 * data-repo catalog, which `src/assert.ts:11-19` treats as untrusted input in
 * a cloned project. `isSafeItemName` rejects control characters and a leading
 * `-`, but it permits a space and it permits `$`. A data repo can therefore
 * hold `settings/$(whoami)`, and an unquoted printed command would carry that
 * text into the user's shell.
 *
 * Bare when it is safe, so ordinary output stays readable.
 *
 * Callers pass a path a shell can use, never a display path. `~` is data here
 * and is quoted like any other character, and a shell expands nothing inside
 * single quotes, so `shellArg(homeRelative(p))` builds a command that fails
 * for every path under $HOME. Use the absolute path in a command and
 * `homeRelative` only in the prose around it.
 */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `capshelf` prefix for a printed command. `--data` is repeated only when
 * this run used the override: without it the machine-local binding resolves
 * the same repository on a rerun, and the printed command stays portable. With
 * it, omitting the flag would resolve a different repository than the one this
 * run acted on.
 */
export function capshelfCommandPrefix(
  dataOverride: string | undefined,
): string {
  return dataOverride === undefined
    ? "capshelf"
    : `capshelf --data ${shellArg(dataOverride)}`;
}

/** The prefix, then each argument quoted with `shellArg`. */
export function capshelfCommand(
  dataOverride: string | undefined,
  args: readonly string[],
): string {
  return [capshelfCommandPrefix(dataOverride), ...args.map(shellArg)].join(" ");
}
