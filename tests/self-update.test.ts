import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "../src/bundled";
import {
  executeSelfUpdateCommand,
  runStartupSelfUpdate,
  shouldRunStartupSelfUpdate,
  type CommandResult,
  type SelfUpdateCommandRunner,
  type SelfUpdateContext,
} from "../src/self-update";

const FORMULA = "genged/tap/capshelf";
const PREFIX = "/opt/homebrew/opt/capshelf";
const ACTIVE_EXECUTABLE = "/usr/local/bin/capshelf";
const MANAGED_EXECUTABLE = `${PREFIX}/bin/capshelf`;
const REAL_EXECUTABLE = "/Cellar/capshelf/0.3.0/bin/capshelf";

class MemorySink {
  text = "";

  write(text: string): void {
    this.text += text;
  }
}

class MockRunner implements SelfUpdateCommandRunner {
  readonly calls: string[][] = [];
  readonly timeoutMs: Array<number | undefined> = [];
  readonly upgrades: string[][] = [];
  private readonly results: Map<string, CommandResult>;
  upgradeResult: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

  constructor(results: Map<string, CommandResult>) {
    this.results = results;
  }

  async capture(
    cmd: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    this.calls.push(cmd);
    this.timeoutMs.push(options.timeoutMs);
    const result = this.results.get(commandKey(cmd));
    if (!result) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `unexpected command: ${cmd.join(" ")}`,
      };
    }
    return result;
  }

  async streamToStderr(cmd: string[]): Promise<CommandResult> {
    this.upgrades.push(cmd);
    return this.upgradeResult;
  }
}

interface ContextFixture {
  context: SelfUpdateContext;
  stdout: MemorySink;
  stderr: MemorySink;
  prompts: string[];
  runner: MockRunner;
}

interface ContextOptions {
  runner?: MockRunner;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  env?: Record<string, string | undefined>;
  promptAnswers?: string[];
  now?: Date;
  cachePath?: string;
  realpaths?: Map<string, string | null>;
  realpath?: (path: string) => Promise<string | null>;
}

async function tempFilePath(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "capshelf-self-update-")),
    "cache.json",
  );
}

async function makeContext(
  options: ContextOptions = {},
): Promise<ContextFixture> {
  const stdout = new MemorySink();
  const stderr = new MemorySink();
  const prompts: string[] = [];
  const answers = [...(options.promptAnswers ?? [])];
  const realpaths =
    options.realpaths ??
    new Map<string, string | null>([
      [ACTIVE_EXECUTABLE, REAL_EXECUTABLE],
      [MANAGED_EXECUTABLE, REAL_EXECUTABLE],
    ]);
  const runner = options.runner ?? new MockRunner(homebrewResults("0.3.1"));

  return {
    context: {
      env: options.env ?? {},
      stdinIsTTY: options.stdinIsTTY ?? true,
      stderrIsTTY: options.stderrIsTTY ?? true,
      activeExecutablePath: ACTIVE_EXECUTABLE,
      cachePath: options.cachePath ?? (await tempFilePath()),
      now: () => options.now ?? new Date("2026-06-05T12:00:00.000Z"),
      prompt: async (message: string) => {
        prompts.push(message);
        return answers.shift() ?? "";
      },
      runner,
      stdout,
      stderr,
      realpath:
        options.realpath ??
        (async (path: string) =>
          realpaths.has(path) ? realpaths.get(path)! : null),
      startupCheckIntervalMs: 24 * 60 * 60 * 1000,
      startupCommandTimeoutMs: 3000,
    },
    stdout,
    stderr,
    prompts,
    runner,
  };
}

function homebrewResults(latestVersion: string): Map<string, CommandResult> {
  return new Map<string, CommandResult>([
    [
      commandKey(["brew", "list", "--formula", FORMULA]),
      { exitCode: 0, stdout: "", stderr: "" },
    ],
    [
      commandKey(["brew", "--prefix", FORMULA]),
      { exitCode: 0, stdout: `${PREFIX}\n`, stderr: "" },
    ],
    [
      commandKey(["brew", "outdated", "--json=v2", "--formula", FORMULA]),
      {
        exitCode: 0,
        stdout: JSON.stringify({
          formulae: [
            {
              name: "capshelf",
              full_name: FORMULA,
              current_version: latestVersion,
            },
          ],
        }),
        stderr: "",
      },
    ],
  ]);
}

function commandKey(cmd: string[]): string {
  return cmd.join("\0");
}

