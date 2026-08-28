import { $, file } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  baselineRepo,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import type { DestructiveConfirmationContext } from "../src/destructive-change";
import { setPickContext } from "../src/pick";
import type { PickContext, PickRequest } from "../src/pick";

/**
 * The interactive share and promote paths, driven through the `setPickContext`
 * and `setDestructiveConfirmationContext` seams rather than a pseudo-terminal.
 * The terminal itself is covered end-to-end in `e2e/environments/`; what these
 * tests hold is which rows reach the picker, how marks group into share and
 * promote invocations, and what happens to the result.
 */

let installedPick = false;
let previousPick: PickContext | null = null;
let installedConfirmation = false;
let previousConfirmation: DestructiveConfirmationContext | null = null;

function installPick(context: PickContext): void {
  previousPick = setPickContext(context);
  installedPick = true;
}

/** A terminal-backed context that answers the name prompt from a queue. */
function installNamePrompt(answers: string[]): { asked: string[] } {
  const asked: string[] = [];
  previousConfirmation = setDestructiveConfirmationContext({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (message) => {
      asked.push(message);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("name prompt ran dry");
      return answer;
    },
    stderr: { write: () => true },
  });
  installedConfirmation = true;
  return { asked };
}

afterEach(() => {
  if (installedPick) {
    setPickContext(previousPick);
    installedPick = false;
    previousPick = null;
  }
  if (installedConfirmation) {
    setDestructiveConfirmationContext(previousConfirmation);
    installedConfirmation = false;
    previousConfirmation = null;
  }
});

/** Install a picker that records the request and answers with row ids chosen by `select`. */
function answerWith(select: (request: PickRequest) => string[]): {
  seen: PickRequest[];
} {
  const seen: PickRequest[] = [];
  installPick({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (request) => {
      seen.push(request);
      return { kind: "picked", refs: select(request) };
    },
  });
  return { seen };
}

async function initializedProject(prefix: string): Promise<{
  project: string;
  dataRepo: string;
  run: ReturnType<typeof runInProcess>;
}> {
  const project = await tempRepo(`${prefix}project-`);
  const dataRepo = await baselineRepo(`${prefix}data-`);
  const run = runInProcess(project);
  const init = await run(["init", "--data", dataRepo, "--no-upstream"]);
  expect(init.exitCode).toBe(0);
  return { project, dataRepo, run };
}

const SETTINGS = {
  permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm)"] },
  env: { FOO: "bar" },
};

