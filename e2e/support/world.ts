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

export const PATH_FLAVORS = {
  plain: "stage",
  spaces: "stage with spaces",
  unicode: "stage-ünïcøde-日本語",
} as const;

export type PathFlavor = keyof typeof PATH_FLAVORS;

export interface WorldOptions {
  env?: Readonly<Record<string, string>>;
  pathFlavor?: PathFlavor;
  /**
   * A cell adds only the settings it is named for, so a failure names the user
   * condition that caused it.
   */
  gitConfig?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface WorldEnvironment {
  [name: string]: string;
}

export interface CommandOptions {
  timeoutMs?: number;
  stdin?: string;
  env?: Readonly<Record<string, string>>;
  umask?: string;
}

export interface World {
  readonly name: string;
  readonly root: string;
  readonly stage: string;
  readonly home: string;
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
  readonly git: GitWorld;
  path(...parts: string[]): string;
  capshelf(
    cwd: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  run(
    cwd: string,
    command: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  describe(result: CommandResult, notes?: readonly string[]): string;
}

/** Narrow interface that keeps the world and Git modules acyclic. */
export interface WorldRunner {
  readonly stage: string;
  readonly env: Readonly<Record<string, string>>;
  path(...parts: string[]): string;
  run(
    cwd: string,
    command: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  describe(result: CommandResult, notes?: readonly string[]): string;
}

/**
 * Safety deadline for a whole scenario, not a performance assertion; Bun's 5 s
 * default would fail slow filesystems.
 */
export const E2E_TEST_TIMEOUT_MS = 180_000;

const KEEP_ENV = "KEEP_E2E_TMP";

export function shouldKeepWorlds(): boolean {
  return process.env[KEEP_ENV] === "1";
}

/**
 * Allowlist rather than process.env: an inherited variable would be an
 * undeclared input to the test.
 */
function baseEnvironment(paths: {
  home: string;
  gitConfig: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
}): WorldEnvironment {
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
    // Skip the Homebrew update check: a fresh HOME makes it run a cold `brew`
    // every time and ties the lane to the host.
    CAPSHELF_NO_SELF_UPDATE: "1",
  };
}

/**
 * The subsection is everything between first and last segment, so
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
  // An empty file rather than /dev/null gives every platform one real path a
  // test can write to.
  await writeFile(gitConfig, renderGitConfig(options.gitConfig ?? {}));

  const env: WorldEnvironment = {
    ...baseEnvironment({ home, gitConfig, xdgConfig, xdgCache, xdgData }),
    ...options.env,
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
    env,
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
 * Describe the world to stderr before cleanup, because CI deletes the evidence
 * and keeps only the log.
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
