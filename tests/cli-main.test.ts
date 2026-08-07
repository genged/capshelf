import { $ } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli";

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe("in-process CLI entry point", () => {
  test("prepared data commands return usage exit codes without exiting", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    try {
      for (const [args, exitCode] of [
        [["data", "bind", "--help"], 0],
        [["data", "bind"], 1],
        [["set-data", "--help"], 0],
        [["set-data"], 1],
      ] as const) {
        expect(await main([process.execPath, "capshelf", ...args])).toBe(
          exitCode,
        );
      }
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test("does not retain global options between main calls", async () => {
    const cwd = await tempDir("capshelf-main-cwd-");
    const home = await tempDir("capshelf-main-home-");
    const dataRepo = await tempDir("capshelf-main-data-");
    await $`git -C ${dataRepo} init -q`.quiet();

    const previousCwd = process.cwd();
    const previousEnv = new Map(
      ["HOME", "CODEX_HOME", "CAPSHELF_HOME", "AGENTSHARE_HOME"].map(
        (name) => [name, process.env[name]] as const,
      ),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...values) => {
      stdout.push(values.map(String).join(" "));
    });
    const errorSpy = spyOn(console, "error").mockImplementation((...values) => {
      stderr.push(values.map(String).join(" "));
    });
    // The --json error envelope is written straight to the stream rather than
    // through console.error, so that Bun cannot colorize it. Capture both
    // channels, the same way runInProcess does.
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        stderr.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    );

    try {
      process.chdir(cwd);
      process.env.HOME = home;
      process.env.CODEX_HOME = join(home, ".codex");
      process.env.CAPSHELF_HOME = "";
      process.env.AGENTSHARE_HOME = "";

      expect(
        await main([
          process.execPath,
          "capshelf",
          "--data",
          dataRepo,
          "ls",
          "--json",
        ]),
      ).toBe(0);
      expect(stdout.at(-1)).toContain(`"dataRepo": "${dataRepo}"`);

      expect(await main([process.execPath, "capshelf", "ls", "--json"])).toBe(
        6,
      );
      expect(stderr.at(-1)).toContain("no data repo configured");
    } finally {
      process.chdir(previousCwd);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      logSpy.mockRestore();
      errorSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
