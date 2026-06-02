/**
 * Compile-time exhaustiveness guard. Call from a `default:` branch (or any
 * spot that should be unreachable): if the union ever gains a member that
 * isn't handled, `value` stops being `never` and the call fails to type-check,
 * pinpointing the missing case. Throws if somehow reached at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
