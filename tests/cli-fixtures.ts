import { $ } from "bun";
import { spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli";

export async function tempDir(prefix: string): Promise<string> {
  // realpath: on macOS tmpdir() is a symlink (/var -> /private/var); the CLI
  // reports resolved paths, so tests must compare against the resolved form.
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function tempRepo(
  prefix: string,
  opts: { origin?: string | null } = {},
): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  const origin =
    opts.origin === undefined
      ? `https://example.invalid/${basename(repo)}`
      : opts.origin;
  if (origin !== null) {
    await $`git -C ${repo} remote add origin ${origin}`.quiet();
  }
  return repo;
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

export function runIn(project: string) {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  return (args: string[]) =>
    Bun.spawnSync({
      cmd: [process.execPath, cli, ...args],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
}

export interface CliResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function runInProcess(project: string) {
  return async (
    args: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<CliResult> => {
    const previousCwd = process.cwd();
    const previousEnv = new Map(
      Object.keys(env).map((name) => [name, process.env[name]] as const),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...values) => {
      stdout.push(`${values.map(String).join(" ")}\n`);
    });
    const errorSpy = spyOn(console, "error").mockImplementation((...values) => {
      stderr.push(`${values.map(String).join(" ")}\n`);
    });
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        stdout.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        stderr.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    );

    try {
      process.chdir(project);
      for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const exitCode = await main([process.execPath, "capshelf", ...args]);
      return {
        exitCode,
        stdout: Buffer.from(stdout.join("")),
        stderr: Buffer.from(stderr.join("")),
      };
    } finally {
      process.chdir(previousCwd);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      logSpy.mockRestore();
      errorSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}