describe("share with no item — refusals and empty state", () => {
  test(
    "flags that describe one named share are refused without an item",
    async () => {
      const { run } = await initializedProject("capshelf-shareflags-");
      const json = await run(["share", "--json"]);
      expect(json.exitCode).toBe(3);
      expect(json.stderr.toString()).toContain("share --json requires an item");

      const picked = await run(["share", "--pick", "env"]);
      expect(picked.exitCode).toBe(3);
      expect(picked.stderr.toString()).toContain("require an item");

      // Explicitly empty is still explicitly supplied: commander stores
      // `--from ""` as an empty string, which truthiness would miss.
      const emptyFrom = await run(["share", "--from", ""]);
      expect(emptyFrom.exitCode).toBe(3);
      expect(emptyFrom.stderr.toString()).toContain("require an item");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "without a terminal the offer is refused with the non-interactive form",
    async () => {
      // `runInProcess` installs a non-TTY pick context by default.
      const { run } = await initializedProject("capshelf-sharenotty-");
      const refused = await run(["share"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain("cannot pick interactively");
      expect(refused.stderr.toString()).toContain("--pick");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "no unmanaged values prints what was looked in and exits 0",
    async () => {
      const { run } = await initializedProject("capshelf-shareempty-");
      const { seen } = answerWith(() => {
        throw new Error("the picker must not open for an empty catalog");
      });
      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);
      const stdout = result.stdout.toString();
      expect(stdout).toContain(
        "nothing to share: no unmanaged values or untracked items in",
      );
      expect(stdout).toContain(".mcp.json (absent)");
      // The scanned item locations too: tracked system skills contribute no
      // rows, so an initialized project is still empty.
      expect(stdout).toContain(".agents/skills");
      expect(stdout).toContain(".claude/agents (absent)");
      expect(seen).toHaveLength(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("share with no item — the picker flow", () => {
  test(
    "marked settings paths become one named fragment and print the command that repeats it",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharepick-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS, null, 2),
      );
      const { seen } = answerWith((request) => {
        const wanted = new Set(["permissions.allow", "permissions.deny"]);
        return request.rows
          .filter((row) => wanted.has(row.ref))
          .map((row) => row.id as string);
      });
      installNamePrompt(["perms"]);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);

      // The catalog offered every node of the remainder, parents included.
      expect(seen[0]?.rows.map((row) => row.ref)).toEqual([
        "permissions",
        "permissions.allow",
        "permissions.deny",
        "env",
        "env.FOO",
      ]);

      // The fragment holds exactly the marked paths.
      const fragment = JSON.parse(
        await file(join(dataRepo, "settings", "perms", "settings.json")).text(),
      );
      expect(fragment).toEqual({
        permissions: SETTINGS.permissions,
      });

      // The printed command is the non-interactive form that repeats this.
      const stdout = result.stdout.toString();
      expect(stdout).toContain(
        "capshelf share settings/perms --pick permissions.allow --pick permissions.deny",
      );
      expect(stdout).toContain("✓ shared project/data/settings/perms @");
      expect(stdout).toContain("1 shared");

      // The unmarked value stayed unmanaged in the output.
      const output = JSON.parse(
        await file(join(project, ".claude", "settings.json")).text(),
      );
      expect(output.env).toEqual({ FOO: "bar" });

      const manifest = JSON.parse(
        await file(join(project, ".capshelf", "capshelf.json")).text(),
      );
      expect(manifest.settings).toEqual(["perms"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the name prompt refuses an existing or system name and asks again",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharename-",
      );
      await mkdir(join(dataRepo, "settings", "taken"), { recursive: true });
      await writeFile(
        join(dataRepo, "settings", "taken", "settings.json"),
        JSON.stringify({ env: { X: "1" } }),
      );
      await $`git -C ${dataRepo} add settings`.quiet();
      await $`git -C ${dataRepo} commit -qm taken`.quiet();
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "env")
          .map((row) => row.id as string),
      );
      const { asked } = installNamePrompt(["capshelf", "taken", "fresh"]);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);
      expect(asked).toHaveLength(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("system item name");
      expect(stderr).toContain("settings/taken/settings.json");
      expect(
        existsSync(join(dataRepo, "settings", "fresh", "settings.json")),
      ).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an empty answer to the name prompt skips the item and exits 0",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-shareskip-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "env")
          .map((row) => row.id as string),
      );
      installNamePrompt([""]);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("settings item skipped");
      expect(existsSync(join(dataRepo, "settings"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a value that changed while the picker was open fails that row, not commits it",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharestale-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      // The picker holds the terminal for an unbounded time. Mutate the marked
      // value from inside the prompt, which is exactly a concurrent tool
      // writing into the output while the frame is open.
      answerWith((request) => {
        writeFileSync(
          join(project, ".claude", "settings.json"),
          JSON.stringify({ ...SETTINGS, env: { FOO: "leaked-token" } }),
        );
        return request.rows
          .filter((row) => row.ref === "env.FOO")
          .map((row) => row.id as string);
      });
      installNamePrompt(["envs"]);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("env.FOO changed while the picker was open");
      expect(stderr).toContain("retry: capshelf share settings/envs");
      // Nothing was committed from the stale mark: the consent was for the
      // value the frame showed, not for whatever arrived afterwards.
      expect(existsSync(join(dataRepo, "settings"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "mcp marks decide --target: both rows drop it, one row adds it",
    async () => {
      const { project, dataRepo, run } =
        await initializedProject("capshelf-sharemcp-");
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            github: { command: "github-mcp" },
            posthog: { command: "posthog-mcp" },
          },
        }),
      );
      await mkdir(join(project, ".codex"), { recursive: true });
      await writeFile(
        join(project, ".codex", "config.toml"),
        '[mcp_servers.github]\ncommand = "github-mcp"\n',
      );
      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "github" || row.ref === "posthog")
          .map((row) => row.id as string),
      );

      const result = await run(["share", "-m", "reviewed config"]);
      expect(result.exitCode).toBe(0);
      // github appears once per output file; posthog once.
      const refs = seen[0]?.rows.map((row) => row.ref) ?? [];
      expect(refs.filter((ref) => ref === "github")).toHaveLength(2);
      expect(refs.filter((ref) => ref === "posthog")).toHaveLength(1);

      // Both github rows marked: the item covers both outputs, no --target.
      expect(existsSync(join(dataRepo, "mcp", "github", "claude.json"))).toBe(
        true,
      );
      expect(existsSync(join(dataRepo, "mcp", "github", "codex.toml"))).toBe(
        true,
      );
      // One posthog row marked: the command carries its target.
      expect(existsSync(join(dataRepo, "mcp", "posthog", "claude.json"))).toBe(
        true,
      );
      expect(existsSync(join(dataRepo, "mcp", "posthog", "codex.toml"))).toBe(
        false,
      );

      const stdout = result.stdout.toString();
      // The equivalent command carries the explicit commit message: the
      // command claims to repeat the share, and the message is part of it.
      expect(stdout).toContain(
        "capshelf share mcp/github -m 'reviewed config'\n",
      );
      expect(stdout).toContain(
        "capshelf share mcp/posthog --target claude -m 'reviewed config'",
      );
      expect(stdout).toContain("2 shared");
      // The guidance prints once for the whole run, not once per item.
      expect(stdout.split("committed to local data repo:").length - 1).toBe(1);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a legacy lock is refused before the prompt opens and before any commit",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharev3lock-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      // A version-3 lock. The refusal must land before the picker holds the
      // terminal and before `shareFragment` can commit to the data repo.
      await writeFile(
        join(project, ".capshelf", "capshelf.lock.json"),
        JSON.stringify({ version: 3, items: {} }),
      );
      const { seen } = answerWith(() => {
        throw new Error("the picker must not open on a legacy lock");
      });

      const result = await run(["share"]);
      expect(result.exitCode).toBe(3);
      expect(seen).toHaveLength(0);
      expect(existsSync(join(dataRepo, "settings"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one unreadable output degrades to a diagnostic row, not an empty or failed picker",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharebrokentoml-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      await mkdir(join(project, ".codex"), { recursive: true });
      await writeFile(join(project, ".codex", "config.toml"), "[[[not toml");
      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "env.FOO")
          .map((row) => row.id as string),
      );
      installNamePrompt(["envs"]);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);
      const rows = seen[0]?.rows ?? [];
      const broken = rows.find((row) => row.ref === ".codex/config.toml");
      expect(broken?.disabled).toBe(true);
      expect(broken?.detail).toContain("cannot read this output");
      // The other output's values stayed shareable.
      expect(
        existsSync(join(dataRepo, "settings", "envs", "settings.json")),
      ).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an explicit --data override survives into the equivalent command",
    async () => {
      // Without the flag, a rerun would resolve the machine-local binding —
      // a different repository than the one this share committed to.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharedata-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      const named = await run([
        "--data",
        dataRepo,
        "share",
        "settings/envs",
        "--pick",
        "env.FOO",
      ]);
      expect(named.exitCode).toBe(0);
      expect(named.stdout.toString()).toContain(
        `capshelf --data ${dataRepo} share settings/envs --pick env.FOO`,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a forged mark of an unaddressable server name fails at the ref boundary",
    async () => {
      // The catalog disables a reserved server name, but a mark is data, and
      // `shareFragment` takes the name without re-parsing. Returning the
      // disabled row's id from an injected context stands in for any path
      // that bypasses the frame.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharebadname-",
      );
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { capshelf: { command: "x" } } }),
      );
      const { seen } = answerWith((request) =>
        request.rows.map((row) => row.id as string),
      );

      const result = await run(["share"]);
      expect(result.exitCode).toBe(3);
      expect(seen[0]?.rows[0]?.disabled).toBe(true);
      expect(result.stderr.toString()).toContain("system item");
      expect(existsSync(join(dataRepo, "mcp"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the printed command reproduces the same fragment in a fresh project",
    async () => {
      const first = await initializedProject("capshelf-sharert1-");
      await mkdir(join(first.project, ".claude"), { recursive: true });
      await writeFile(
        join(first.project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "permissions.allow")
          .map((row) => row.id as string),
      );
      installNamePrompt(["perms"]);
      const picked = await first.run(["share"]);
      expect(picked.exitCode).toBe(0);
      const command = picked.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("capshelf share "));
      expect(command).toBe(
        "capshelf share settings/perms --pick permissions.allow",
      );

      // Run the printed command, word for word, in a fresh project.
      const second = await initializedProject("capshelf-sharert2-");
      await mkdir(join(second.project, ".claude"), { recursive: true });
      await writeFile(
        join(second.project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      const args = (command as string).split(" ").slice(1);
      const repeated = await second.run(args);
      expect(repeated.exitCode).toBe(0);

      // Same data-repo tree for the item: identical blob content.
      const firstBlob = await file(
        join(first.dataRepo, "settings", "perms", "settings.json"),
      ).text();
      const secondBlob = await file(
        join(second.dataRepo, "settings", "perms", "settings.json"),
      ).text();
      expect(secondBlob).toBe(firstBlob);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("share with no item — untracked items", () => {
  test(
    "an untracked skill is offered, shares to local scope, and prints the command that repeats it",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-shareskill-",
      );
      await mkdir(join(project, ".agents", "skills", "hello"), {
        recursive: true,
      });
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "hello\n",
      );
      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "hello")
          .map((row) => row.id as string),
      );

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);

      const rows = seen[0]?.rows ?? [];
      const row = rows.find((r) => r.ref === "hello");
      expect(row?.kind).toBe("skills");
      expect(row?.detail).toContain(".agents/skills/hello");
      expect(row?.detail).toContain("1 file");
      // Tracked system skills contribute no rows: the scanner offers only
      // what no lock entry claims.
      expect(rows.filter((r) => r.kind === "skills")).toHaveLength(1);

      const stdout = result.stdout.toString();
      // The named command's default scope for skills is local, so the printed
      // command needs no --to flag to repeat this share.
      expect(stdout).toContain("✓ shared local/data/skills/hello @");
      expect(stdout).toContain("capshelf share skills/hello");
      expect(stdout).toContain("1 shared");
      expect(existsSync(join(dataRepo, "skills", "hello", "SKILL.md"))).toBe(
        true,
      );
      const localLock = JSON.parse(
        await file(join(project, ".capshelf", "local.lock.json")).text(),
      );
      expect(localLock.items["data/skills/hello"]).toBeDefined();
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "subagent rows are one per output file, and the marked outputs decide --target",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-sharesubagent-",
      );
      const claudeAgents = join(project, ".claude", "agents");
      const codexAgents = join(project, ".codex", "agents");
      await mkdir(claudeAgents, { recursive: true });
      await mkdir(codexAgents, { recursive: true });
      const frontmatter = (name: string): string =>
        `---\nname: ${name}\ndescription: reviews\n---\nbody\n`;
      await writeFile(
        join(claudeAgents, "reviewer.md"),
        frontmatter("reviewer"),
      );
      await writeFile(
        join(codexAgents, "reviewer.toml"),
        'name = "reviewer"\ndescription = "reviews"\ndeveloper_instructions = "review"\n',
      );
      await writeFile(join(claudeAgents, "solo.md"), frontmatter("solo"));
      // An invalid source would fail every time after selection, so it must
      // be a visible, disabled row instead of an enabled trap.
      await writeFile(join(claudeAgents, "broken.md"), "no frontmatter\n");
      const { seen } = answerWith((request) =>
        request.rows
          .filter(
            (row) =>
              row.ref === "solo" ||
              (row.ref === "reviewer" &&
                row.detail?.includes(".claude/agents/reviewer.md") === true),
          )
          .map((row) => row.id as string),
      );

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);

      const rows = seen[0]?.rows ?? [];
      expect(rows.filter((r) => r.ref === "reviewer")).toHaveLength(2);
      const broken = rows.find((r) => r.ref === "broken");
      expect(broken?.disabled).toBe(true);
      expect(broken?.detail).toContain("frontmatter");

      // One of two reviewer outputs marked: the share carries its target and
      // commits only that canonical source.
      expect(
        existsSync(join(dataRepo, "subagents", "reviewer", "claude.md")),
      ).toBe(true);
      expect(
        existsSync(join(dataRepo, "subagents", "reviewer", "codex.toml")),
      ).toBe(false);
      const stdout = result.stdout.toString();
      expect(stdout).toContain(
        "capshelf share subagents/reviewer --target claude",
      );
      // solo's only output was marked, so its command needs no flag.
      expect(stdout).toContain("capshelf share subagents/solo\n");
      expect(existsSync(join(dataRepo, "subagents", "solo", "claude.md"))).toBe(
        true,
      );
      expect(stdout).toContain("2 shared");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an item the named share would refuse is a disabled row that names the reason",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-shareitemrefused-",
      );
      // Already on the shelf under the same name.
      await mkdir(join(dataRepo, "skills", "taken"), { recursive: true });
      await writeFile(join(dataRepo, "skills", "taken", "SKILL.md"), "x\n");
      await $`git -C ${dataRepo} add skills`.quiet();
      await $`git -C ${dataRepo} commit -qm taken`.quiet();
      await mkdir(join(project, ".agents", "skills", "taken"), {
        recursive: true,
      });
      await writeFile(
        join(project, ".agents", "skills", "taken", "SKILL.md"),
        "local\n",
      );
      // A directory that is not a valid skill.
      await mkdir(join(project, ".agents", "skills", "noskill"), {
        recursive: true,
      });
      await writeFile(
        join(project, ".agents", "skills", "noskill", "notes.txt"),
        "notes\n",
      );
      const { seen } = answerWith(() => []);

      const result = await run(["share"]);
      expect(result.exitCode).toBe(0);
      const rows = seen[0]?.rows ?? [];
      const taken = rows.find((r) => r.ref === "taken");
      expect(taken?.disabled).toBe(true);
      expect(taken?.detail).toContain("already on the shelf as skills/taken");
      const noskill = rows.find((r) => r.ref === "noskill");
      expect(noskill?.disabled).toBe(true);
      expect(noskill?.detail).toContain("missing SKILL.md");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a skill edited while the picker was open fails that row, not commits it",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-shareitemstale-",
      );
      const skillFile = join(project, ".agents", "skills", "hello", "SKILL.md");
      await mkdir(join(project, ".agents", "skills", "hello"), {
        recursive: true,
      });
      await writeFile(skillFile, "hello\n");
      answerWith((request) => {
        writeFileSync(skillFile, "changed under the open frame\n");
        return request.rows
          .filter((row) => row.ref === "hello")
          .map((row) => row.id as string);
      });

      const result = await run(["share"]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(
        "skills/hello changed while the picker was open",
      );
      expect(existsSync(join(dataRepo, "skills"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("promote with no item", () => {
  test(
    "per-item flags and --json are refused without an item",
    async () => {
      const { run } = await initializedProject("capshelf-promoteflags-");
      const json = await run(["promote", "--json"]);
      expect(json.exitCode).toBe(3);
      expect(json.stderr.toString()).toContain(
        "promote --json requires an item",
      );
      const stale = await run(["promote", "--stale-ok"]);
      expect(stale.exitCode).toBe(3);
      expect(stale.stderr.toString()).toContain("require an item");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "without a terminal the offer is refused; with nothing tracked it exits 0",
    async () => {
      const { run } = await initializedProject("capshelf-promoteempty-");
      const refused = await run(["promote"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain("cannot pick interactively");

      const { seen } = answerWith(() => {
        throw new Error("the picker must not open with nothing tracked");
      });
      const empty = await run(["promote"]);
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout.toString()).toContain(
        "nothing to promote: no data items tracked",
      );
      expect(seen).toHaveLength(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a dirty canonical source is offered with the file named, promotes, and a clean item is disabled",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promotepick-",
      );
      // Two tracked fragments: one will stay clean, one gets a source edit.
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      expect(
        (await run(["share", "settings/perms", "--pick", "permissions.allow"]))
          .exitCode,
      ).toBe(0);
      expect(
        (await run(["share", "settings/envs", "--pick", "env.FOO"])).exitCode,
      ).toBe(0);

      await writeFile(
        join(dataRepo, "settings", "perms", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash(ls)", "Bash(cat)"] } }),
      );

      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "settings/perms")
          .map((row) => row.id ?? row.ref),
      );
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);

      const rows = seen[0]?.rows ?? [];
      const perms = rows.find((row) => row.ref === "settings/perms");
      expect(perms?.disabled).toBeUndefined();
      expect(perms?.detail).toContain("edit ");
      expect(perms?.detail).toContain("settings/perms/settings.json");
      const envs = rows.find((row) => row.ref === "settings/envs");
      expect(envs?.disabled).toBe(true);
      expect(envs?.detail).toBe("nothing to promote");

      const stdout = result.stdout.toString();
      expect(stdout).toContain("✓ promoted data/settings/perms @");
      expect(stdout).toContain("1 promoted");
      expect(stdout).toContain("committed to local data repo:");
      // The data repo actually has the commit.
      const log = await $`git -C ${dataRepo} log --oneline`.quiet().text();
      expect(log).toContain("capshelf: settings/perms");
      const porcelain = await $`git -C ${dataRepo} status --porcelain`
        .quiet()
        .text();
      expect(porcelain.trim()).toBe("");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an index flag replaces the clean row's reason with what git is not watching",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promoteflag-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      expect(
        (await run(["share", "settings/perms", "--pick", "permissions.allow"]))
          .exitCode,
      ).toBe(0);
      const relPath = "settings/perms/settings.json";
      await $`git -C ${dataRepo} update-index --assume-unchanged ${relPath}`.quiet();
      await writeFile(
        join(dataRepo, relPath),
        JSON.stringify({ permissions: { allow: ["Bash(hidden)"] } }),
      );

      const { seen } = answerWith(() => []);
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const row = seen[0]?.rows.find((r) => r.ref === "settings/perms");
      expect(row?.disabled).toBe(true);
      expect(row?.detail).toBe(`git is not watching ${relPath}`);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an index flag on a copy item's source file relabels its clean row too",
    async () => {
      // The porcelain blind spot is not a fragment property. A flagged file
      // inside a skill's directory leaves `git status` silent, the state
      // machine says `ok`, and without the relabel the row would claim
      // "nothing to promote" for a hidden edit.
      const { dataRepo, run } = await initializedProject(
        "capshelf-promoteskillflag-",
      );
      await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
      await $`git -C ${dataRepo} add skills`.quiet();
      await $`git -C ${dataRepo} commit -qm hello`.quiet();
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      const relPath = "skills/hello/SKILL.md";
      await $`git -C ${dataRepo} update-index --assume-unchanged ${relPath}`.quiet();
      await writeFile(join(dataRepo, relPath), "hello hidden edit\n");

      const { seen } = answerWith(() => []);
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const row = seen[0]?.rows.find((r) => r.ref === "skills/hello");
      expect(row?.disabled).toBe(true);
      expect(row?.detail).toBe(`git is not watching ${relPath}`);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a hidden path disables the row even when another edit would offer it",
    async () => {
      // With one file flagged and the installed copy edited, the state is
      // `drifted_local` and would be offered — but promoting would rewrite
      // the canonical tree while git silently discards the hidden worktree
      // edit. The hidden path wins: the row is disabled and names it.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promotehiddenedit-",
      );
      await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
      await writeFile(join(dataRepo, "skills", "hello", "extra.md"), "extra\n");
      await $`git -C ${dataRepo} add skills`.quiet();
      await $`git -C ${dataRepo} commit -qm hello`.quiet();
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      const relPath = "skills/hello/extra.md";
      await $`git -C ${dataRepo} update-index --assume-unchanged ${relPath}`.quiet();
      await writeFile(join(dataRepo, relPath), "hidden edit\n");
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "hello v2\n",
      );

      const { seen } = answerWith(() => []);
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const row = seen[0]?.rows.find((r) => r.ref === "skills/hello");
      expect(row?.disabled).toBe(true);
      expect(row?.detail).toBe(`git is not watching ${relPath}`);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a flag set while the picker was open fails the row before anything is written",
    async () => {
      // The catalog's hidden-path check goes stale during the unbounded
      // prompt wait. Setting the flag from inside the prompt stands in for a
      // concurrent process doing it while the frame is open.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promotelateflag-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      expect(
        (await run(["share", "settings/perms", "--pick", "permissions.allow"]))
          .exitCode,
      ).toBe(0);
      const relPath = "settings/perms/settings.json";
      await writeFile(
        join(dataRepo, relPath),
        JSON.stringify({ permissions: { allow: ["Bash(edited)"] } }),
      );
      answerWith((request) => {
        Bun.spawnSync({
          cmd: ["git", "update-index", "--assume-unchanged", relPath],
          cwd: dataRepo,
        });
        return request.rows
          .filter((row) => row.ref === "settings/perms")
          .map((row) => row.id ?? row.ref);
      });

      const result = await run(["promote"]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(
        `git is not watching ${relPath}`,
      );
      // One commit only — the share's own. The promote wrote nothing.
      const log = await $`git -C ${dataRepo} log --oneline`.quiet().text();
      expect(log.split("capshelf: settings/perms").length - 1).toBe(1);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one item's broken state degrades its own row and leaves the rest promotable",
    async () => {
      // Deriving fragment `a`'s state loads every settings fragment for its
      // output, so fragment `b`'s unreachable commit throws inside `a`'s
      // derivation. The catalog must not abort: `a` degrades to a disabled
      // row naming the failure, `b` gets its own row, and an unrelated dirty
      // skill stays offered — a named promote of that skill would succeed.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promotedegrade-",
      );
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        JSON.stringify(SETTINGS),
      );
      expect(
        (await run(["share", "settings/a", "--pick", "permissions.allow"]))
          .exitCode,
      ).toBe(0);
      expect(
        (await run(["share", "settings/b", "--pick", "env.FOO"])).exitCode,
      ).toBe(0);
      await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
      await $`git -C ${dataRepo} add skills`.quiet();
      await $`git -C ${dataRepo} commit -qm hello`.quiet();
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "hello v2\n",
      );
      // Corrupt b's pinned commit. Explicitly a lock fixture for this test.
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lock = JSON.parse(await file(lockPath).text());
      lock.items["data/settings/b"].sourceCommit =
        "0123456789012345678901234567890123456789";
      await writeFile(lockPath, JSON.stringify(lock, null, 2));

      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "skills/hello")
          .map((row) => row.id ?? row.ref),
      );
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const rows = seen[0]?.rows ?? [];
      const rowA = rows.find((r) => r.ref === "settings/a");
      expect(rowA?.disabled).toBe(true);
      expect(rowA?.detail).toContain("state unavailable");
      const rowB = rows.find((r) => r.ref === "settings/b");
      expect(rowB?.disabled).toBe(true);
      const skill = rows.find((r) => r.ref === "skills/hello");
      expect(skill?.disabled).toBeUndefined();
      expect(result.stdout.toString()).toContain(
        "✓ promoted data/skills/hello @",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an ordinary untracked canonical source stays offered, not called unwatched",
    async () => {
      // The precision half: `git status` reports a plain new file as `??`, so
      // it is publishable and the row must stay markable. Only an ignore rule
      // or an index flag makes a path genuinely invisible.
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promoteuntracked-",
      );
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { github: { command: "x" } } }),
      );
      expect(
        (await run(["share", "mcp/github", "--target", "claude"])).exitCode,
      ).toBe(0);
      await writeFile(
        join(dataRepo, "mcp", "github", "codex.toml"),
        '[mcp_servers.github]\ncommand = "x"\n',
      );

      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "mcp/github")
          .map((row) => row.id ?? row.ref),
      );
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const row = seen[0]?.rows.find((r) => r.ref === "mcp/github");
      expect(row?.disabled).toBeUndefined();
      expect(result.stdout.toString()).toContain("✓ promoted data/mcp/github");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an edited installed skill is offered with the installed path named",
    async () => {
      const { project, dataRepo, run } = await initializedProject(
        "capshelf-promoteskill-",
      );
      await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
      await $`git -C ${dataRepo} add skills`.quiet();
      await $`git -C ${dataRepo} commit -qm hello`.quiet();
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      await writeFile(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        "hello v2\n",
      );

      const { seen } = answerWith((request) =>
        request.rows
          .filter((row) => row.ref === "skills/hello")
          .map((row) => row.id ?? row.ref),
      );
      const result = await run(["promote"]);
      expect(result.exitCode).toBe(0);
      const row = seen[0]?.rows.find((r) => r.ref === "skills/hello");
      expect(row?.disabled).toBeUndefined();
      expect(row?.detail).toContain("edited ");
      expect(row?.detail).toContain("skills/hello");
      expect(result.stdout.toString()).toContain(
        "✓ promoted data/skills/hello @",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
