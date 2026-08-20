import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * The E2E layer exists to test the packaged program, so the executable is an
 * input, never a guess. There is deliberately no fallback to
 * `bun run src/cli.ts`, to `process.execPath` plus the entry file, to a
 * `capshelf` found on PATH, or to an in-process `main()` call: any of those
 * would let one run mix packaged and source components, which is the exact
 * fault this layer is meant to catch.
 */
export const BIN_ENV = "CAPSHELF_E2E_BIN";

let cached: string | null = null;

export async function resolveCapshelfBinary(): Promise<string> {
  if (cached !== null) return cached;
  const configured = process.env[BIN_ENV];
  if (!configured) {
    throw new Error(
      `${BIN_ENV} is not set. Run "bun run e2e" to build and test the host binary, ` +
        `or set ${BIN_ENV} to an absolute path to a compiled capshelf executable.`,
    );
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${BIN_ENV} must be an absolute path, got: ${configured}`);
  }
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(configured)) {
    throw new Error(
      `${BIN_ENV} must point at a compiled executable, not a source file: ${configured}`,
    );
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(configured);
  } catch {
    throw new Error(`${BIN_ENV} does not exist: ${configured}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${BIN_ENV} is not a file: ${configured}`);
  }
  try {
    await access(configured, constants.X_OK);
  } catch {
    throw new Error(`${BIN_ENV} is not executable: ${configured}`);
  }
  cached = configured;
  return configured;
}

/** Test-only: drop the memoized path so a self-test can vary the variable. */
export function resetResolvedBinary(): void {
  cached = null;
}
