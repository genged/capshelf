import { file } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { setPickContext } from "../src/pick";
import type { PickContext, PickRequest } from "../src/pick";

/**
 * The interactive install path, driven through the `setPickContext` seam
 * rather than a pseudo-terminal. The terminal itself belongs to
 * `@clack/prompts` and is covered end-to-end; what capshelf owns, and what
 * these tests hold, is which rows reach the picker and what happens to the
 * refs it returns.
 */

/**
 * Whether this file installed a context, tracked apart from the value it
 * replaced.
 *
 * `setPickContext` returns the previous context, and that is `null` for the
 * first install — so a single "restore" variable cannot tell "nothing to undo"
 * from "undo back to null". Testing the value alone left the first test's
 * interactive prompt installed for every test after it, and `runInProcess`
 * deliberately keeps an outer context, so test order decided whether an
 * unrelated `init` prompted.
 */
let installedContext = false;
let previousContext: PickContext | null = null;

function installPick(context: PickContext): void {
  previousContext = setPickContext(context);
  installedContext = true;
}

function restorePick(): void {
  if (!installedContext) return;
  setPickContext(previousContext);
  installedContext = false;
  previousContext = null;
}

afterEach(restorePick);

interface PickLog {
  seen: PickRequest[];
}

/** Install a picker that records the rows it was offered and answers `refs`. */
function answerWith(refs: string[]): PickLog {
  const seen: PickRequest[] = [];
  installPick({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (request) => {
      seen.push(request);
      return { kind: "picked", refs };
    },
  });
  return { seen };
}

function answerCancel(): void {
  installPick({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async () => ({ kind: "cancelled" }),
  });
}

async function shelf(): Promise<string> {
  const dataRepo = await tempRepo("capshelf-pick-data-");
  await addSkill(dataRepo, "security-review", "# security review\n");
  await addSkill(dataRepo, "code-review", "# code review\n");
  await mkdir(join(dataRepo, "bundles"), { recursive: true });
  await writeFile(
    join(dataRepo, "bundles", "review-kit.yml"),
    "description: Review tools\nincludes:\n  skills:\n    - code-review\n",
  );
  // Claude-only on purpose: an item covering one runtime and not the other is
  // what makes the coverage report say something a user cannot infer.
  await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
  await writeFile(
    join(dataRepo, "mcp", "github", "claude.json"),
    '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
  );
  await commitAll(dataRepo, "shelf");
  return dataRepo;
}

const skillPath = (project: string, name: string): string =>
  join(project, ".claude", "skills", name, "SKILL.md");

