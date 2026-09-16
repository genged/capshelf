import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REMOTE_PREVIOUS_OWNER,
  SKILLS_SH_PREVIOUS_OWNER,
  findPreviousOwner,
  previousOwnerFor,
} from "../src/previous-owner";
import {
  emptyRemotesLock,
  remoteKey,
  saveRemotesLock,
} from "../src/remotes-lock";
import { rejection, tempDir } from "./cli-fixtures";
import { PreconditionError } from "../src/errors";

const LOCK = `{
  "version": 1,
  "skills": {
    "git-commit": {
      "source": "vercel-labs/agent-skills",
      "sourceType": "github",
      "skillPath": "skills/git-commit/SKILL.md",
      "computedHash": "abc",
      "unknownFutureField": 7
    },
    "impeccable": {
      "source": "pbakaus/impeccable",
      "sourceType": "github",
      "skillPath": ".agents/skills/impeccable/SKILL.md",
      "computedHash": "def"
    }
  }
}
`;

const REMOTE_ENTRY = {
  upstream: "https://github.com/obra/superpowers",
  ref: "main",
  subpath: "skills/brainstorming",
  sourceCommit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
  sourcePinDigest: "a".repeat(64),
  appliedAt: "2026-09-13T00:00:00.000Z",
};

async function projectWithRemoteRow(prefix: string): Promise<string> {
  const project = await tempDir(prefix);
  const lock = emptyRemotesLock();
  lock.items[remoteKey("brainstorming")] = { ...REMOTE_ENTRY };
  await saveRemotesLock(project, lock);
  return project;
}

test("releasing one skills.sh row preserves every other field", async () => {
  const project = await tempDir("capshelf-owner-");
  await writeFile(join(project, "skills-lock.json"), LOCK);

  const record = await SKILLS_SH_PREVIOUS_OWNER.find(project, "git-commit");
  expect(record).not.toBeNull();
  expect(record!.provenance.upstream).toBe("vercel-labs/agent-skills");
  expect(record!.provenance.upstreamPath).toBe("skills/git-commit/SKILL.md");

  await SKILLS_SH_PREVIOUS_OWNER.release(project, "git-commit", record!);

  const after = await readFile(join(project, "skills-lock.json"), "utf-8");
  const parsed = JSON.parse(after);
  expect(Object.keys(parsed.skills)).toEqual(["impeccable"]);
  expect(parsed.version).toBe(1);
  expect(parsed.skills.impeccable.computedHash).toBe("def");
  expect(after.endsWith("\n")).toBe(true);
});

test("a file that changed mid-transfer is refused and keeps the row", async () => {
  const project = await tempDir("capshelf-owner-race-");
  await writeFile(join(project, "skills-lock.json"), LOCK);
  const record = await SKILLS_SH_PREVIOUS_OWNER.find(project, "git-commit");
  await writeFile(
    join(project, "skills-lock.json"),
    LOCK.replace("abc", "zzz"),
  );

  await expect(
    SKILLS_SH_PREVIOUS_OWNER.release(project, "git-commit", record!),
  ).rejects.toThrow(/changed while adopting/);

  const after = JSON.parse(
    await readFile(join(project, "skills-lock.json"), "utf-8"),
  );
  expect(Object.keys(after.skills).sort()).toEqual([
    "git-commit",
    "impeccable",
  ]);
});

test("the mid-transfer refusal is the branch's string, semicolon included", async () => {
  const project = await tempDir("capshelf-owner-message-");
  await writeFile(join(project, "skills-lock.json"), LOCK);
  const record = await SKILLS_SH_PREVIOUS_OWNER.find(project, "git-commit");
  await writeFile(
    join(project, "skills-lock.json"),
    LOCK.replace("abc", "zzz"),
  );
  const error = await rejection(
    SKILLS_SH_PREVIOUS_OWNER.release(project, "git-commit", record!),
    PreconditionError,
  );
  expect(error.message).toBe(
    "skills-lock.json changed while adopting skills/git-commit; Capshelf kept the skills.sh entry",
  );
});

