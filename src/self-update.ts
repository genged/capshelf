import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { CLI_VERSION } from "./bundled";
import { atomicWriteFile, isErrno } from "./fs-utils";

const HOMEBREW_FORMULA = "genged/tap/capshelf";
const UPDATE_COMMAND = `brew upgrade --formula ${HOMEBREW_FORMULA}`;
const STARTUP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_COMMAND_TIMEOUT_MS = 3000;

const OutdatedFormulaSchema = z
  .object({
    name: z.string().optional(),
    full_name: z.string().optional(),
    current_version: z.string().optional(),
    current_versions: z.array(z.string()).optional(),
  })
  .passthrough();

const OutdatedSchema = z
  .object({
    formulae: z.array(OutdatedFormulaSchema).optional(),
  })
  .passthrough();

const CacheSchema = z.object({
  checkedAt: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  updateAvailable: z.boolean(),
  installer: z.enum(["homebrew", "source-or-unknown"]),
});

export type SelfUpdateInstaller = "homebrew" | "source-or-unknown";

export interface SelfUpdateStatus {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installer: SelfUpdateInstaller;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

export interface SelfUpdateCommandRunner {
  capture(
    cmd: string[],
    options?: { timeoutMs?: number },
  ): Promise<CommandResult>;
  streamToStderr(cmd: string[]): Promise<CommandResult>;
}

export interface TextSink {
  write(text: string): void;
}

export interface SelfUpdateContext {
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  activeExecutablePath: string;
  cachePath: string;
  now: () => Date;
  prompt: (message: string) => Promise<string>;
  runner: SelfUpdateCommandRunner;
  stdout: TextSink;
  stderr: TextSink;
  realpath: (path: string) => Promise<string | null>;
  startupCheckIntervalMs: number;
  startupCommandTimeoutMs: number;
}

interface FreshCheckOptions {
  timeoutMs?: number;
}

type FreshCheckResult =
  | { ok: true; status: SelfUpdateStatus }
  | { ok: false; message: string };

type InstallerDetection =
  | { kind: "homebrew" }
  | { kind: "source-or-unknown" }
  | { kind: "error"; message: string };

export interface SelfUpdateCommandOptions {
  yes?: boolean;
  check?: boolean;
}

export function defaultSelfUpdateContext(
  argv: string[] = process.argv,
): SelfUpdateContext {
  return {
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    activeExecutablePath: argv[1] ?? process.execPath,
    cachePath: selfUpdateCachePath(process.env),
    now: () => new Date(),
    prompt: defaultPrompt,
    runner: defaultSelfUpdateRunner,
    stdout: process.stdout,
    stderr: process.stderr,
    realpath: realpathOrNull,
    startupCheckIntervalMs: STARTUP_CHECK_INTERVAL_MS,
    startupCommandTimeoutMs: STARTUP_COMMAND_TIMEOUT_MS,
  };
}

export async function executeSelfUpdateCommand(
  options: SelfUpdateCommandOptions,
  context: SelfUpdateContext = defaultSelfUpdateContext(),
): Promise<number> {
  const fresh = await checkSelfUpdateFresh(context);
  if (!fresh.ok) {
    context.stderr.write(`${fresh.message}\n`);
    return 1;
  }

  const status = fresh.status;
  if (options.check) {
    context.stdout.write(formatCheckStatus(status));
    return 0;
  }

  if (status.installer === "source-or-unknown") {
    context.stderr.write(
      "The running capshelf binary was not installed by Homebrew.\n",
    );
    context.stderr.write(
      `Install Capshelf with Homebrew: brew install ${HOMEBREW_FORMULA}\n`,
    );
    return 1;
  }

  if (!status.updateAvailable) {
    context.stdout.write(`Capshelf is up to date: ${status.currentVersion}.\n`);
    return 0;
  }

  if (options.yes) {
    return await runUpgrade(context);
  }

  if (!context.stdinIsTTY || !context.stderrIsTTY) {
    context.stderr.write(formatAvailableNotice(status));
    context.stderr.write(
      "Run `capshelf self-update --yes` to update non-interactively.\n",
    );
    return 1;
  }

  if (!(await promptForUpdate(context, status))) return 0;
  return await runUpgrade(context);
}

export async function runStartupSelfUpdate(
  argv: string[] = process.argv,
  context: SelfUpdateContext = defaultSelfUpdateContext(argv),
): Promise<number | null> {
  if (!shouldRunStartupSelfUpdate(argv, context)) return null;

  const cache = await readStartupCache(context);
  if (cache.kind === "fresh" || cache.kind === "unusable") return null;

  let fresh: FreshCheckResult;
  try {
    fresh = await checkSelfUpdateFresh(context, {
      timeoutMs: context.startupCommandTimeoutMs,
    });
  } catch {
    return null;
  }
  if (!fresh.ok) return null;

  await writeStartupCache(context, fresh.status);
  if (fresh.status.installer !== "homebrew" || !fresh.status.updateAvailable) {
    return null;
  }

  let accepted: boolean;
  try {
    accepted = await promptForUpdate(context, fresh.status);
  } catch {
    return null;
  }
  if (!accepted) return null;
  return await runUpgrade(context);
}

export function shouldRunStartupSelfUpdate(
  argv: string[],
  context: SelfUpdateContext,
): boolean {
  if (!context.stdinIsTTY || !context.stderrIsTTY) return false;
  if (context.env.CI !== undefined) return false;
  if (context.env.NODE_ENV === "test") return false;
  if (context.env.CAPSHELF_NO_SELF_UPDATE !== undefined) return false;
  if (argv.some((arg) => arg === "--json" || arg.startsWith("--json="))) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V",
    )
  ) {
    return false;
  }

  const command = firstCommandToken(argv);
  if (command === undefined) return false;
  if (command === "help" || command === "self-update") return false;
  return true;
}

