import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./command";
import type { CommandOptions, World } from "./world";

/**
 * Run a command with a controlling terminal, so a consent prompt takes its TTY
 * branch instead of the non-interactive refusal every other cell exercises.
 *
 * The pty is opened by `pty-driver.py`. `script(1)` was the first choice and
 * does not work: its arguments differ between util-linux and BSD, and the BSD
 * build reads terminal settings from its own stdin, which the runner supplies
 * as a pipe — it fails with "tcgetattr/ioctl: Operation not supported on
 * socket" before the command under test starts.
 *
 * The captured output is what a terminal produces, so it carries echo and CR
 * line endings. Assert on substrings, never on exact bytes.
 */
const DRIVER = join(import.meta.dir, "pty-driver.py");

export interface PtyOptions extends CommandOptions {
  /** Sent into the terminal before output is read. */
  answer?: string;
  /**
   * Hold the answer until the command turns canonical mode off. A raw-mode
   * answer has no newline, so a write before the switch leaves it in the
   * terminal's unfinished-line buffer, and macOS discards that buffer at the
   * switch. Set this for a full-screen prompt; leave it off for a canonical
   * one, which never leaves canonical mode.
   */
  answerAfterRawMode?: boolean;
  /**
   * Staged raw-mode input. A step can wait for terminal output before it
   * sends more keys. Use this for an asynchronous pane inside one prompt.
   */
  interactions?: Array<{ send: string; waitFor?: string }>;
}

export async function runInPty(
  world: World,
  cwd: string,
  command: readonly string[],
  options: PtyOptions = {},
): Promise<CommandResult> {
  if (options.answer !== undefined && options.interactions !== undefined) {
    throw new Error("a PTY run cannot use both answer and interactions");
  }
  let inputPath = "-";
  if (options.interactions !== undefined) {
    inputPath = join(world.root, `pty-script-${process.pid}-${command.length}`);
    await writeFile(inputPath, JSON.stringify(options.interactions));
  } else if (options.answer !== undefined) {
    inputPath = join(world.root, `pty-answer-${process.pid}-${command.length}`);
    await writeFile(inputPath, options.answer);
  }

  const flags = options.interactions
    ? ["--interactions-after-raw"]
    : options.answerAfterRawMode
      ? ["--answer-after-raw"]
      : [];
  const result = await world.run(
    cwd,
    ["python3", DRIVER, ...flags, inputPath, ...command],
    options,
  );
  if (result.outcome.kind === "spawn-error") {
    throw new Error(
      "the terminal cell needs python3 to allocate a pseudo-terminal: " +
        `${result.outcome.message}`,
    );
  }
  if (
    result.outcome.kind === "exit" &&
    result.outcome.exitCode === 2 &&
    result.stderr.includes("usage: pty-driver.py")
  ) {
    throw new Error(`the pty driver was called wrongly: ${result.stderr}`);
  }
  // Report the command under test, not the driver, so a diagnostic names what
  // a user would run.
  return { ...result, command };
}
