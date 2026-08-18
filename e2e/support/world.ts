import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCapshelfBinary } from "./binary";
import {
  type CommandResult,
  type RunOptions,
  describeCommand,
  directoryTree,
  isSecretEnvName,
  registerSecret,
  runCommand,
} from "./command";
import { type GitWorld, createGitWorld } from "./git";

/**
 * Directory-name flavors for the path dimension of the environment matrix. The
 * actor workflow is identical in every flavor; only the directory the world
 * lives in changes.
 */
export const PATH_FLAVORS = {
  plain: "stage",
  spaces: "stage with spaces",
  unicode: "stage-ünïcøde-日本語",
} as const;

export type PathFlavor = keyof typeof PATH_FLAVORS;

export interface WorldOptions {
  /**
   * Declared extra environment inputs for one matrix cell. The baseline world
   * carries the allowlist below and nothing else; a cell adds exactly the one
   * input it is named for.
   */
  env?: Readonly<Record<string, string>>;
  pathFlavor?: PathFlavor;
  /**
   * Declared global Git settings for one matrix cell, as `section.key` (or
   * `section.subsection.key`) pairs. The baseline world has an empty global
   * config; a cell adds only the settings it is named for, so a failure names
   * the user condition that caused it.
   */
  gitConfig?: Readonly<Record<string, string>>;
  /** Applied to every command this world starts. */
  timeoutMs?: number;
}

export interface CommandOptions {
  timeoutMs?: number;
  stdin?: string;
  /** Extra inputs for one command, on top of the world environment. */
  env?: Readonly<Record<string, string>>;
  /** Octal file-creation mask for this command, for example "077". */
  umask?: string;
}

