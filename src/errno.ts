/**
 * Narrow a caught value to a Node errno error, optionally matching a specific
 * code (e.g. "ENOENT"). Every Node filesystem API rejects with an `Error`
 * instance that carries `code`, so an `Error` with the field is the contract.
 */
export function isErrno(
  err: unknown,
  code?: string,
): err is NodeJS.ErrnoException {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return code === undefined || err.code === code;
}
