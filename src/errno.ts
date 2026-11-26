export function isErrno(
  err: unknown,
  code?: string,
): err is NodeJS.ErrnoException {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return code === undefined || err.code === code;
}
