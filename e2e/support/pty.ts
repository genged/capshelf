import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "./command";
import type { CommandOptions, World } from "./world";

/**
 * script(1) is not used: BSD's reads terminal settings from its stdin, a pipe
 * here, and fails with tcgetattr/ioctl errors. Output carries echo and CR line
 * endings, so assert on substrings.
 */
const DRIVER = join(import.meta.dir, "pty-driver.py");

export interface PtyOptions extends CommandOptions {
  answer?: string;
  /**
   * A raw-mode answer has no newline, so macOS discards it from the terminal's
   * line buffer if written before the switch out of canonical mode.
   */
  answerAfterRawMode?: boolean;
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
