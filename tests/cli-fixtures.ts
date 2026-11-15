import { $ } from "bun";
import { spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli";
import { initRepo } from "./git-fixtures";
import { isConfigObject, isConfigString } from "../src/config-values";
import type { ConfigObject, ConfigValue } from "../src/config-values";
import { parseJsonConfigObject, parseJsonc } from "../src/json-fragments";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import type { DestructiveConfirmationContext } from "../src/destructive-change";
import { setPickContext } from "../src/pick";
import type { PickContext } from "../src/pick";

// Multi-command lifecycle tests on real Git repos can exceed Bun's 5-second
// default on macOS filesystems.
export const CLI_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

// The default macOS volume folds case, so tests placing two case variants side
// by side must skip there.
export const tmpdirFoldsCase = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "capshelf-case-probe-"));
  try {
    writeFileSync(join(dir, "A"), "");
    return existsSync(join(dir, "a"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

export async function tempDir(prefix: string): Promise<string> {
  // On macOS tmpdir() is a symlink (/var -> /private/var) and the CLI reports
  // resolved paths.
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function tempRepo(
  prefix: string,
  opts: { origin?: string | null } = {},
): Promise<string> {
  const repo = await tempDir(prefix);
  const origin =
    opts.origin === undefined
      ? `https://example.invalid/${basename(repo)}`
      : opts.origin;
  await initRepo(repo, origin === null ? {} : { origin });
  return repo;
}

export async function baselineRepo(prefix: string): Promise<string> {
  const repo = await tempRepo(prefix, { origin: null });
  await writeFile(join(repo, "README.md"), "baseline\n");
  await commitAll(repo, "baseline");
  return repo;
}

export async function addSkill(
  dataRepo: string,
  name: string,
  content = `${name}\n`,
): Promise<string> {
  const root = join(dataRepo, "skills", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), content);
  return root;
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

export function jsonOutput(result: CliResult): ConfigObject {
  const value = parseJsonc(result.stdout.toString());
  if (!isConfigObject(value)) {
    throw new Error(`stdout is not a JSON object: ${result.stdout.toString()}`);
  }
  return value;
}

export function jsonRows(result: CliResult): ConfigObject[] {
  const value = parseJsonc(result.stdout.toString());
  if (!Array.isArray(value)) {
    throw new Error(`stdout is not a JSON array: ${result.stdout.toString()}`);
  }
  return value.map((item, index) => {
    if (!isConfigObject(item)) {
      throw new Error(`row ${index} is not an object: ${JSON.stringify(item)}`);
    }
    return item;
  });
}

export async function readJsonObject(path: string): Promise<ConfigObject> {
  return parseJsonConfigObject(await readFile(path, "utf-8"), path);
}

export function objectField(object: ConfigObject, key: string): ConfigObject {
  const value = object[key];
  if (!isConfigObject(value)) {
    throw new Error(`"${key}" is not an object: ${JSON.stringify(object)}`);
  }
  return value;
}

export function arrayField(object: ConfigObject, key: string): ConfigValue[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new Error(`"${key}" is not an array: ${JSON.stringify(object)}`);
  }
  return value;
}

export function stringField(object: ConfigObject, key: string): string {
  const value = object[key];
  if (!isConfigString(value)) {
    throw new Error(`"${key}" is not a string: ${JSON.stringify(object)}`);
  }
  return value;
}

export function objectItems(object: ConfigObject, key: string): ConfigObject[] {
  return arrayField(object, key).map((item, index) => {
    if (!isConfigObject(item)) {
      throw new Error(`"${key}"[${index}] is not an object`);
    }
    return item;
  });
}

const RESOLVED = Symbol("resolved");

export async function rejection<T extends Error, R>(
  promise: Promise<R>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  const outcome = await promise.then(
    () => RESOLVED,
    (cause: unknown) => cause,
  );
  if (outcome === RESOLVED) {
    throw new Error(`expected ${type.name}, but the promise resolved`);
  }
  if (!(outcome instanceof type)) {
    const name =
      outcome instanceof Error ? outcome.constructor.name : String(outcome);
    throw new Error(`expected ${type.name}, got ${name}`);
  }
  return outcome;
}

export function runIn(project: string) {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  return (args: string[]) =>
    Bun.spawnSync({
      cmd: [process.execPath, cli, ...args],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
}

export interface CliResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * runInProcess shares the developer's terminal, so without pinning
 * non-interactive the consent prompt would block on readline forever under an
 * interactive `bun test`.
 */
const NON_INTERACTIVE_CONFIRMATION: DestructiveConfirmationContext = {
  stdinIsTTY: false,
  stderrIsTTY: false,
  prompt: async () => {
    throw new Error(
      "runInProcess is non-interactive; install a context with setDestructiveConfirmationContext to test the prompt",
    );
  },
  stderr: { write: () => true },
};

/**
 * Pinned non-interactive so `bun test` from a terminal doesn't draw the picker
 * and block on a keypress; tests exercising the picker install their own
 * context.
 */
const NON_INTERACTIVE_PICK: PickContext = {
  stdinIsTTY: false,
  stderrIsTTY: false,
  prompt: async () => {
    throw new Error(
      "runInProcess is non-interactive; install a context with setPickContext to test the picker",
    );
  },
};

export function runInProcess(project: string) {
  return async (
    args: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<CliResult> => {
    const previousCwd = process.cwd();
    const outerConfirmation = setDestructiveConfirmationContext(null);
    setDestructiveConfirmationContext(
      outerConfirmation ?? NON_INTERACTIVE_CONFIRMATION,
    );
    const outerPick = setPickContext(null);
    setPickContext(outerPick ?? NON_INTERACTIVE_PICK);
    const previousEnv = new Map(
      Object.keys(env).map((name) => [name, process.env[name]] as const),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...values) => {
      stdout.push(`${values.map(String).join(" ")}\n`);
    });
    const errorSpy = spyOn(console, "error").mockImplementation((...values) => {
      stderr.push(`${values.map(String).join(" ")}\n`);
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        stdout.push(
          chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : chunk,
        );
        return true;
      },
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        stderr.push(
          chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : chunk,
        );
        return true;
      },
    );

    try {
      process.chdir(project);
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const exitCode = await main([process.execPath, "capshelf", ...args]);
      return {
        exitCode,
        stdout: Buffer.from(stdout.join("")),
        stderr: Buffer.from(stderr.join("")),
      };
    } finally {
      process.chdir(previousCwd);
      setDestructiveConfirmationContext(outerConfirmation);
      setPickContext(outerPick);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      logSpy.mockRestore();
      errorSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}
