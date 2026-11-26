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
 * Tracked separately from the restored value because `setPickContext` returns
 * null on first install, which is ambiguous with nothing to undo.
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
  // Claude-only so coverage reporting says something a user can't infer.
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
      // The picker runs after `local.json` is written so cancelling leaves a
      // working project, not a half-built one that `init` would refuse as
      // already initialized.
      const project = await tempRepo("capshelf-pick-project-");
      const dataRepo = await shelf();
      answerCancel();

      const result = await runInProcess(project)(["init", "--data", dataRepo]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(project, ".capshelf", "local.json"))).toBe(true);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
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
      const parsed = JSON.parse(result.stdout.toString());
      expect(parsed.project).toBe(project);
      expect(existsSync(skillPath(project, "security-review"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a remote --data URL reaches the picker as the local clone it created",
    async () => {
      // `--data` before the subcommand binds to the root command, so the picker
      // would re-resolve the raw URL as a path and fail a successful init.
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
      // `addBundle` loads and saves its own context; reusing a pre-bundle
      // snapshot would save a lock that drops the bundle's members.
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
      // Picker installs are best effort, unlike `add bundles/<name>`:
      // selections are independent, so an unresolvable ref must not discard the
      // others.
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
      // The picker must refuse a data-repo item named like a system item,
      // because installed detection misses it (system copies lock under
      // `system/`) and two lock entries would own one destination.
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
      // installDataItem updates manifest and lock before materializing; a
      // read-only skills root forces a failure there while the mcp item still
      // succeeds.
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
      // Warnings quote data-repo text verbatim, so a shelf could inject
      // terminal escape sequences into the picker frame.
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
      // The no-argument branch must refuse `--target` too; otherwise it returns
      // before the named-path check and silently writes every runtime target.
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
      // The picker can block indefinitely, so the prompt installs a second item
      // mid-prompt to simulate a concurrent run that a stale snapshot would
      // drop.
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
