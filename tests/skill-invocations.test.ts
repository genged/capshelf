import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  claudeProjectDirName,
  createSkillInvocationReader,
  invocationsForSkill,
  skillInvocationCacheDir,
} from "../src/skill-invocations";
import { tempDir } from "./cli-fixtures";

const SECRET = "do-not-store-this-prompt-text";

function agentLine(
  cwd: string,
  timestamp: string,
  skill: string,
  id: string,
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    cwd,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: SECRET },
        { type: "tool_use", id, name: "Skill", input: { skill, args: SECRET } },
      ],
    },
  });
}

function userLine(cwd: string, timestamp: string, name: string): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    cwd,
    message: {
      role: "user",
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${SECRET}</command-args>`,
    },
  });
}

function promptLine(cwd: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    cwd,
    message: { role: "user", content: SECRET },
  });
}

interface Fixture {
  env: Record<string, string>;
  project: string;
  dir: string;
}

async function fixture(): Promise<Fixture> {
  const home = await tempDir("capshelf-invocations-");
  const project = join(home, "work", "app");
  await mkdir(project, { recursive: true });
  const dir = join(home, "claude", "projects", claudeProjectDirName(project));
  await mkdir(dir, { recursive: true });
  return {
    env: {
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      XDG_CACHE_HOME: join(home, "cache"),
    },
    project,
    dir,
  };
}

async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.map((line) => `${line}\n`).join(""));
}

describe("skill invocations from Claude Code transcripts", () => {
  test("counts agent and user invocations of each skill", async () => {
    const { env, project, dir } = await fixture();
    await writeLines(join(dir, "s1.jsonl"), [
      promptLine(project, "2026-11-01T09:00:00.000Z"),
      agentLine(project, "2026-11-01T09:01:00.000Z", "review", "toolu_1"),
      // Claude Code can write one assistant message in more than one record.
      agentLine(project, "2026-11-01T09:01:00.000Z", "review", "toolu_1"),
      userLine(project, "2026-11-02T10:00:00.000Z", "review"),
      userLine(join(project, "src"), "2026-11-03T10:00:00.000Z", "deploy"),
    ]);
    const reader = createSkillInvocationReader({ env, persist: "disk" });
    const facts = await reader.read(project);
    if (facts === null) throw new Error("expected facts");

    expect(invocationsForSkill(facts, "review")).toEqual({
      count: 2,
      byAgent: 1,
      byUser: 1,
      last: "2026-11-02T10:00:00.000Z",
      since: "2026-11-01T09:00:00.000Z",
    });
    expect(invocationsForSkill(facts, "deploy").count).toBe(1);
    expect(invocationsForSkill(facts, "unused")).toEqual({
      count: 0,
      byAgent: 0,
      byUser: 0,
      last: null,
      since: "2026-11-01T09:00:00.000Z",
    });
  });

  test("ignores records that only quote a command or a skill call", async () => {
    const { env, project, dir } = await fixture();
    const meta = JSON.parse(userLine(project, "2026-11-01T09:00:00Z", "a"));
    meta.isMeta = true;
    const blob = JSON.parse(
      agentLine(project, "2026-11-01T09:00:00Z", "b", "x"),
    );
    blob.type = "api-request-blob";
    const quoted = {
      type: "assistant",
      timestamp: "2026-11-01T09:00:00Z",
      cwd: project,
      message: {
        content: [{ type: "text", text: "<command-name>/c</command-name>" }],
      },
    };
    await writeLines(join(dir, "s1.jsonl"), [
      JSON.stringify(meta),
      JSON.stringify(blob),
      JSON.stringify(quoted),
    ]);
    const facts = await createSkillInvocationReader({
      env,
      persist: "disk",
    }).read(project);
    expect(facts?.bySkill.size).toBe(0);
  });

  test("counts a subagent call and drops another folder with the same name", async () => {
    const { env, project, dir } = await fixture();
    // `/work/app-x` and `/work/app/x` give the same Claude folder name.
    const sibling = `${project}-x`;
    await writeLines(join(dir, "s1.jsonl"), [
      agentLine(project, "2026-11-01T09:00:00Z", "review", "t1"),
      agentLine(sibling, "2026-11-01T09:00:01Z", "review", "t2"),
    ]);
    await mkdir(join(dir, "s1", "subagents"), { recursive: true });
    await writeLines(join(dir, "s1", "subagents", "agent-1.jsonl"), [
      agentLine(project, "2026-11-01T09:00:02Z", "review", "t3"),
    ]);
    const facts = await createSkillInvocationReader({
      env,
      persist: "disk",
    }).read(project);
    expect(facts?.bySkill.get("review")?.byAgent).toBe(2);
  });

  test("returns null when Claude Code has no transcripts for the project", async () => {
    const { env, project, dir } = await fixture();
    await rm(dir, { recursive: true });
    const reader = createSkillInvocationReader({ env, persist: "disk" });
    expect(await reader.read(project)).toBeNull();
    expect(existsSync(skillInvocationCacheDir(env))).toBe(false);
  });

  test("reads only appended lines and waits for an unfinished line", async () => {
    const { env, project, dir } = await fixture();
    const path = join(dir, "s1.jsonl");
    await writeLines(path, [
      agentLine(project, "2026-11-01T09:00:00Z", "review", "t1"),
    ]);
    const reader = createSkillInvocationReader({ env, persist: "disk" });
    expect((await reader.read(project))?.bySkill.get("review")?.count).toBe(1);

    const next = agentLine(project, "2026-11-01T09:05:00Z", "review", "t2");
    await appendFile(path, next.slice(0, 40));
    expect((await reader.read(project))?.bySkill.get("review")?.count).toBe(1);

    await appendFile(path, `${next.slice(40)}\n`);
    // A new reader starts from the saved cache, not from the start of the file.
    const fresh = createSkillInvocationReader({ env, persist: "disk" });
    expect((await fresh.read(project))?.bySkill.get("review")?.count).toBe(2);
  });

  test("forgets a transcript that Claude Code deleted or rewrote", async () => {
    const { env, project, dir } = await fixture();
    await writeLines(join(dir, "s1.jsonl"), [
      agentLine(project, "2026-11-01T09:00:00Z", "review", "t1"),
      agentLine(project, "2026-11-01T09:01:00Z", "review", "t2"),
    ]);
    await writeLines(join(dir, "s2.jsonl"), [
      agentLine(project, "2026-11-02T09:00:00Z", "deploy", "t3"),
    ]);
    const reader = createSkillInvocationReader({ env, persist: "disk" });
    expect((await reader.read(project))?.bySkill.size).toBe(2);

    await rm(join(dir, "s2.jsonl"));
    await writeLines(join(dir, "s1.jsonl"), [
      agentLine(project, "2026-11-03T09:00:00Z", "review", "t9"),
    ]);
    const facts = await reader.read(project);
    expect(facts?.bySkill.get("deploy")).toBeUndefined();
    expect(facts?.bySkill.get("review")?.count).toBe(1);
    expect(facts?.since).toBe("2026-11-03T09:00:00Z");
  });

  test("saves only names, times, folders, and IDs in the disk cache", async () => {
    const { env, project, dir } = await fixture();
    await writeLines(join(dir, "s1.jsonl"), [
      promptLine(project, "2026-11-01T09:00:00Z"),
      agentLine(project, "2026-11-01T09:01:00Z", "review", "t1"),
      userLine(project, "2026-11-01T09:02:00Z", "review"),
    ]);
    await createSkillInvocationReader({ env, persist: "disk" }).read(project);
    const cacheDir = skillInvocationCacheDir(env);
    const files = await readdir(cacheDir);
    expect(files).toHaveLength(1);
    const text = await readFile(join(cacheDir, files[0] ?? ""), "utf8");
    expect(text).toContain('"s":"review"');
    expect(text).not.toContain(SECRET);
  });

  test("memory mode writes no cache file", async () => {
    const { env, project, dir } = await fixture();
    await writeLines(join(dir, "s1.jsonl"), [
      agentLine(project, "2026-11-01T09:00:00Z", "review", "t1"),
    ]);
    const reader = createSkillInvocationReader({ env, persist: "memory" });
    expect((await reader.read(project))?.bySkill.get("review")?.count).toBe(1);
    expect(existsSync(skillInvocationCacheDir(env))).toBe(false);
  });
});
