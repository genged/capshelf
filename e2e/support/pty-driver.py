#!/usr/bin/env python3
"""Run a command with a real terminal on its standard streams.

The terminal cell needs a consent prompt to take its TTY branch. Neither Bun
nor Node can allocate a pseudo-terminal, and script(1) cannot stand in for one:
util-linux and BSD take different arguments, and the BSD build reads the
terminal settings from its *own* stdin, which a test runner never gives it
("tcgetattr/ioctl: Operation not supported on socket"). Opening the pty here
removes both problems and leaves one code path for every platform.

Usage: pty-driver.py [--answer-after-raw] <input-file|-> <command> [args...]

The input file is written into the terminal before the command's output is
read; "-" sends nothing. Output is the merged stream, as a terminal produces
it, so it carries echo and CR line endings. The exit status is the command's,
or 128+N when a signal ended it.

The terminal is given a window size, and carriage-return translation is turned
off. Both settings exist for the same reason: the defaults of a bare pty are
not what a real terminal gives an application, and a line-oriented prompt never
noticed, so neither omission showed up until an interactive list was tested.

A pty opened without a window size reports zero rows and columns, which no real
terminal does. A full-screen prompt asked to lay out inside zero columns
renders one character per line and never finishes.

`ICRNL` rewrites a carriage return to a newline on the way in. A real terminal
sends CR when Enter is pressed, and an application in raw mode reads that CR;
only a canonical-mode reader sees the translated newline. Because the answer is
written before the command can configure the terminal, the translation would
apply to a full-screen prompt as well, and Node reports CR and LF as two
different keys — so Enter silently stopped being Enter. With translation off,
"\r" in an answer means Enter for either kind of prompt, and "\n" still ends a
line for a canonical one.

`--answer-after-raw` holds the answer until the command turns canonical mode
off, and only then writes it. An answer for a raw-mode prompt has no newline,
so an early write leaves it in the terminal's unfinished-line buffer, and on
macOS the switch to raw mode discards that buffer. The prompt then draws an
empty query and waits forever. An answer for a canonical prompt ends with a
newline, is a complete line, and survives the wait, so the flag is only for
raw-mode prompts. The driver keeps its copy of the slave descriptor open while
it waits, because the terminal's mode can only be read through one.
"""

import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios

# The classic default. Any realistic value works; zero does not.
TERMINAL_ROWS = 24
TERMINAL_COLUMNS = 80

# How often the wait for raw mode re-checks the terminal, in seconds.
RAW_POLL_INTERVAL = 0.02


def main() -> int:
    arguments = sys.argv[1:]
    answer_after_raw = False
    if arguments and arguments[0] == "--answer-after-raw":
        answer_after_raw = True
        arguments = arguments[1:]
    if len(arguments) < 2:
        sys.stderr.write(
            "usage: pty-driver.py [--answer-after-raw] <input-file|-> <command> [args...]\n"
        )
        return 2

    input_path = arguments[0]
    command = arguments[1:]
    answer = b""
    if input_path != "-":
        with open(input_path, "rb") as handle:
            answer = handle.read()

    master, slave = pty.openpty()
    fcntl.ioctl(
        slave,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", TERMINAL_ROWS, TERMINAL_COLUMNS, 0, 0),
    )
    attributes = termios.tcgetattr(slave)
    attributes[0] &= ~(termios.ICRNL | termios.INLCR | termios.IGNCR)
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    # No new session: the child stays in the process group the test runner
    # created, so the runner's deadline can still bound the whole tree.
    process = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )

    output = bytearray()
    pending = answer if answer and answer_after_raw else b""
    if answer and not pending:
        os.write(master, answer)
    if pending:
        # Output is drained while waiting, so a chatty command cannot fill the
        # terminal's buffer and block before it ever reaches its prompt. A
        # command that exits without raw mode ends the wait; the answer is
        # then undeliverable and is dropped.
        while pending:
            ready, _, _ = select.select([master], [], [], RAW_POLL_INTERVAL)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
                continue
            if not termios.tcgetattr(slave)[3] & termios.ICANON:
                os.write(master, pending)
                pending = b""
            elif process.poll() is not None:
                break
    os.close(slave)

    while True:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            # Linux raises EIO when the last slave descriptor closes.
            break
        if not chunk:
            # macOS reports the same condition as end of file.
            break
        output += chunk

    os.close(master)
    status = process.wait()
    sys.stdout.buffer.write(bytes(output))
    sys.stdout.buffer.flush()
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
