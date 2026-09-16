import { expect, test } from "bun:test";
import {
  isRemoteSkillUrl,
  ownerRepoShorthandHint,
  parseRemoteSkillUrl,
} from "../src/remote-url";

test("a plain repository URL names no ref and no subpath", () => {
  const parsed = parseRemoteSkillUrl("https://github.com/anthropics/skills");
  expect(parsed.cloneUrl).toBe("https://github.com/anthropics/skills");
  expect(parsed.upstream).toBe("https://github.com/anthropics/skills");
  expect(parsed.ref).toBeNull();
  expect(parsed.subpath).toBeNull();
  expect(parsed.repoName).toBe("skills");
});

test("a browser tree URL names the ref and the item root", () => {
  const parsed = parseRemoteSkillUrl(
    "https://github.com/obra/superpowers/tree/main/skills/brainstorming",
  );
  expect(parsed.cloneUrl).toBe("https://github.com/obra/superpowers");
  expect(parsed.ref).toBe("main");
  expect(parsed.subpath).toBe("skills/brainstorming");
  expect(parsed.repoName).toBe("superpowers");
});

test("a blob URL names the directory that holds the file", () => {
  const parsed = parseRemoteSkillUrl(
    "https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md",
  );
  expect(parsed.subpath).toBe("skills/brainstorming");
});

test("a trailing .git and a trailing slash do not change identity", () => {
  const bare = parseRemoteSkillUrl("https://github.com/anthropics/skills");
  const dotted = parseRemoteSkillUrl(
    "https://github.com/anthropics/skills.git/",
  );
  expect(dotted.upstream).toBe(bare.upstream);
});

test("scp-like and ssh URLs share one upstream identity", () => {
  expect(
    parseRemoteSkillUrl("git@github.com:anthropics/skills.git").upstream,
  ).toBe("https://github.com/anthropics/skills");
  expect(
    parseRemoteSkillUrl("ssh://git@github.com/anthropics/skills").upstream,
  ).toBe("https://github.com/anthropics/skills");
});

test("a subpath that escapes the repository is refused", () => {
  expect(() =>
    parseRemoteSkillUrl("https://github.com/a/b/tree/main/../../etc"),
  ).toThrow(/subpath/);
});

test("owner/repo shorthand is not a URL and gets the full-URL hint", () => {
  expect(isRemoteSkillUrl("vercel-labs/agent-skills")).toBe(false);
  expect(ownerRepoShorthandHint("vercel-labs/agent-skills")).toEqual([
    "owner/repo shorthand is ambiguous with kind/name here",
    "pass the full URL: capshelf add https://github.com/vercel-labs/agent-skills",
  ]);
  expect(ownerRepoShorthandHint("skills/pdf")).toBeNull();
});

test("a repo-root tree URL names the ref and the root item", () => {
  const parsed = parseRemoteSkillUrl(
    "https://github.com/jane/sqlreview/tree/v1.2.0",
  );
  expect(parsed.ref).toBe("v1.2.0");
  expect(parsed.subpath).toBe(".");
  expect(parsed.repoName).toBe("sqlreview");
});

test("a percent-encoded path segment is decoded once", () => {
  const parsed = parseRemoteSkillUrl(
    "https://github.com/a/b/tree/main/skills/sql%20review",
  );
  expect(parsed.subpath).toBe("skills/sql review");
});

test("a file URL is a supported upstream, because the suites use bare repos", () => {
  const parsed = parseRemoteSkillUrl("file:///tmp/bare/repo.git");
  expect(isRemoteSkillUrl("file:///tmp/bare/repo.git")).toBe(true);
  expect(parsed.repoName).toBe("repo");
  expect(parsed.subpath).toBeNull();
});

test("an empty input and a bare word are refused", () => {
  expect(() => parseRemoteSkillUrl("   ")).toThrow();
  expect(() => parseRemoteSkillUrl("pdf")).toThrow();
  expect(isRemoteSkillUrl("pdf")).toBe(false);
});

test("a credential in an https URL is refused, and never echoed back", () => {
  // git would write the URL into the cache clone's .git/config verbatim.
  expect(() =>
    parseRemoteSkillUrl("https://ghp_secrettoken@github.com/owner/repo"),
  ).toThrow(/credential/);
  expect(() =>
    parseRemoteSkillUrl("https://ghp_secrettoken@github.com/owner/repo"),
  ).not.toThrow(/ghp_secrettoken/);
});

test("a password in an ssh URL is refused and a bare username is not", () => {
  expect(() =>
    parseRemoteSkillUrl("ssh://git:hunter2@example.com/owner/repo"),
  ).toThrow(/credential/);
  expect(parseRemoteSkillUrl("ssh://git@example.com/owner/repo").upstream).toBe(
    "https://example.com/owner/repo",
  );
  expect(parseRemoteSkillUrl("git@example.com:owner/repo").upstream).toBe(
    "https://example.com/owner/repo",
  );
});

test("a browser URL offers every ref/subpath split, longest ref first", () => {
  const parsed = parseRemoteSkillUrl(
    "https://github.com/owner/repo/tree/feature/login/skills/pdf",
  );
  expect(parsed.refCandidates.map((c) => c.ref)).toEqual([
    "feature/login/skills/pdf",
    "feature/login/skills",
    "feature/login",
    "feature",
  ]);
  expect(parsed.refCandidates[2]).toEqual({
    ref: "feature/login",
    subpath: "skills/pdf",
  });
  // The one-segment split stays the fallback for a caller that cannot resolve.
  expect(parsed.ref).toBe("feature");
  expect(parsed.subpath).toBe("login/skills/pdf");
});
