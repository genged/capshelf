/**
 * Pure, with no Node import, so the web UI bundle and the CLI build commands
 * with one function; every printed command must run as copied.
 */

/**
 * Single quotes prevent command substitution, because item names from
 * untrusted data repos may contain `$`. Quoted `~` stays literal, so a path
 * under home must be passed as an absolute path.
 */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `--data` is repeated only when this run used the override; otherwise the
 * machine-local binding resolves the same repo and the command stays portable.
 */
export function capshelfCommandPrefix(
  dataOverride: string | undefined,
): string {
  return dataOverride === undefined
    ? "capshelf"
    : `capshelf --data ${shellArg(dataOverride)}`;
}

/**
 * Uses the resolved absolute repo because a relative override like `../shelf`
 * would name another repository when run from a project root.
 */
export function commandDataOverride(
  dataOverride: string | null | undefined,
  dataRepo: string | null | undefined,
): string | undefined {
  if (dataOverride === null || dataOverride === undefined) return undefined;
  return dataRepo ?? dataOverride;
}

export function capshelfCommand(
  dataOverride: string | undefined,
  args: readonly string[],
): string {
  return [capshelfCommandPrefix(dataOverride), ...args.map(shellArg)].join(" ");
}
