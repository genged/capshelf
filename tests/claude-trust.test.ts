import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeTrustFor } from "../src/claude-trust";
import { tempDir } from "./cli-fixtures";

/** No `CLAUDE_CODE_SANDBOXED`, whatever the test process runs under. */
const env = {};

async function homeTrusting(entries: Record<string, boolean>): Promise<string> {
  const home = await tempDir("h-");
  const projects: Record<string, { hasTrustDialogAccepted: boolean }> = {};
  for (const [path, accepted] of Object.entries(entries)) {
    projects[path] = { hasTrustDialogAccepted: accepted };
  }
  await writeFile(join(home, ".claude.json"), JSON.stringify({ projects }));
  return home;
}

describe("claudeTrustFor", () => {
  test("a missing file is unknown", async () => {
    expect(claudeTrustFor("/p", { home: await tempDir("h-"), env })).toBe(
      "unknown",
    );
  });
  test("an unreadable file is unknown", async () => {
    const home = await tempDir("h-");
    await writeFile(join(home, ".claude.json"), "{bad");
    expect(claudeTrustFor("/p", { home, env })).toBe("unknown");
  });
  test("an accepted project is trusted, a missing key is untrusted", async () => {
    const project = await tempDir("p-");
    const home = await homeTrusting({ [project]: true });
    expect(claudeTrustFor(project, { home, env })).toBe("trusted");
    expect(claudeTrustFor(await tempDir("q-"), { home, env })).toBe(
      "untrusted",
    );
  });
  test("a false value is untrusted", async () => {
    const project = await tempDir("p-");
    const home = await homeTrusting({ [project]: false });
    expect(claudeTrustFor(project, { home, env })).toBe("untrusted");
  });
  test("a project reached through a symlink matches its real path", async () => {
    const project = await tempDir("p-");
    const link = join(await tempDir("l-"), "link");
    await symlink(project, link);
    const home = await homeTrusting({ [project]: true });
    expect(claudeTrustFor(link, { home, env })).toBe("trusted");
  });
  test("a trusted parent directory trusts a project with no Git root", async () => {
    const parent = await tempDir("parent-");
    const project = join(parent, "a", "b");
    await mkdir(project, { recursive: true });
    const home = await homeTrusting({ [parent]: true });
    expect(claudeTrustFor(project, { home, env })).toBe("trusted");
  });
  test("a trusted Git root trusts a project in a subdirectory", async () => {
    const root = await tempDir("mono-");
    await mkdir(join(root, ".git"));
    const project = join(root, "packages", "app");
    await mkdir(project, { recursive: true });
    const home = await homeTrusting({ [root]: true });
    expect(claudeTrustFor(project, { home, env })).toBe("trusted");
  });
  test("a .git file (a worktree) marks the Git root too", async () => {
    const root = await tempDir("wt-");
    await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
    const project = join(root, "sub");
    await mkdir(project);
    const home = await homeTrusting({ [root]: true });
    expect(claudeTrustFor(project, { home, env })).toBe("trusted");
  });
  test("a trusted directory above the Git root does not trust the project", async () => {
    const parent = await tempDir("above-");
    const root = join(parent, "repo");
    await mkdir(join(root, ".git"), { recursive: true });
    const home = await homeTrusting({ [parent]: true });
    expect(claudeTrustFor(root, { home, env })).toBe("untrusted");
  });
  test("a nearer false entry does not hide a trusted ancestor", async () => {
    const parent = await tempDir("near-");
    const project = join(parent, "p");
    await mkdir(project);
    const home = await homeTrusting({ [project]: false, [parent]: true });
    expect(claudeTrustFor(project, { home, env })).toBe("trusted");
  });
  test("CLAUDE_CODE_SANDBOXED is trusted, before any file is read", async () => {
    const missing = await tempDir("h-");
    expect(
      claudeTrustFor("/p", {
        home: missing,
        env: { CLAUDE_CODE_SANDBOXED: "1" },
      }),
    ).toBe("trusted");
    for (const off of ["", "0", "false", "FALSE"]) {
      expect(
        claudeTrustFor("/p", {
          home: missing,
          env: { CLAUDE_CODE_SANDBOXED: off },
        }),
      ).toBe("unknown");
    }
  });
});
