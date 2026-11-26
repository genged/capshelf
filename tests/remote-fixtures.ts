/**
 * Local bare repos stand in for hosts because `git clone` from github.com
 * returns 403 in the project container (docs/testing.md).
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigValue } from "../src/config-values";
import {
  addSkill,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { writePlugins } from "./plugin-fixtures";
import type { PluginSpec } from "./plugin-fixtures";

export interface Upstream {
  url: string;
  work: string;
}

export function skillText(
  name: string,
  description: string,
  body = "body",
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

/**
 * `git init` creates `master`; rename to `main` before the bare clone since
 * every test names one ref.
 */
async function finalizeUpstream(work: string): Promise<Upstream> {
  await $`git -C ${work} branch -M main`.quiet();
  const bare = await tempDir("capshelf-remote-bare-");
  const barePath = join(bare, "repo.git");
  await $`git clone -q --bare ${work} ${barePath}`.quiet();
  await $`git -C ${work} remote add origin ${barePath}`.quiet();
  return { url: `file://${barePath}`, work };
}

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
  return finalizeUpstream(work);
}

export async function pluginUpstream(
  plugins: readonly PluginSpec[],
  catalogs: { claude?: ConfigValue; codex?: ConfigValue },
): Promise<Upstream> {
  const work = await tempRepo("capshelf-remote-plugin-src-", { origin: null });
  await writePlugins(work, plugins, catalogs);
  await commitAll(work, "plugins");
  return finalizeUpstream(work);
}

/**
 * Edit only the description line: rewriting the body too would make every
 * local-edit merge a conflict and test the wrong path.
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

export async function pushPluginChange(
  upstream: Upstream,
  relPath: string,
  content: string,
): Promise<void> {
  const target = join(upstream.work, ...relPath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  await commitAll(upstream.work, `change ${relPath}`);
  await $`git -C ${upstream.work} push -q origin main`.quiet();
}

export interface RemoteProject {
  project: string;
  dataRepo: string;
  env: Record<string, string>;
}

export async function initRemoteProject(): Promise<RemoteProject> {
  const project = await tempRepo("capshelf-remote-project-", { origin: null });
  const dataRepo = await tempRepo("capshelf-remote-data-", { origin: null });
  await addSkill(dataRepo, "placeholder");
  await commitAll(dataRepo, "seed");
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

export function cacheRootOf(world: RemoteProject): string {
  return join(world.env.XDG_DATA_HOME!, "capshelf", "remote");
}

export async function deleteUpstream(upstream: Upstream): Promise<void> {
  await $`rm -rf ${upstream.url.replace("file://", "")}`.quiet();
}

export interface GitRecorder {
  subcommands(names: string[]): Promise<string[]>;
}

/**
 * Deleted upstream plus exit 0 doesn't prove offline, since `fetchOrigin`
 * reports failure instead of throwing; counting git invocations can actually
 * fail.
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
  // Mutates `world.env`, so call before the measured run and reuse the same
  // world.
  world.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  return {
    async subcommands(names) {
      const text = existsSync(log) ? await readFile(log, "utf-8") : "";
      return text.split("\n").filter((line) => names.includes(line));
    },
  };
}
