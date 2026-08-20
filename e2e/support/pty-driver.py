#!/usr/bin/env python3
"""Run a command with a real terminal on its standard streams.

The terminal cell needs a consent prompt to take its TTY branch. Neither Bun
nor Node can allocate a pseudo-terminal, and script(1) cannot stand in for one:
util-linux and BSD take different arguments, and the BSD build reads the
terminal settings from its *own* stdin, which a test runner never gives it
("tcgetattr/ioctl: Operation not supported on socket"). Opening the pty here
removes both problems and leaves one code path for every platform.

Usage: pty-driver.py <input-file|-> <command> [args...]

The input file is written into the terminal before the command's output is
read; "-" sends nothing. Output is the merged stream, as a terminal produces
it, so it carries echo and CR line endings. The exit status is the command's,
or 128+N when a signal ended it.
"""

import os
import pty
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: pty-driver.py <input-file|-> <command> [args...]\n")
        return 2

    input_path = sys.argv[1]
    command = sys.argv[2:]
    answer = b""
    if input_path != "-":
        with open(input_path, "rb") as handle:
            answer = handle.read()

    master, slave = pty.openpty()
    # No new session: the child stays in the process group the test runner
    # created, so the runner's deadline can still bound the whole tree.
    process = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)

    if answer:
        os.write(master, answer)

    output = bytearray()
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
