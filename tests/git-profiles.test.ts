import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catFileBlobs,
  checkAttrAtCommit,
  isolatedNoIndexDiff,
  lsTreeEntriesAtCommit,
  parseGitVersion,
  showAtCommit,
} from "../src/git";

/**
 * PIN-4. Every one of these asserts the same property from a different angle:
 * what capshelf reads from a commit is a function of the commit, not of the
 * machine. A test here failing means some ambient input — a ref, an
 * environment variable, a config file — reached an answer it must not decide.
 */

async function tempRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<string> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
  return (await $`git -C ${repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
}

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("source-read profile", () => {
  test("resolves real objects when a replacement ref rewrites the item", async () => {
    const repo = await tempRepo("capshelf-replace-");
    await writeFile(join(repo, "a.txt"), "one\n");
    const first = await commitAll(repo, "one");
    await writeFile(join(repo, "a.txt"), "two\n");
    const second = await commitAll(repo, "two");
    await $`git -C ${repo} replace -f ${second} ${first}`.quiet();

    // Plain git honors the graft, so this is the difference the profile makes.
    expect(
      (
        await $`git -C ${repo} show ${`${second}:a.txt`}`.quiet()
      ).stdout.toString(),
    ).toBe("one\n");
    expect((await showAtCommit(repo, second, "a.txt")).toString()).toBe(
      "two\n",
    );

    await rm(repo, { recursive: true, force: true });
  });

  test("ignores an ambient GIT_DIR and alternate object directories", async () => {
    const repo = await tempRepo("capshelf-ambient-");
    await writeFile(join(repo, "a.txt"), "real\n");
    const commit = await commitAll(repo, "real");
    const decoy = await tempRepo("capshelf-decoy-");
    await writeFile(join(decoy, "a.txt"), "decoy\n");
    await commitAll(decoy, "decoy");

    setEnv("GIT_DIR", join(decoy, ".git"));
    setEnv("GIT_WORK_TREE", decoy);
    setEnv("GIT_INDEX_FILE", join(decoy, ".git", "index"));
    setEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", join(decoy, ".git", "objects"));

    expect((await showAtCommit(repo, commit, "a.txt")).toString()).toBe(
      "real\n",
    );
    expect(
      (await lsTreeEntriesAtCommit(repo, commit, "a.txt")).map((e) => e.path),
    ).toEqual(["a.txt"]);

    await rm(repo, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  });
});

describe("catFileBlobs", () => {
  test("returns exact bytes for every requested blob in one call", async () => {
    const repo = await tempRepo("capshelf-catfile-");
    await writeFile(join(repo, "lf.txt"), "a,b\n");
    await writeFile(join(repo, "crlf.txt"), "a,b\r\n");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await writeFile(join(repo, "empty.txt"), "");
    const commit = await commitAll(repo, "mixed");

    const entries = await lsTreeEntriesAtCommit(repo, commit, ".");
    const byPath = new Map(entries.map((e) => [e.path, e.object]));
    const blobs = await catFileBlobs(repo, byPath.values());

    expect(blobs.get(byPath.get("lf.txt")!)!.toString()).toBe("a,b\n");
    expect(blobs.get(byPath.get("crlf.txt")!)!.toString()).toBe("a,b\r\n");
    expect([...blobs.get(byPath.get("binary.bin")!)!]).toEqual([
      0, 1, 2, 0, 255,
    ]);
    expect(blobs.get(byPath.get("empty.txt")!)!.length).toBe(0);

    await rm(repo, { recursive: true, force: true });
  });

  test("refuses an object name that is not hex", async () => {
    const repo = await tempRepo("capshelf-catfile-bad-");
    await writeFile(join(repo, "a.txt"), "a\n");
    await commitAll(repo, "a");
    await expect(catFileBlobs(repo, ["--output=/tmp/pwn"])).rejects.toThrow(
      "invalid git object name",
    );
    await rm(repo, { recursive: true, force: true });
  });
});

describe("committed attribute reads (PIN-9)", () => {
  test("reads .gitattributes from the commit, not the machine", async () => {
    const repo = await tempRepo("capshelf-attrs-");
    await writeFile(join(repo, ".gitattributes"), "*.yml filter=git-crypt\n");
    await writeFile(join(repo, "secret.yml"), "k: v\n");
    await writeFile(join(repo, "plain.md"), "hello\n");
    const commit = await commitAll(repo, "attrs");

    // Machine-local sources that must not be able to change the verdict.
    await writeFile(
      join(repo, ".git", "info", "attributes"),
      "plain.md filter=local-only\n",
    );
    const machineAttributes = join(repo, "machine.gitattributes");
    await writeFile(machineAttributes, "*.md filter=machine\n");
    setEnv("GIT_ATTR_NOSYSTEM", undefined);

    const results = await checkAttrAtCommit(
      repo,
      commit,
      ["secret.yml", "plain.md"],
      ["filter"],
    );
    expect(results).toEqual([
      { path: "secret.yml", attribute: "filter", value: "git-crypt" },
      { path: "plain.md", attribute: "filter", value: "unspecified" },
    ]);

    await rm(repo, { recursive: true, force: true });
  });

  test("one call covers every path of one commit", async () => {
    const repo = await tempRepo("capshelf-attrs-batch-");
    await writeFile(join(repo, ".gitattributes"), "b.txt filter=fake\n");
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(repo, name), `${name}\n`);
    }
    const commit = await commitAll(repo, "batch");
    const results = await checkAttrAtCommit(
      repo,
      commit,
      ["a.txt", "b.txt", "c.txt"],
      ["filter"],
    );
    expect(results.map((r) => r.value)).toEqual([
      "unspecified",
      "fake",
      "unspecified",
    ]);
    await rm(repo, { recursive: true, force: true });
  });
});

describe("isolated-diff profile", () => {
  test("renders a CRLF-only difference under hostile configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-isodiff-"));
    const sentinel = join(dir, "external-diff-ran");
    const helper = join(dir, "helper.sh");
    await writeFile(helper, `#!/bin/sh\ntouch ${sentinel}\nexit 0\n`);
    await chmod(helper, 0o755);
    const globalConfig = join(dir, "gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n\tautocrlf = input\n[diff]\n\texternal = ${helper}\n`,
    );
    setEnv("GIT_CONFIG_GLOBAL", globalConfig);
    setEnv("GIT_CONFIG_NOSYSTEM", "1");
    setEnv("GIT_EXTERNAL_DIFF", helper);

    const crlf = join(dir, "crlf.txt");
    const lf = join(dir, "lf.txt");
    await writeFile(crlf, "a,b\r\n");
    await writeFile(lf, "a,b\n");

    const result = await isolatedNoIndexDiff(dir, crlf, lf);
    expect(result.exitCode).toBe(1);
    const text = result.stdout.toString();
    expect(text).toContain("-a,b");
    expect(text).toContain("+a,b");
    expect(existsSync(sentinel)).toBe(false);
    expect(await readdir(dir)).not.toContain("external-diff-ran");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("git version gate", () => {
  test("parses vendor suffixes without changing the numeric result", () => {
    expect(parseGitVersion("2.40.0")).toEqual([2, 40, 0]);
    expect(parseGitVersion("2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
    expect(parseGitVersion("2.40.0.windows.1")).toEqual([2, 40, 0]);
    expect(parseGitVersion("2.41")).toEqual([2, 41, 0]);
    expect(parseGitVersion("not a version")).toBeNull();
  });
});
