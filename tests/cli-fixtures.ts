import { $ } from "bun";
import { mkdtemp, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

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
