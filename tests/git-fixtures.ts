import { $ } from "bun";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes settings straight into `.git/config` because one `git config` per
 * setting was about a seventh of all Git processes in a run, and the suite is
 * bound by process starts.
 */

/**
 * Quote the value so spaces, `#`, and `;` stay literal, since Git config
 * otherwise treats `#` and `;` as comment starts.
 */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const IDENTITY =
  '[user]\n\temail = "capshelf@example.invalid"\n\tname = "capshelf"\n';

/**
 * Requires `.git` to be a directory, since this appends to `.git/config`
 * directly.
 */
export async function setTestIdentity(repo: string): Promise<void> {
  await appendFile(join(repo, ".git", "config"), IDENTITY);
}

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