export interface World {
  readonly name: string;
  /** Temporary root; removed on success unless KEEP_E2E_TMP=1. */
  readonly root: string;
  /** Where repositories live. Carries the path flavor of this cell. */
  readonly stage: string;
  readonly home: string;
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
  readonly git: GitWorld;
  /** Absolute path under this world's stage directory. */
  path(...parts: string[]): string;
  /** Actor action: run the compiled capshelf executable. */
  capshelf(
    cwd: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  /** Actor action: run any other program, for example git. */
  run(
    cwd: string,
    command: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  describe(result: CommandResult, notes?: readonly string[]): string;
}

/** What the Git helper needs from a world. Keeps the two modules acyclic. */
export interface WorldRunner {
  readonly stage: string;
  path(...parts: string[]): string;
  run(
    cwd: string,
    command: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  describe(result: CommandResult, notes?: readonly string[]): string;
}

/**
 * Per-test budget for a whole scenario, which runs many compiled commands and
 * real Git operations. This is a safety deadline, not a performance
 * assertion — Bun's 5 s default would fail slow filesystems, not defects.
 */
export const E2E_TEST_TIMEOUT_MS = 180_000;

const KEEP_ENV = "KEEP_E2E_TMP";

export function shouldKeepWorlds(): boolean {
  return process.env[KEEP_ENV] === "1";
}

/**
 * Build the child environment from an allowlist rather than from
 * `process.env`. An inherited `CAPSHELF_HOME`, `CODEX_HOME`, `GIT_DIR`,
 * credential helper, or proxy setting would be an undeclared input, and the
 * test would stop describing the user it claims to describe.
 */
function baseEnvironment(paths: {
  home: string;
  gitConfig: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC",
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

/**
 * Render `section.key` / `section.subsection.key` pairs as a Git config file.
 * The subsection is everything between the first and last segment, so
 * `url.https://example.invalid/.insteadOf` keeps its dots.
 */
function renderGitConfig(entries: Readonly<Record<string, string>>): string {
  const sections = new Map<string, string[]>();
  for (const [key, value] of Object.entries(entries)) {
    const parts = key.split(".");
    const section = parts.at(0);
    const name = parts.at(-1);
    if (parts.length < 2 || !section || !name) {
      throw new Error(`git config key needs at least section.key, got: ${key}`);
    }
    const subsection = parts.slice(1, -1).join(".");
    const header = subsection ? `${section} "${subsection}"` : section;
    const lines = sections.get(header) ?? [];
    lines.push(`\t${name} = ${value}`);
    sections.set(header, lines);
  }
  return [...sections]
    .map(([header, lines]) => `[${header}]\n${lines.join("\n")}\n`)
    .join("");
}

export async function createWorld(
  name: string,
  options: WorldOptions = {},
): Promise<World> {
  // Validate the executable before any world exists, so a missing binary
  // fails as a setup error rather than as ten scenario failures.
  const binary = await resolveCapshelfBinary();

  // realpath: on macOS the system temporary directory is a symlink
  // (/var -> /private/var) and capshelf reports resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "capshelf-e2e-")));
  const stage = join(root, PATH_FLAVORS[options.pathFlavor ?? "plain"]);
  const home = join(stage, "home");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const xdgData = join(home, ".local", "share");
  const gitConfig = join(root, "empty.gitconfig");

  await mkdir(stage, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(xdgConfig, { recursive: true });
  await mkdir(xdgCache, { recursive: true });
  await mkdir(xdgData, { recursive: true });
  // An explicit empty file, not /dev/null: every supported platform then has
  // one real path, and a test that wants a named global setting can write to
  // its own copy in its own world.
  await writeFile(gitConfig, renderGitConfig(options.gitConfig ?? {}));

  const env: Record<string, string> = {
    ...baseEnvironment({ home, gitConfig, xdgConfig, xdgCache, xdgData }),
    ...(options.env ?? {}),
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (isSecretEnvName(key)) registerSecret(value);
  }

  const runOptions = (
    cwd: string,
    commandOptions: CommandOptions | undefined,
  ): RunOptions => ({
    cwd,
    env: commandOptions?.env ? { ...env, ...commandOptions.env } : env,
    timeoutMs: commandOptions?.timeoutMs ?? options.timeoutMs,
    stdin: commandOptions?.stdin,
  });

  // `exec` replaces the shell, so the mask applies to the real command and the
  // process group the runner bounds is unchanged.
  const withUmask = (
    command: readonly string[],
    mask: string | undefined,
  ): readonly string[] =>
    mask === undefined
      ? command
      : ["/bin/sh", "-c", `umask ${mask}; exec "$@"`, "sh", ...command];

  const runner: WorldRunner = {
    stage,
    path: (...parts: string[]) => join(stage, ...parts),
    run: (cwd, command, commandOptions) =>
      runCommand(
        withUmask(command, commandOptions?.umask),
        runOptions(cwd, commandOptions),
      ),
    describe: (result, notes) =>
      describeCommand(result, {
        envNames: Object.keys(env),
        preservedWorkspace: shouldKeepWorlds() ? root : null,
        notes,
      }),
  };

  return {
    name,
    root,
    stage,
    home,
    binary,
    env,
    git: createGitWorld(runner),
    path: runner.path,
    capshelf: (cwd, args, commandOptions) =>
      runCommand(
        withUmask([binary, ...args], commandOptions?.umask),
        runOptions(cwd, commandOptions),
      ),
    run: runner.run,
    describe: runner.describe,
  };
}

export async function destroyWorld(world: World): Promise<void> {
  if (shouldKeepWorlds()) {
    process.stderr.write(`kept E2E world: ${world.root}\n`);
    return;
  }
  await rm(world.root, { recursive: true, force: true });
}

/**
 * Each test owns one world and cleans it up in `finally`. On failure the world
 * is described to stderr *before* cleanup, because CI deletes the evidence and
 * keeps only the log.
 */
export async function withWorld<T>(
  name: string,
  body: (world: World) => Promise<T>,
  options: WorldOptions = {},
): Promise<T> {
  const world = await createWorld(name, options);
  try {
    return await body(world);
  } catch (err) {
    process.stderr.write(
      `\nE2E world for "${name}" at failure:\n  root: ${world.root}\n${directoryTree(
        world.stage,
      )
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    throw err;
  } finally {
    await destroyWorld(world);
  }
}
