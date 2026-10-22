import { $ } from "bun";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fixture setup for real Git repositories, with as few Git processes as
 * possible. The unit suite is bound by process starts, not by computation.
 * One `git config` per setting was about a seventh of all Git processes in
 * a run, so these helpers write the settings into `.git/config` directly.
 * This module imports nothing from `src/`, so a light test file can use it
 * without loading the CLI.
 */

/** A Git config value, quoted so that spaces, `#`, and `;` stay literal. */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const IDENTITY =
  '[user]\n\temail = "capshelf@example.invalid"\n\tname = "capshelf"\n';

/**
 * Give an existing repository the fixture identity. Use it for a clone. The
 * repository must have `.git` as a directory, which `git init` and
 * `git clone` both produce.
 */
export async function setTestIdentity(repo: string): Promise<void> {
  await appendFile(join(repo, ".git", "config"), IDENTITY);
}

/**
 * `git init` in an existing directory, plus the fixture identity, plus an
 * `origin` remote when one is named. The result is the same as
 * `git remote add origin <url>`.
 */
export async function initRepo(
  repo: string,
  opts: { origin?: string } = {},
): Promise<void> {
  await $`git -C ${repo} init -q`.quiet();
  let config = IDENTITY;
  if (opts.origin !== undefined) {
    config +=
      '[remote "origin"]\n' +
      `\turl = ${quoted(opts.origin)}\n` +
      "\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
  }
  await appendFile(join(repo, ".git", "config"), config);
}