export function selfUpdateCachePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "capshelf", "self-update.json");
}

async function checkSelfUpdateFresh(
  context: SelfUpdateContext,
  options: FreshCheckOptions = {},
): Promise<FreshCheckResult> {
  const checkedAt = context.now().toISOString();
  const installer = await detectInstaller(context, options);
  if (installer.kind === "error") {
    return { ok: false, message: installer.message };
  }
  if (installer.kind === "source-or-unknown") {
    return {
      ok: true,
      status: {
        checkedAt,
        currentVersion: CLI_VERSION,
        latestVersion: CLI_VERSION,
        updateAvailable: false,
        installer: "source-or-unknown",
      },
    };
  }

  const outdated = await runBrewCapture(
    context,
    ["outdated", "--json=v2", "--formula", HOMEBREW_FORMULA],
    options,
  );
  if (outdated.notFound) {
    return { ok: false, message: "Homebrew was not found on PATH." };
  }
  if (outdated.exitCode !== 0) {
    return {
      ok: false,
      message: homebrewFailureMessage(
        "checking for outdated Capshelf",
        outdated,
      ),
    };
  }

  let parsed: z.infer<typeof OutdatedSchema>;
  try {
    parsed = OutdatedSchema.parse(JSON.parse(outdated.stdout));
  } catch (err) {
    return {
      ok: false,
      message: `Could not parse Homebrew outdated output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const formula = (parsed.formulae ?? []).find((entry) =>
    isCapshelfFormula(entry),
  );
  if (!formula) {
    return {
      ok: true,
      status: {
        checkedAt,
        currentVersion: CLI_VERSION,
        latestVersion: CLI_VERSION,
        updateAvailable: false,
        installer: "homebrew",
      },
    };
  }

  const latestVersion =
    formula.current_version ?? formula.current_versions?.[0];
  if (!latestVersion) {
    return {
      ok: false,
      message: "Homebrew outdated output did not include a latest version.",
    };
  }

  const updateAvailable = compareStableVersions(latestVersion, CLI_VERSION) > 0;
  return {
    ok: true,
    status: {
      checkedAt,
      currentVersion: CLI_VERSION,
      latestVersion,
      updateAvailable,
      installer: "homebrew",
    },
  };
}

async function detectInstaller(
  context: SelfUpdateContext,
  options: FreshCheckOptions,
): Promise<InstallerDetection> {
  const list = await runBrewCapture(
    context,
    ["list", "--formula", HOMEBREW_FORMULA],
    options,
  );
  if (list.notFound) {
    return { kind: "error", message: "Homebrew was not found on PATH." };
  }
  if (list.exitCode !== 0) return { kind: "source-or-unknown" };

  const prefix = await runBrewCapture(
    context,
    ["--prefix", HOMEBREW_FORMULA],
    options,
  );
  if (prefix.notFound) {
    return { kind: "error", message: "Homebrew was not found on PATH." };
  }
  if (prefix.exitCode !== 0) {
    return {
      kind: "error",
      message: homebrewFailureMessage(
        "detecting the Capshelf formula prefix",
        prefix,
      ),
    };
  }

  const formulaPrefix = prefix.stdout.trim();
  if (!formulaPrefix) {
    return {
      kind: "error",
      message: "Homebrew did not report a Capshelf formula prefix.",
    };
  }

  const activeExecutable = await context.realpath(context.activeExecutablePath);
  const managedExecutable = await context.realpath(
    join(formulaPrefix, "bin", "capshelf"),
  );
  if (
    activeExecutable === null ||
    managedExecutable === null ||
    activeExecutable !== managedExecutable
  ) {
    return { kind: "source-or-unknown" };
  }

  return { kind: "homebrew" };
}

async function runUpgrade(context: SelfUpdateContext): Promise<number> {
  context.stderr.write(`Updating Capshelf via \`${UPDATE_COMMAND}\`...\n`);
  const result = await context.runner.streamToStderr([
    "brew",
    "upgrade",
    "--formula",
    HOMEBREW_FORMULA,
  ]);
  if (result.notFound) {
    context.stderr.write("Homebrew was not found on PATH.\n");
    return 1;
  }
  if (result.exitCode !== 0) {
    context.stderr.write(
      `${homebrewFailureMessage("upgrading Capshelf", result)}\n`,
    );
    return 1;
  }
  context.stderr.write("Update ran successfully. Please restart Capshelf.\n");
  return 0;
}

async function promptForUpdate(
  context: SelfUpdateContext,
  status: SelfUpdateStatus,
): Promise<boolean> {
  const answer = await context.prompt(
    `${formatAvailableNotice(status)}Update via \`${UPDATE_COMMAND}\` now? [y/N] `,
  );
  return /^(y|yes)$/i.test(answer.trim());
}

function formatAvailableNotice(status: SelfUpdateStatus): string {
  return `Capshelf ${status.latestVersion} is available; current version is ${status.currentVersion}.\n`;
}

function formatCheckStatus(status: SelfUpdateStatus): string {
  return [
    `current: ${status.currentVersion}`,
    `latest: ${status.latestVersion}`,
    `update available: ${status.updateAvailable ? "yes" : "no"}`,
    `installer: ${status.installer}`,
    "",
  ].join("\n");
}

function homebrewFailureMessage(action: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const suffix = detail ? `\n${detail}` : "";
  return `Homebrew failed while ${action}.${suffix}`;
}

function isCapshelfFormula(
  formula: z.infer<typeof OutdatedFormulaSchema>,
): boolean {
  return (
    formula.full_name === HOMEBREW_FORMULA ||
    formula.name === HOMEBREW_FORMULA ||
    formula.name === "capshelf"
  );
}

function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i]! - b[i]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseStableVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match)
    throw new Error(`expected stable semantic version, got ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function firstCommandToken(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (arg === "--data" || arg === "-d") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--data=")) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

async function runBrewCapture(
  context: SelfUpdateContext,
  args: string[],
  options: FreshCheckOptions,
): Promise<CommandResult> {
  return await context.runner.capture(["brew", ...args], {
    timeoutMs: options.timeoutMs,
  });
}

type StartupCacheRead =
  | { kind: "fresh"; status: SelfUpdateStatus }
  | { kind: "stale" }
  | { kind: "unusable" };

async function readStartupCache(
  context: SelfUpdateContext,
): Promise<StartupCacheRead> {
  let raw: string;
  try {
    raw = await readFile(context.cachePath, "utf-8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { kind: "stale" };
    return { kind: "unusable" };
  }

  let parsed: z.infer<typeof CacheSchema>;
  try {
    parsed = CacheSchema.parse(JSON.parse(raw));
  } catch {
    return { kind: "stale" };
  }

  const checkedAtMs = Date.parse(parsed.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return { kind: "stale" };
  if (context.now().getTime() - checkedAtMs >= context.startupCheckIntervalMs) {
    return { kind: "stale" };
  }
  return { kind: "fresh", status: parsed };
}

async function writeStartupCache(
  context: SelfUpdateContext,
  status: SelfUpdateStatus,
): Promise<void> {
  try {
    await mkdir(dirname(context.cachePath), { recursive: true });
    await atomicWriteFile(
      context.cachePath,
      `${JSON.stringify(status, null, 2)}\n`,
    );
  } catch {
    // Cache writes are best-effort and must not affect command execution.
  }
}

async function defaultPrompt(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

const defaultSelfUpdateRunner: SelfUpdateCommandRunner = {
  async capture(
    cmd: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    try {
      const proc = Bun.spawn({
        cmd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        return { exitCode: 127, stdout: "", stderr: "", notFound: true };
      }
      throw err;
    }
  },

  async streamToStderr(cmd: string[]): Promise<CommandResult> {
    try {
      const proc = Bun.spawn({
        cmd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([
        proc.exited,
        pipeToStderr(proc.stdout),
        pipeToStderr(proc.stderr),
      ]);
      return { exitCode, stdout: "", stderr: "" };
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        return { exitCode: 127, stdout: "", stderr: "", notFound: true };
      }
      throw err;
    }
  },
};

async function streamToText(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function pipeToStderr(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) return;
      process.stderr.write(read.value);
    }
  } finally {
    reader.releaseLock();
  }
}
