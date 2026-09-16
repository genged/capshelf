/**
 * The world a remote-skill test runs in: a local bare repository standing in
 * for a host, a project with its own cache root, and the tools to move the
 * upstream under a pinned project.
 *
 * `git clone` from github.com returns HTTP 403 in the project container, and
 * the harness rule is to use a local bare repository for every fetch
 * (`docs/testing.md`). Every upstream here is one.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addSkill,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

export interface Upstream {
  /** The clone URL a test passes to `capshelf add`. */
  url: string;
  /** A working clone that pushes to the bare repository. */
  work: string;
}

export function skillText(
  name: string,
  description: string,
  body = "body",
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

/** A bare repository holding one skill per entry, on branch `main`. */
export async function upstreamWith(
  dirs: ReadonlyArray<readonly [string, string]>,
): Promise<Upstream> {
  const work = await tempRepo("capshelf-remote-src-", { origin: null });
  for (const [dir, description] of dirs) {
    await mkdir(join(work, dir), { recursive: true });
    await writeFile(
      join(work, dir, "SKILL.md"),
      skillText(dir.split("/").pop()!, description),
    );
  }
  await commitAll(work, "skills");
  // `git init` here creates `master`; every test names one ref, so the branch
  // is renamed before the bare clone rather than assumed.
  await $`git -C ${work} branch -M main`.quiet();
  const bare = await tempDir("capshelf-remote-bare-");
  const barePath = join(bare, "repo.git");
  await $`git clone -q --bare ${work} ${barePath}`.quiet();
  await $`git -C ${work} remote add origin ${barePath}`.quiet();
  return { url: `file://${barePath}`, work };
}

/**
 * Change one skill upstream and push it, so a later check sees one new commit.
 *
 * The edit is the description line only. A test that merges a local edit
 * appends to the end of the file, and rewriting the body as well would make
 * every such merge a conflict — which would test the conflict path rather than
 * the merge path.
 */
export async function pushChange(
  upstream: Upstream,
  dir: string,
  description: string,
): Promise<void> {
  await writeFile(
    join(upstream.work, dir, "SKILL.md"),
    skillText(dir.split("/").pop()!, description),
  );
  await commitAll(upstream.work, `revise ${dir}`);
  await $`git -C ${upstream.work} push -q origin main`.quiet();
}

export interface RemoteProject {
  project: string;
  dataRepo: string;
  /** Pass this to `runInProcess` so the cache lands in the world, not in $HOME. */
  env: Record<string, string>;
}

/** An initialized project with its own data repo and its own cache root. */
export async function initRemoteProject(): Promise<RemoteProject> {
  const project = await tempRepo("capshelf-remote-project-", { origin: null });
  const dataRepo = await tempRepo("capshelf-remote-data-", { origin: null });
  await addSkill(dataRepo, "placeholder");
  await commitAll(dataRepo, "seed");
  // `--no-upstream`: the data repo here is a bare temp directory with no
  // origin, and portability is not what these tests measure.
  const init = await runInProcess(project)([
    "init",
    "--data",
    dataRepo,
    "--no-upstream",
    "--json",
  ]);
  if (init.exitCode !== 0) {
    throw new Error(`init failed: ${init.stderr.toString()}`);
  }
  const xdg = await tempDir("capshelf-remote-xdg-");
  return { project, dataRepo, env: { XDG_DATA_HOME: xdg } };
}

/** The cache directory for one upstream inside a project's world. */
export function cacheRootOf(world: RemoteProject): string {
  return join(world.env.XDG_DATA_HOME!, "capshelf", "remote");
}

/** Delete the bare upstream, so any network attempt fails loudly. */
export async function deleteUpstream(upstream: Upstream): Promise<void> {
  await $`rm -rf ${upstream.url.replace("file://", "")}`.quiet();
}

export interface GitRecorder {
  /** Which of `names` the CLI invoked, in order, since the recorder started. */
  subcommands(names: string[]): Promise<string[]>;
}

/**
 * Put a logging `git` shim first on PATH and record every subcommand.
 *
 * A deleted upstream plus exit 0 does not prove a command stayed offline.
 * `fetchOrigin` reports a failed fetch instead of throwing, so a command that
 * fetched and swallowed the error passes that assertion. Counting the
 * invocations is the assertion that can actually fail.
 *
 * `runInProcess` runs the CLI inside this process, and `runGit` spawns `git`
 * by name, so a PATH entry reaches it.
 */
export async function recordGitInvocations(
  world: RemoteProject,
): Promise<GitRecorder> {
  const dir = await tempDir("capshelf-git-shim-");
  const log = join(dir, "calls.log");
  const real = (await $`which git`.quiet().text()).trim();
  await writeFile(
    join(dir, "git"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> ${log}\nexec ${real} "$@"\n`,
  );
  await $`chmod +x ${join(dir, "git")}`.quiet();
  // Mutates `world.env`, so call this before the run it measures and use the
  // same world for both.
  world.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  return {
    async subcommands(names) {
      const text = existsSync(log) ? await readFile(log, "utf-8") : "";
      return text.split("\n").filter((line) => names.includes(line));
    },
  };
}
