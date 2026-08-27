import { expect, test } from "bun:test";
import { runInPty } from "../support/pty";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

/**
 * The terminal cell is only meaningful if the child really gets a terminal and
 * the runner really sees its exit status. Both were wrong with the first
 * implementation on one platform, so both are asserted here: a failure names
 * the harness instead of surfacing as a scenario that "did not prompt".
 */
test(
  "a command run through the pty helper sees a terminal on every stream",
  async () => {
    await withWorld("pty-terminal", async (world) => {
      const result = await runInPty(world, world.stage, [
        "/bin/sh",
        "-c",
        "[ -t 0 ] && echo STDIN_TTY; [ -t 1 ] && echo STDOUT_TTY; [ -t 2 ] && echo STDERR_TTY",
      ]);
      expect(result.outcome).toEqual({ kind: "exit", exitCode: 0 });
      expect(result.stdout).toContain("STDIN_TTY");
      expect(result.stdout).toContain("STDOUT_TTY");
      expect(result.stdout).toContain("STDERR_TTY");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "the pty helper reports the command's own exit status",
  async () => {
    await withWorld("pty-exit", async (world) => {
      const result = await runInPty(world, world.stage, [
        "/bin/sh",
        "-c",
        "exit 7",
      ]);
      expect(result.outcome).toEqual({ kind: "exit", exitCode: 7 });
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "an answer written into the terminal reaches the command",
  async () => {
    await withWorld("pty-answer", async (world) => {
      const result = await runInPty(
        world,
        world.stage,
        ["/bin/sh", "-c", 'read reply; echo "reply=[$reply]"'],
        { answer: "yes\n" },
      );
      expect(result.outcome).toEqual({ kind: "exit", exitCode: 0 });
      expect(result.stdout).toContain("reply=[yes]");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * The raw-mode variant. The command sleeps first, so an answer written
 * immediately would sit in the terminal's unfinished-line buffer and be
 * discarded at the raw switch on macOS. The answer arriving intact proves the
 * driver held it until canonical mode was off.
 */
test(
  "an answer held for raw mode arrives after the switch",
  async () => {
    await withWorld("pty-raw-answer", async (world) => {
      const result = await runInPty(
        world,
        world.stage,
        [
          "/bin/sh",
          "-c",
          'sleep 1; stty raw -echo; keys=$(dd bs=1 count=3 2>/dev/null); stty sane; echo "keys=[$keys]"',
        ],
        { answer: "abc", answerAfterRawMode: true },
      );
      expect(result.outcome).toEqual({ kind: "exit", exitCode: 0 });
      expect(result.stdout).toContain("keys=[abc]");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "the reported command is the one under test, not the driver",
  async () => {
    await withWorld("pty-command", async (world) => {
      const result = await runInPty(world, world.stage, [
        "/bin/sh",
        "-c",
        "exit 0",
      ]);
      expect(result.command).toEqual(["/bin/sh", "-c", "exit 0"]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
