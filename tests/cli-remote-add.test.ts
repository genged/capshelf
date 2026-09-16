import { expect, test } from "bun:test";
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  arrayField,
  jsonOutput,
  runInProcess,
} from "./cli-fixtures";
import { initRemoteProject, upstreamWith } from "./remote-fixtures";
import { parseRemoteSkillUrl } from "../src/remote-url";
import { setPickContext } from "../src/pick";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { pickRowId } from "../src/pick-core";

const initProject = initRemoteProject;

test(
  "add <url> installs one skill, records a remote row, and does not commit it",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const run = runInProcess(project);

    const result = await run(["add", url, "--yes", "--json"], env);
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    expect(payload.verb).toBe("add");
    expect(payload.source).toBe("remote");
    expect(payload.kind).toBe("skills");
    expect(payload.name).toBe("pdf");
    expect(payload.scope).toBe("local");
    expect(payload.action).toBe("created");
    expect(payload.subpath).toBe("skills/pdf");

    expect(existsSync(join(project, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    const lock = JSON.parse(
      await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
    );
    expect(Object.keys(lock.items)).toEqual(["remote/skills/pdf"]);
    expect(lock.items["remote/skills/pdf"].ref).toBe("main");

    const tracked =
      await $`git -C ${project} ls-files .capshelf/remotes.lock.json`
        .quiet()
        .text();
    expect(tracked.trim()).toBe("");
    const exclude = await readFile(join(project, ".git/info/exclude"), "utf-8");
    expect(exclude).toContain(".agents/skills/pdf/");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a second add of the same URL is a byte-stable no-op",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const run = runInProcess(project);
    await run(["add", url, "--yes", "--json"], env);
    const before = await readFile(
      join(project, ".capshelf", "remotes.lock.json"),
      "utf-8",
    );

    const again = await run(["add", url, "--yes", "--json"], env);
    expect(again.exitCode).toBe(0);
    expect(jsonOutput(again).action).toBe("already-current");
    expect(
      await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
    ).toBe(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "two candidates without a terminal refuse and name --list and --path",
  async () => {
    const { url } = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("--list");
    expect(stderr).toContain("--path");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--path installs exactly the named candidate",
  async () => {
    const { url } = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "skills/xlsx", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(jsonOutput(result).name).toBe("xlsx");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--as renames the installed skill",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--as", "pdf-reader", "--yes", "--json"],
      env,
    );
    expect(jsonOutput(result).name).toBe("pdf-reader");
    expect(
      existsSync(join(project, ".agents/skills/pdf-reader/SKILL.md")),
    ).toBe(true);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "owner/repo shorthand exits 3 and names the full URL",
  async () => {
    const { project } = await initProject();
    const result = await runInProcess(project)([
      "add",
      "vercel-labs/agent-skills",
      "--json",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "https://github.com/vercel-labs/agent-skills",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a URL whose resolved path has no SKILL.md names the path it read",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "skills/missing", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("skills/missing");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a name already owned by the project lock is refused and names that lock",
  async () => {
    const { url } = await upstreamWith([["skills/placeholder", "Collides"]]);
    const { project, env } = await initProject();
    const run = runInProcess(project);
    await run(["add", "skills/placeholder", "--json"]);
    const result = await run(["add", url, "--yes", "--json"], env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toMatch(
      /capshelf\.lock\.json|project scope/,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list prints the candidates, writes nothing, and exits 0",
  async () => {
    const { url } = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    expect(payload.repo).toBe(parseRemoteSkillUrl(url).upstream);
    expect(arrayField(payload, "skills")).toHaveLength(2);
    expect(existsSync(join(project, ".capshelf", "remotes.lock.json"))).toBe(
      false,
    );
    expect(existsSync(join(project, ".agents/skills/pdf"))).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "an unreadable ref is refused and names the ref and the repository",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--ref", "no-such-branch", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("no-such-branch");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a tree whose item root holds a symlink is refused before any write",
  async () => {
    const { url, work } = await upstreamWith([["skills/pdf", "Extract text"]]);
    await $`ln -s /etc/passwd ${join(work, "skills/pdf/link")}`.quiet();
    await $`git -C ${work} add -A`.quiet();
    await $`git -C ${work} commit -qm symlink`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("skills/pdf/link");
    expect(existsSync(join(project, ".agents/skills/pdf"))).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a tree that declares an external filter driver is refused before any write",
  async () => {
    // PIN-9 is the guard a third-party repository is most likely to meet.
    // Claiming it fires without proving it is the shape this work exists to
    // prevent.
    const { url, work } = await upstreamWith([["skills/pdf", "Extract text"]]);
    await writeFile(
      join(work, ".gitattributes"),
      "skills/pdf/** filter=secret\n",
    );
    await $`git -C ${work} add -A`.quiet();
    await $`git -C ${work} commit -qm "filter driver"`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("filter=secret");
    expect(existsSync(join(project, ".agents/skills/pdf"))).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the picker installs several skills from one clone",
  async () => {
    const { url } = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
      ["skills/docx", "Edit documents"],
    ]);
    const { project, env } = await initProject();
    const outer = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows
          .filter((row) => row.name === "pdf" || row.name === "xlsx")
          .map(pickRowId),
      }),
    });
    try {
      const result = await runInProcess(project)(["add", url, "--yes"], env);
      expect(result.exitCode).toBe(0);
    } finally {
      setPickContext(outer);
    }

    expect(existsSync(join(project, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents/skills/xlsx/SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(project, ".agents/skills/docx"))).toBe(false);
    const lock = JSON.parse(
      await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
    );
    expect(Object.keys(lock.items).sort()).toEqual([
      "remote/skills/pdf",
      "remote/skills/xlsx",
    ]);
    // One clone serves every skill in the repository.
    const clones = await $`find ${env.XDG_DATA_HOME} -name .git -type d`
      .quiet()
      .text();
    expect(clones.trim().split("\n").filter(Boolean)).toHaveLength(1);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a non-TTY run without --yes refuses at the consent gate and writes nothing",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--json"], env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain("--yes");
    expect(existsSync(join(project, ".agents/skills/pdf"))).toBe(false);
    expect(existsSync(join(project, ".capshelf", "remotes.lock.json"))).toBe(
      false,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the remote-only flags are refused on a shelf item ref",
  async () => {
    const { project } = await initProject();
    const run = runInProcess(project);
    for (const flag of [
      ["--as", "other"],
      ["--ref", "main"],
      ["--path", "skills/pdf"],
    ] as const) {
      const result = await run([
        "add",
        "skills/placeholder",
        ...flag,
        "--json",
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(flag[0]);
    }
    const listed = await run(["add", "skills/placeholder", "--list", "--json"]);
    expect(listed.exitCode).toBe(3);
    expect(listed.stderr.toString()).toContain("--list");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "declining the second skill keeps the first one's record",
  async () => {
    // The rest of the feature never leaves content with no owner: bytes are
    // written, then the record, and a crash between two items leaves two
    // owners rather than none. A multi-install has to follow the same rule, or
    // the installed directory becomes invisible to every other command and a
    // later `add` refuses it as an unmanaged path.
    const { url } = await upstreamWith([
      ["skills/pdf", "Extract text"],
      ["skills/xlsx", "Read workbooks"],
    ]);
    const { project, env } = await initProject();
    const answers = ["y", "n"];
    const outerPick = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows.map(pickRowId),
      }),
    });
    const outerConfirm = setDestructiveConfirmationContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async () => answers.shift() ?? "n",
      stderr: { write: () => {} },
    });
    try {
      await runInProcess(project)(["add", url], env);
    } finally {
      setPickContext(outerPick);
      setDestructiveConfirmationContext(outerConfirm);
    }

    const installed = existsSync(join(project, ".agents/skills/pdf/SKILL.md"));
    expect(installed).toBe(true);
    const lock = JSON.parse(
      await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
    );
    expect(Object.keys(lock.items)).toEqual(["remote/skills/pdf"]);
    expect(existsSync(join(project, ".agents/skills/xlsx"))).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