test("an unsupported skills-lock version is refused before any write", async () => {
  const project = await tempDir("capshelf-owner-version-");
  await writeFile(
    join(project, "skills-lock.json"),
    '{"version": 2, "skills": {"git-commit": {"source": "a/b"}}}\n',
  );
  await expect(
    SKILLS_SH_PREVIOUS_OWNER.find(project, "git-commit"),
  ).rejects.toThrow(/version 2/);
});

test("a skill no owner holds resolves to null", async () => {
  const project = await tempDir("capshelf-owner-none-");
  expect(await findPreviousOwner(project, "pdf")).toBeNull();
});

test("a remote row is found, and its provenance is the pin", async () => {
  const project = await projectWithRemoteRow("capshelf-owner-remote-");
  const record = await findPreviousOwner(project, "brainstorming");
  expect(record).not.toBeNull();
  expect(record!.kind).toBe("remote");
  expect(record!.path).toBe(join(project, ".capshelf", "remotes.lock.json"));
  expect(record!.provenance).toEqual({
    upstream: REMOTE_ENTRY.upstream,
    upstreamCommit: REMOTE_ENTRY.sourceCommit,
    upstreamPath: REMOTE_ENTRY.subpath,
  });
});

test("releasing a remote row deletes only that row", async () => {
  const project = await projectWithRemoteRow("capshelf-owner-remote-release-");
  const lockPath = join(project, ".capshelf", "remotes.lock.json");
  const both = JSON.parse(await readFile(lockPath, "utf-8"));
  both.items[remoteKey("pdf")] = { ...REMOTE_ENTRY, subpath: "skills/pdf" };
  await writeFile(lockPath, `${JSON.stringify(both, null, 2)}\n`);

  const record = await REMOTE_PREVIOUS_OWNER.find(project, "brainstorming");
  await REMOTE_PREVIOUS_OWNER.release(project, "brainstorming", record!);

  const after = JSON.parse(await readFile(lockPath, "utf-8"));
  expect(Object.keys(after.items)).toEqual([remoteKey("pdf")]);
});

test("a remotes lock that changed mid-transfer is refused and keeps the row", async () => {
  const project = await projectWithRemoteRow("capshelf-owner-remote-race-");
  const lockPath = join(project, ".capshelf", "remotes.lock.json");
  const record = await REMOTE_PREVIOUS_OWNER.find(project, "brainstorming");
  const raced = JSON.parse(await readFile(lockPath, "utf-8"));
  raced.items[remoteKey("brainstorming")].appliedAt =
    "2026-09-14T00:00:00.000Z";
  await writeFile(lockPath, `${JSON.stringify(raced, null, 2)}\n`);

  await expect(
    REMOTE_PREVIOUS_OWNER.release(project, "brainstorming", record!),
  ).rejects.toThrow(/changed while adopting/);
  const after = JSON.parse(await readFile(lockPath, "utf-8"));
  expect(Object.keys(after.items)).toEqual([remoteKey("brainstorming")]);
});

test("the remote row wins when both owners hold the name", async () => {
  const project = await projectWithRemoteRow("capshelf-owner-both-");
  await writeFile(
    join(project, "skills-lock.json"),
    JSON.stringify(
      {
        version: 1,
        skills: { brainstorming: { source: "a/b" } },
      },
      null,
      2,
    ),
  );
  expect((await findPreviousOwner(project, "brainstorming"))!.kind).toBe(
    "remote",
  );
});

test("previousOwnerFor selects the implementation the record names", async () => {
  const project = await projectWithRemoteRow("capshelf-owner-select-");
  const record = await findPreviousOwner(project, "brainstorming");
  await previousOwnerFor(record!.kind).release(
    project,
    "brainstorming",
    record!,
  );
  const after = JSON.parse(
    await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
  );
  expect(after.items).toEqual({});
});