describe("capshelf init offers the shelf", () => {
  test(
    "installs the picked items into a project that init just created",
    async () => {
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const { seen } = answerWith(["skills/security-review"]);

      const result = await runInProcess(project)(["init", "--data", dataRepo]);

      expect(result.exitCode).toBe(0);
      expect(seen.length).toBe(1);
      expect(existsSync(skillPath(project, "security-review"))).toBe(true);
      const manifest = await file(
        join(project, ".capshelf", "capshelf.json"),
      ).json();
      expect(manifest.skills).toEqual(["security-review"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "offers every item and bundle on the shelf",
    async () => {
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const { seen } = answerWith([]);

      await runInProcess(project)(["init", "--data", dataRepo]);

      expect(seen[0]?.rows.map((row) => row.ref).sort()).toEqual([
        "bundles/review-kit",
        "mcp/github",
        "skills/code-review",
        "skills/security-review",
      ]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a cancelled picker still leaves an initialized project",
    async () => {
      // The point of running the picker after `local.json` is written: a user
      // who escapes out of it has a working project, not a half-built one that
      // `init` would then refuse as "already initialized".
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      answerCancel();

      const result = await runInProcess(project)(["init", "--data", dataRepo]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(project, ".capshelf", "local.json"))).toBe(true);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
      // And the recovery path is a plain `add`, which needs the binding the
      // cancelled run still wrote.
      const added = await runInProcess(project)([
        "add",
        "skills/security-review",
      ]);
      expect(added.exitCode).toBe(0);
      expect(existsSync(skillPath(project, "security-review"))).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--no-pick never reaches the picker",
    async () => {
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const { seen } = answerWith(["skills/security-review"]);

      const result = await runInProcess(project)([
        "init",
        "--no-pick",
        "--data",
        dataRepo,
      ]);

      expect(result.exitCode).toBe(0);
      expect(seen).toEqual([]);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--json keeps its machine output and installs nothing interactively",
    async () => {
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const { seen } = answerWith(["skills/security-review"]);

      const result = await runInProcess(project)([
        "init",
        "--json",
        "--data",
        dataRepo,
      ]);

      expect(result.exitCode).toBe(0);
      expect(seen).toEqual([]);
      // Still one parseable object on stdout, with nothing appended after it.
      const parsed = JSON.parse(result.stdout.toString());
      expect(parsed.project).toBe(project);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a remote --data URL reaches the picker as the local clone it created",
    async () => {
      // `--data` written before the subcommand binds to the ROOT command, so
      // the value the picker would re-resolve is the raw URL. Resolving that
      // as a path looks for a directory named `file:/...` under the project
      // and fails, taking a successful init down with it.
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const xdg = await tempDir("capshelf-pick-xdg-");
      const { seen } = answerWith(["skills/security-review"]);

      const result = await runInProcess(project)(
        ["init", "--data", `file://${dataRepo}`, "--no-upstream"],
        { XDG_DATA_HOME: xdg },
      );

      expect(result.exitCode).toBe(0);
      expect(seen[0]?.rows.map((row) => row.ref).sort()).toEqual([
        "bundles/review-kit",
        "mcp/github",
        "skills/code-review",
        "skills/security-review",
      ]);
      expect(existsSync(skillPath(project, "security-review"))).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an empty shelf is reported, not treated as a failure",
    async () => {
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await tempRepo("capshelf-pick-empty-");
      await writeFile(join(dataRepo, "README.md"), "empty\n");
      await commitAll(dataRepo, "empty");
      answerWith([]);

      const result = await runInProcess(project)(["init", "--data", dataRepo]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        "the data repo has no items or bundles yet",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("capshelf add with no item", () => {
  async function initialized(): Promise<{
    project: string;
    dataRepo: string;
  }> {
    const project = await tempRepo("capshelf-pick-project-");
    const dataRepo = await shelf();
    installPick({
      stdinIsTTY: false,
      stderrIsTTY: false,
      prompt: async () => ({ kind: "cancelled" }),
    });
    await runInProcess(project)(["init", "--data", dataRepo]);
    restorePick();
    return { project, dataRepo };
  }

  test(
    "installs the picked items",
    async () => {
      const { project } = await initialized();
      answerWith(["skills/code-review", "skills/security-review"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(skillPath(project, "code-review"))).toBe(true);
      expect(existsSync(skillPath(project, "security-review"))).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "expands a picked bundle",
    async () => {
      const { project } = await initialized();
      answerWith(["bundles/review-kit"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(skillPath(project, "code-review"))).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an item a picked bundle already installed is reported, not reinstalled",
    async () => {
      // The single-item installer has no skip guard by design, so picking both
      // a bundle and one of its members must not install the member twice.
      const { project } = await initialized();
      answerWith(["bundles/review-kit", "skills/code-review"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("already installed");
      const manifest = await file(
        join(project, ".capshelf", "capshelf.json"),
      ).json();
      expect(manifest.skills).toEqual(["code-review"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a bundle's members survive the items installed after it",
    async () => {
      // `addBundle` loads its own context and saves its own lock. If the
      // per-item pass reused a context loaded before the bundle ran, it would
      // save a lock built from a snapshot predating the bundle's entries and
      // silently drop every member.
      const { project } = await initialized();
      answerWith(["bundles/review-kit", "skills/security-review"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      const lock = await file(
        join(project, ".capshelf", "capshelf.lock.json"),
      ).json();
      expect(Object.keys(lock.items)).toContain("data/skills/code-review");
      expect(Object.keys(lock.items)).toContain("data/skills/security-review");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "selecting nothing installs nothing and succeeds",
    async () => {
      const { project } = await initialized();
      answerWith([]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(skillPath(project, "code-review"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one failed item does not discard the others",
    async () => {
      // Best effort, unlike `add bundles/<name>`: a picker selection is a pile
      // of independent choices, so a ref that cannot resolve must not throw
      // away the ones that can.
      const { project } = await initialized();
      answerWith(["skills/code-review", "skills/does-not-exist"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(3);
      expect(existsSync(skillPath(project, "code-review"))).toBe(true);
      expect(result.stdout.toString()).toContain(
        "retry: capshelf add skills/does-not-exist",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses without a terminal instead of silently doing nothing",
    async () => {
      const { project } = await initialized();
      installPick({
        stdinIsTTY: false,
        stderrIsTTY: false,
        prompt: async () => ({ kind: "cancelled" }),
      });

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("no interactive terminal");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "reports which runtimes an installed item covers",
    async () => {
      // `add` promises a per-runtime target report for mcp and subagent items,
      // and the bundled agent skill tells agents to read it. The interactive
      // path printed needs and runtime warnings but omitted it, and a coverage
      // gap is not a runtime warning, so nothing else covered for it.
      const { project } = await initialized();
      answerWith(["mcp/github"]);

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      const stdout = result.stdout.toString();
      expect(stdout).toContain("targets:");
      expect(stdout).toContain("Claude");
      expect(stdout).toContain("Codex");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a system-item name on the shelf is never offered, and is refused if picked",
    async () => {
      // `add` refuses a data-repo item whose name collides with a system item.
      // The picker skipped that check, and installed detection would not even
      // mark the row present, because the system copy is locked under
      // `system/`, not `data/`. Installing it would give two lock entries
      // ownership of one destination.
      const { project, dataRepo } = await initialized();
      await addSkill(dataRepo, "capshelf", "# impostor\n");
      await commitAll(dataRepo, "add a system-named item");

      const { seen } = answerWith(["skills/capshelf"]);
      const result = await runInProcess(project)(["add"]);

      expect(seen[0]?.rows.map((row) => row.ref)).not.toContain(
        "skills/capshelf",
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("is a system item");
      const lock = await file(
        join(project, ".capshelf", "capshelf.lock.json"),
      ).json();
      expect(Object.keys(lock.items)).not.toContain("data/skills/capshelf");
      expect(Object.keys(lock.items)).toContain("system/skills/capshelf");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an item that fails mid-install is not persisted by a later success",
    async () => {
      // `installDataItem` adds to the manifest and lock *before* it
      // materializes. A failure between those steps used to leave the entry on
      // the shared context, and the next item that succeeded saved it —
      // claiming an install that was never written.
      //
      // Constructed failure state: the skills root is made read-only so the
      // copy item cannot be materialized, while the mcp fragment writes
      // elsewhere and still succeeds.
      const { project } = await initialized();
      const skillsRoot = join(project, ".agents", "skills");
      await chmod(skillsRoot, 0o555);
      answerWith(["skills/code-review", "mcp/github"]);

      const result = await runInProcess(project)(["add"]);

      try {
        expect(result.exitCode).toBe(3);
        const manifest = await file(
          join(project, ".capshelf", "capshelf.json"),
        ).json();
        // The failed item must be absent from both, and the healthy one present.
        expect(manifest.skills).not.toContain("code-review");
        expect(manifest.mcp).toEqual(["github"]);
        const lock = await file(
          join(project, ".capshelf", "capshelf.lock.json"),
        ).json();
        expect(Object.keys(lock.items)).not.toContain(
          "data/skills/code-review",
        );
        expect(Object.keys(lock.items)).toContain("data/mcp/github");
        expect(existsSync(skillPath(project, "code-review"))).toBe(false);
      } finally {
        await chmod(skillsRoot, 0o755);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a control sequence in a catalog warning never reaches the terminal",
    async () => {
      // Warnings quote data-repo text back, and an unrecognised `includes` key
      // goes in verbatim. The picker prints them to a live terminal, and init
      // does it unprompted, so a shelf could paint over the frame or drive the
      // terminal.
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      const esc = String.fromCharCode(27);
      await writeFile(
        join(dataRepo, "bundles", "evil.yml"),
        `includes:\n  "${esc}[31mFAKE": []\n  skills:\n    - code-review\n`,
      );
      await commitAll(dataRepo, "a shelf with a hostile bundle key");

      const { seen } = answerWith([]);
      const result = await runInProcess(project)(["init", "--data", dataRepo]);

      expect(result.exitCode).toBe(0);
      expect(seen.length).toBe(1);
      const printed = result.stderr.toString() + result.stdout.toString();
      expect(printed).toContain("FAKE");
      expect(printed).not.toContain(esc);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--target with no item refuses rather than prompting",
    async () => {
      // `--target` is never supported by add. The refusal lived only in the
      // named path, so the no-argument branch returned before it and the flag
      // was silently ignored while every runtime target was written.
      const { project } = await initialized();
      const { seen } = answerWith(["skills/code-review"]);

      const result = await runInProcess(project)(["add", "--target", "codex"]);

      expect(result.exitCode).toBe(3);
      expect(seen).toEqual([]);
      expect(result.stderr.toString()).toContain(
        "add --target is not supported",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "state written while the picker is open is not discarded",
    async () => {
      // The picker holds the terminal for an unbounded time, so the context
      // read before it can be arbitrarily stale. Installing from that snapshot
      // would save a manifest and lock that predate anything another capshelf
      // run did meanwhile, silently dropping it. The prompt below installs a
      // second item mid-prompt to stand in for that concurrent run.
      const { project } = await initialized();
      installPick({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async () => {
          await runInProcess(project)(["add", "skills/security-review"]);
          return { kind: "picked", refs: ["skills/code-review"] };
        },
      });

      const result = await runInProcess(project)(["add"]);

      expect(result.exitCode).toBe(0);
      const manifest = await file(
        join(project, ".capshelf", "capshelf.json"),
      ).json();
      expect([...manifest.skills].sort()).toEqual([
        "code-review",
        "security-review",
      ]);
      const lock = await file(
        join(project, ".capshelf", "capshelf.lock.json"),
      ).json();
      expect(Object.keys(lock.items)).toContain("data/skills/security-review");
      expect(Object.keys(lock.items)).toContain("data/skills/code-review");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--json with no item refuses rather than prompting",
    async () => {
      const { project } = await initialized();
      const { seen } = answerWith(["skills/code-review"]);

      const result = await runInProcess(project)(["add", "--json"]);

      expect(result.exitCode).toBe(3);
      expect(seen).toEqual([]);
      expect(result.stderr.toString()).toContain("add --json requires an item");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an already-installed item is offered but marked so it cannot be picked",
    async () => {
      const { project } = await initialized();
      await runInProcess(project)(["add", "skills/code-review"]);
      const { seen } = answerWith([]);

      await runInProcess(project)(["add"]);

      const rows = seen[0]?.rows ?? [];
      expect(rows.find((r) => r.ref === "skills/code-review")?.installed).toBe(
        true,
      );
      expect(
        rows.find((r) => r.ref === "skills/security-review")?.installed,
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a named add is unaffected by the optional argument",
    async () => {
      const { project } = await initialized();
      const { seen } = answerWith(["skills/security-review"]);

      const result = await runInProcess(project)(["add", "skills/code-review"]);

      expect(result.exitCode).toBe(0);
      expect(seen).toEqual([]);
      expect(existsSync(skillPath(project, "code-review"))).toBe(true);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
