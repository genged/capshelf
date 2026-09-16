import { expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultCachedBranch,
  ensureRemoteCache,
  fetchRemoteCache,
  remoteCachePath,
  remoteCacheState,
  resolveCachedRef,
} from "../src/remote-cache";
import { parseRemoteSkillUrl } from "../src/remote-url";
import { PreconditionError } from "../src/errors";
import {
  addSkill,
  commitAll,
  rejection,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

/** A local bare repository holding one skill, plus the working clone that feeds it. */
async function bareUpstream(): Promise<{ url: string; work: string }> {
  const work = await tempRepo("capshelf-remote-src-", { origin: null });
  await addSkill(
    work,
    "pdf",
    "---\nname: pdf\ndescription: Read PDFs\n---\nbody\n",
  );
  await commitAll(work, "add pdf");
  await $`git -C ${work} branch -M main`.quiet();
  const bare = await tempDir("capshelf-remote-bare-");
  const barePath = join(bare, "repo.git");
  await $`git clone -q --bare ${work} ${barePath}`.quiet();
  await $`git -C ${work} remote add origin ${barePath}`.quiet();
  return { url: `file://${barePath}`, work };
}

test("the cache path is derived from the normalized upstream", () => {
  const path = remoteCachePath("https://github.com/anthropics/skills", {
    XDG_DATA_HOME: "/tmp/xdg",
  });
  expect(path).toBe("/tmp/xdg/capshelf/remote/github.com/anthropics/skills");
});

test("ensureRemoteCache clones once and reuses the clone", async () => {
  const { url } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-");
  const env = { XDG_DATA_HOME: xdg };
  expect(remoteCacheState(upstream, env).present).toBe(false);
  const first = await ensureRemoteCache(cloneUrl, upstream, env);
  expect(first.cloned).toBe(true);
  expect(existsSync(join(first.path, ".git"))).toBe(true);
  expect(remoteCacheState(upstream, env).present).toBe(true);
  const second = await ensureRemoteCache(cloneUrl, upstream, env);
  expect(second.cloned).toBe(false);
  expect(second.path).toBe(first.path);
});

test("a cache path pointing at another upstream is refused", async () => {
  const a = parseRemoteSkillUrl((await bareUpstream()).url);
  const b = parseRemoteSkillUrl((await bareUpstream()).url);
  const xdg = await tempDir("capshelf-remote-xdg-mismatch-");
  const env = { XDG_DATA_HOME: xdg };
  await $`git clone -q ${b.cloneUrl} ${remoteCachePath(a.upstream, env)}`.quiet();
  await expect(ensureRemoteCache(a.cloneUrl, a.upstream, env)).rejects.toThrow(
    /remote skill cache path already exists but points at a different upstream/,
  );
});

test("the remote cache refusal names the cache, never capshelf init --data", async () => {
  const { url } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-wording-");
  const env = { XDG_DATA_HOME: xdg };
  const path = remoteCachePath(upstream, env);
  await $`mkdir -p ${path}`.quiet();
  await Bun.write(join(path, "unrelated.txt"), "not a repo\n");

  const error = await rejection(
    ensureRemoteCache(cloneUrl, upstream, env),
    PreconditionError,
  );
  expect(error.message).toContain(
    "remote skill cache path already exists but is not a git working tree",
  );
  expect(error.message).not.toContain("init --data");
  expect(error.message).toContain("remove the cache and retry");
});

test("a fetch reports the new head and how far the ref moved", async () => {
  const { url, work } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-fetch-");
  const cache = await ensureRemoteCache(cloneUrl, upstream, {
    XDG_DATA_HOME: xdg,
  });
  const before = await resolveCachedRef(cache.path, "main");
  expect(before).not.toBeNull();

  await addSkill(
    work,
    "pdf",
    "---\nname: pdf\ndescription: Read PDFs well\n---\nbody\n",
  );
  await commitAll(work, "improve pdf");
  await $`git -C ${work} push -q origin main`.quiet();

  const result = await fetchRemoteCache(cache.path, "main", before);
  expect(result.ok).toBe(true);
  expect(result.head).not.toBe(before);
  expect(result.ahead).toBe(1);
});

test("a fetch against a deleted upstream reports the failure instead of throwing", async () => {
  const { url } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-gone-");
  const cache = await ensureRemoteCache(cloneUrl, upstream, {
    XDG_DATA_HOME: xdg,
  });
  await $`rm -rf ${cloneUrl.replace("file://", "")}`.quiet();

  const result = await fetchRemoteCache(cache.path, "main", null);
  expect(result.ok).toBe(false);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("the default branch is the one the upstream published, not git's default", async () => {
  // `git init` here creates `master`; the fixture renames the branch to `main`
  // before the bare clone, so this asserts the clone was asked rather than a
  // name being assumed.
  const { url } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-default-");
  const cache = await ensureRemoteCache(cloneUrl, upstream, {
    XDG_DATA_HOME: xdg,
  });
  expect(await defaultCachedBranch(cache.path)).toBe("main");
});

test("an unresolvable ref reports null rather than guessing", async () => {
  const { url } = await bareUpstream();
  const { cloneUrl, upstream } = parseRemoteSkillUrl(url);
  const xdg = await tempDir("capshelf-remote-xdg-ref-");
  const cache = await ensureRemoteCache(cloneUrl, upstream, {
    XDG_DATA_HOME: xdg,
  });
  expect(await resolveCachedRef(cache.path, "no-such-branch")).toBeNull();
  const result = await fetchRemoteCache(cache.path, "no-such-branch", null);
  expect(result.ok).toBe(true);
  expect(result.head).toBeNull();
  expect(result.ahead).toBeNull();
});