describe("explicit self-update command", () => {
  test("--check reports current/latest/update availability", async () => {
    const { context, stdout } = await makeContext();

    const exitCode = await executeSelfUpdateCommand({ check: true }, context);

    expect(exitCode).toBe(0);
    expect(stdout.text).toBe(
      [
        `current: ${CLI_VERSION}`,
        "latest: 0.3.1",
        "update available: yes",
        "installer: homebrew",
        "",
      ].join("\n"),
    );
  });

  test("--yes runs the Homebrew upgrade when an update exists", async () => {
    const { context, runner, stderr } = await makeContext();

    const exitCode = await executeSelfUpdateCommand({ yes: true }, context);

    expect(exitCode).toBe(0);
    expect(runner.upgrades).toEqual([
      ["brew", "upgrade", "--formula", FORMULA],
    ]);
    expect(stderr.text).toContain("Update ran successfully");
  });

  test("declining the prompt exits cleanly without upgrading", async () => {
    const { context, prompts, runner } = await makeContext({
      promptAnswers: ["n"],
    });

    const exitCode = await executeSelfUpdateCommand({}, context);

    expect(exitCode).toBe(0);
    expect(prompts[0]).toContain("Update via");
    expect(runner.upgrades).toEqual([]);
  });

  test("reports missing Homebrew", async () => {
    const runner = new MockRunner(
      new Map<string, CommandResult>([
        [
          commandKey(["brew", "list", "--formula", FORMULA]),
          { exitCode: 127, stdout: "", stderr: "", notFound: true },
        ],
      ]),
    );
    const { context, stderr } = await makeContext({ runner });

    const exitCode = await executeSelfUpdateCommand({}, context);

    expect(exitCode).toBe(1);
    expect(stderr.text).toContain("Homebrew was not found on PATH");
  });

  test("--check reports source-or-unknown when formula is not installed", async () => {
    const runner = new MockRunner(
      new Map<string, CommandResult>([
        [
          commandKey(["brew", "list", "--formula", FORMULA]),
          { exitCode: 1, stdout: "", stderr: "not installed" },
        ],
      ]),
    );
    const { context, stdout } = await makeContext({ runner });

    const exitCode = await executeSelfUpdateCommand({ check: true }, context);

    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("installer: source-or-unknown");
    expect(stdout.text).toContain("update available: no");
  });

  test("reports source-or-unknown when active executable is not Homebrew-managed", async () => {
    const { context, stderr } = await makeContext({
      realpaths: new Map<string, string | null>([
        [ACTIVE_EXECUTABLE, "/workspace/src/cli.ts"],
        [MANAGED_EXECUTABLE, REAL_EXECUTABLE],
      ]),
    });

    const exitCode = await executeSelfUpdateCommand({}, context);

    expect(exitCode).toBe(1);
    expect(stderr.text).toContain(
      "The running capshelf binary was not installed by Homebrew",
    );
  });

  test("available update exits 1 in non-interactive mode without --yes", async () => {
    const { context, runner, stderr } = await makeContext({
      stdinIsTTY: false,
      stderrIsTTY: false,
    });

    const exitCode = await executeSelfUpdateCommand({}, context);

    expect(exitCode).toBe(1);
    expect(stderr.text).toContain("Run `capshelf self-update --yes`");
    expect(runner.upgrades).toEqual([]);
  });
});

describe("startup self-update prompt", () => {
  test("skips non-TTY startup checks", async () => {
    const { context, runner } = await makeContext({ stdinIsTTY: false });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  test("skips script, CI, help, version, and self-update invocations", async () => {
    const base = await makeContext();
    const skipped = [
      {
        argv: ["capshelf", "src/cli.ts", "status", "--json"],
        env: {},
      },
      {
        argv: ["capshelf", "src/cli.ts", "status"],
        env: { CI: "true" },
      },
      {
        argv: ["capshelf", "src/cli.ts", "status"],
        env: { CAPSHELF_NO_SELF_UPDATE: "1" },
      },
      {
        argv: ["capshelf", "src/cli.ts", "--version"],
        env: {},
      },
      {
        argv: ["capshelf", "src/cli.ts", "status", "--help"],
        env: {},
      },
      {
        argv: ["capshelf", "src/cli.ts", "help", "status"],
        env: {},
      },
      {
        argv: [
          "capshelf",
          "src/cli.ts",
          "--data",
          "./repo",
          "self-update",
          "--check",
        ],
        env: {},
      },
    ];

    for (const item of skipped) {
      expect(
        shouldRunStartupSelfUpdate(item.argv, {
          ...base.context,
          env: item.env,
        }),
      ).toBe(false);
    }
  });

  test("decline continues the original command and writes cache", async () => {
    const cachePath = await tempFilePath();
    const { context, prompts, runner } = await makeContext({
      cachePath,
      promptAnswers: [""],
    });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBeNull();
    expect(prompts).toHaveLength(1);
    expect(runner.upgrades).toEqual([]);
    const cache = JSON.parse(await readFile(cachePath, "utf-8")) as {
      updateAvailable?: boolean;
      installer?: string;
    };
    expect(cache.updateAvailable).toBe(true);
    expect(cache.installer).toBe("homebrew");
  });

  test("unexpected startup check failures continue the original command", async () => {
    const { context, prompts, runner } = await makeContext({
      realpath: async () => {
        throw new Error("permission denied resolving executable");
      },
    });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBeNull();
    expect(prompts).toEqual([]);
    expect(runner.upgrades).toEqual([]);
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  test("accept runs upgrade and skips the original command", async () => {
    const { context, runner } = await makeContext({
      promptAnswers: ["yes"],
    });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBe(0);
    expect(runner.upgrades).toEqual([
      ["brew", "upgrade", "--formula", FORMULA],
    ]);
  });

  test("fresh cache suppresses repeated startup checks", async () => {
    const cachePath = await tempFilePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        checkedAt: "2026-06-05T11:00:00.000Z",
        currentVersion: CLI_VERSION,
        latestVersion: "0.3.1",
        updateAvailable: true,
        installer: "homebrew",
      }),
    );
    const { context, runner } = await makeContext({ cachePath });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  test("stale cache triggers a fresh startup check", async () => {
    const cachePath = await tempFilePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        checkedAt: "2026-06-04T11:00:00.000Z",
        currentVersion: CLI_VERSION,
        latestVersion: CLI_VERSION,
        updateAvailable: false,
        installer: "homebrew",
      }),
    );
    const { context, runner } = await makeContext({
      cachePath,
      promptAnswers: ["n"],
    });

    const exitCode = await runStartupSelfUpdate(
      ["capshelf", "src/cli.ts", "status"],
      context,
    );

    expect(exitCode).toBeNull();
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.timeoutMs.every((value) => value === 3000)).toBe(true);
  });
});
