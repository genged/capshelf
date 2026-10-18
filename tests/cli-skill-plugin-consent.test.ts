/**
 * A `skills` item whose tree holds `.claude-plugin/plugin.json` loads in
 * Claude Code as `<name>@skills-dir` and runs its hooks (spec R1). It gets
 * the same consent points as a plugin: shelf `add` (points 1 and 3), bundle
 * members, `move --to project` and `share --to project` (point 3), shelf
 * `update` (point 2), and the remote `add <url>` and `update` prompts.
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateOneTarget } from "../src/commands/update";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { GitReadMemo } from "../src/git-read-memo";
import { assertWritableLock, loadLocalLock, loadLock } from "../src/lock";
import { loadManifest } from "../src/manifest";
import { pinCurrentSource } from "../src/pin";
import { emptyRemotesLock } from "../src/remotes-lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  objectField,
  readJsonObject,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import type { CliResult } from "./cli-fixtures";
import {
  initRemoteProject,
  pushPluginChange,
  skillText,
} from "./remote-fixtures";

function hooksJson(command: string): string {
  return JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
  });
}

async function writeUnder(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const target = join(root, ...relPath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

/** A skill folder with SKILL.md, a plugin manifest, and the extra files. */
async function writeManifestSkill(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeUnder(root, "SKILL.md", skillText(name, "d"));
  await writeUnder(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name, version: "1.0.0" }),
  );
  for (const [relPath, content] of Object.entries(files)) {
    await writeUnder(root, relPath, content);
  }
}

interface World {
  project: string;
  dataRepo: string;
  run: (args: string[]) => Promise<CliResult>;
}

/**
 * A data repo with `skills/hooked` (a manifest and a SessionStart hook) and
 * `skills/inert` (a manifest that runs nothing), and a project bound to it.
 */
async function world(): Promise<World> {
  const project = await tempRepo("capshelf-skill-plugin-project-");
  const dataRepo = await tempRepo("capshelf-skill-plugin-data-");
  await writeManifestSkill(join(dataRepo, "skills", "hooked"), "hooked", {
    "hooks/hooks.json": hooksJson("bash hooks/setup.sh"),
  });
  await writeManifestSkill(join(dataRepo, "skills", "inert"), "inert", {});
  await commitAll(dataRepo, "baseline");
  const run = runInProcess(project);
  expect(
    (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
  ).toBe(0);
  return { project, dataRepo, run };
}

async function lockKeys(project: string): Promise<string[]> {
  const lock = await readJsonObject(
    join(project, ".capshelf", "capshelf.lock.json"),
  );
  return Object.keys(objectField(lock, "items")).sort();
}

describe("a shelf skill that holds a plugin manifest", () => {
  test(
    "add with a hook and no terminal refuses with exit 3 and names the hook",
    async () => {
      const w = await world();
      const r = await w.run(["add", "skills/hooked"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain(
        "not installing skills/hooked without consent — it runs 1 hook in every Claude Code session in this project",
      );
      expect(err).toContain("bash hooks/setup.sh");
      expect(err).toContain("every teammate's");
      expect(existsSync(join(w.project, ".agents", "skills", "hooked"))).toBe(
        false,
      );
      expect(await lockKeys(w.project)).not.toContain("data/skills/hooked");

      const yes = await w.run(["add", "skills/hooked", "--yes"]);
      expect(yes.exitCode).toBe(0);
      expect(await lockKeys(w.project)).toContain("data/skills/hooked");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "add with no hook and no unknown entry asks nothing",
    async () => {
      const w = await world();
      const r = await w.run(["add", "skills/inert"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).not.toContain("consent");
      expect(await lockKeys(w.project)).toContain("data/skills/inert");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a bundle that holds it asks",
    async () => {
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "bundles/team.yml",
        "includes:\n  skills: [hooked, inert]\n",
      );
      await commitAll(w.dataRepo, "bundle");
      const r = await w.run(["add", "bundles/team"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        "not installing skills/hooked without consent",
      );
      expect(await lockKeys(w.project)).not.toContain("data/skills/inert");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "move --to project asks (point 3)",
    async () => {
      const w = await world();
      expect(
        (await w.run(["add", "skills/hooked", "--local", "--yes"])).exitCode,
      ).toBe(0);
      const r = await w.run(["move", "skills/hooked", "--to", "project"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        "not moving skills/hooked to project scope without consent",
      );
      expect(await lockKeys(w.project)).not.toContain("data/skills/hooked");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update asks when the new tree adds a hook (point 2)",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/inert"])).exitCode).toBe(0);
      await writeUnder(
        w.dataRepo,
        "skills/inert/hooks/hooks.json",
        hooksJson("bash hooks/new.sh"),
      );
      await commitAll(w.dataRepo, "add a hook");
      const r = await w.run(["update", "skills/inert"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not updating skills/inert without consent");
      expect(err).toContain("bash hooks/new.sh");
      expect(
        existsSync(
          join(w.project, ".agents", "skills", "inert", "hooks", "hooks.json"),
        ),
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a recovery add asks for the ignored manifest and hook it keeps",
    async () => {
      // The unmanaged folder matches the pin on the pinned paths, so add
      // adopts it and keeps its ignored files. They make it a plugin.
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "skills/foo/SKILL.md",
        skillText("foo", "d"),
      );
      await commitAll(w.dataRepo, "foo skill");
      const folder = join(w.project, ".agents", "skills", "foo");
      await writeUnder(folder, "SKILL.md", skillText("foo", "d"));
      await writeUnder(
        w.project,
        ".gitignore",
        ".agents/skills/foo/.claude-plugin/\n.agents/skills/foo/hooks/\n",
      );
      await writeUnder(
        folder,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "foo" }),
      );
      await writeUnder(
        folder,
        "hooks/hooks.json",
        hooksJson("bash hooks/rec.sh"),
      );

      const r = await w.run(["add", "skills/foo"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not installing skills/foo without consent");
      expect(err).toContain("bash hooks/rec.sh");
      expect(await lockKeys(w.project)).not.toContain("data/skills/foo");
      expect(existsSync(join(w.project, ".claude", "skills", "foo"))).toBe(
        false,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update asks when a kept ignored local manifest arms a new upstream hook",
    async () => {
      // The update keeps the ignored local manifest beside the new pinned
      // files, so the folder becomes a plugin that runs the new hook.
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "skills/plain/SKILL.md",
        skillText("plain", "d"),
      );
      await commitAll(w.dataRepo, "plain skill");
      expect((await w.run(["add", "skills/plain"])).exitCode).toBe(0);
      await writeUnder(
        w.project,
        ".gitignore",
        ".agents/skills/plain/.claude-plugin/\n",
      );
      const installed = join(w.project, ".agents", "skills", "plain");
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "plain" }),
      );
      await writeUnder(
        w.dataRepo,
        "skills/plain/hooks/hooks.json",
        hooksJson("bash hooks/kept.sh"),
      );
      await commitAll(w.dataRepo, "add a hook");

      const r = await w.run(["update", "skills/plain"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not updating skills/plain without consent");
      expect(err).toContain("bash hooks/kept.sh");
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --merge asks when a kept ignored local manifest arms a new upstream hook",
    async () => {
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "skills/plain/SKILL.md",
        skillText("plain", "d"),
      );
      await commitAll(w.dataRepo, "plain skill");
      expect((await w.run(["add", "skills/plain"])).exitCode).toBe(0);
      await writeUnder(
        w.project,
        ".gitignore",
        ".agents/skills/plain/.claude-plugin/\n",
      );
      const installed = join(w.project, ".agents", "skills", "plain");
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "plain" }),
      );
      // A visible local edit, so the merge has a local side.
      await writeUnder(installed, "local.md", "mine\n");
      await writeUnder(
        w.dataRepo,
        "skills/plain/hooks/hooks.json",
        hooksJson("bash hooks/kept.sh"),
      );
      await commitAll(w.dataRepo, "add a hook");

      const r = await w.run(["update", "skills/plain", "--merge"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("bash hooks/kept.sh");
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --merge asks when the writer keeps a pinned manifest that Git ignores",
    async () => {
      // The pinned manifest is ignored in the project, so the merge reads it
      // as a local deletion. The merge writer replaces only the files it
      // read, so the manifest stays beside the new hook.
      const w = await world();
      expect((await w.run(["add", "skills/inert"])).exitCode).toBe(0);
      await writeUnder(
        w.project,
        ".gitignore",
        ".agents/skills/inert/.claude-plugin/\n",
      );
      const installed = join(w.project, ".agents", "skills", "inert");
      await writeUnder(installed, "local.md", "mine\n");
      await writeUnder(
        w.dataRepo,
        "skills/inert/hooks/hooks.json",
        hooksJson("bash hooks/writer.sh"),
      );
      await commitAll(w.dataRepo, "add a hook");

      const r = await w.run(["update", "skills/inert", "--merge"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("bash hooks/writer.sh");
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update asks nothing for an unchanged kept local manifest",
    async () => {
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "skills/plain/SKILL.md",
        skillText("plain", "d"),
      );
      await commitAll(w.dataRepo, "plain skill");
      expect((await w.run(["add", "skills/plain"])).exitCode).toBe(0);
      await writeUnder(
        w.project,
        ".gitignore",
        ".agents/skills/plain/.claude-plugin/\n",
      );
      const installed = join(w.project, ".agents", "skills", "plain");
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "plain" }),
      );
      await writeUnder(w.dataRepo, "skills/plain/notes.md", "notes\n");
      await commitAll(w.dataRepo, "add notes");

      const r = await w.run(["update", "skills/plain"]);
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(installed, "notes.md"))).toBe(true);
      expect(existsSync(join(installed, ".claude-plugin", "plugin.json"))).toBe(
        true,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --merge asks for what the merged tree runs",
    async () => {
      // Neither side is a plugin with hooks alone: the local copy gains an
      // inert manifest and the upstream gains a hook with no manifest. The
      // merge result holds both, so it runs the hook.
      const w = await world();
      await writeUnder(
        w.dataRepo,
        "skills/plain/SKILL.md",
        skillText("plain", "d"),
      );
      await commitAll(w.dataRepo, "plain skill");
      expect((await w.run(["add", "skills/plain"])).exitCode).toBe(0);
      const installed = join(w.project, ".agents", "skills", "plain");
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "plain" }),
      );
      await writeUnder(
        w.dataRepo,
        "skills/plain/hooks/hooks.json",
        hooksJson("bash hooks/merged.sh"),
      );
      await commitAll(w.dataRepo, "add a hook");

      const dry = await w.run([
        "update",
        "skills/plain",
        "--merge",
        "--dry-run",
        "--json",
      ]);
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout.toString()).toContain("bash hooks/merged.sh");

      const r = await w.run(["update", "skills/plain", "--merge"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not updating skills/plain without consent");
      expect(err).toContain("bash hooks/merged.sh");
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "share --to project of a local copy asks (point 3)",
    async () => {
      const w = await world();
      await writeManifestSkill(
        join(w.project, ".agents", "skills", "mine"),
        "mine",
        { "hooks/hooks.json": hooksJson("bash hooks/mine.sh") },
      );
      const before = (
        await $`git -C ${w.dataRepo} rev-parse HEAD`.quiet().text()
      ).trim();
      const r = await w.run(["share", "skills/mine", "--to", "project"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain(
        "not moving skills/mine to project scope without consent",
      );
      expect(err).toContain("1 hook");
      expect(
        (await $`git -C ${w.dataRepo} rev-parse HEAD`.quiet().text()).trim(),
      ).toBe(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

/** A bare upstream whose root is a skill that also holds a plugin manifest. */
async function rootSkillUpstream(): Promise<{ url: string; work: string }> {
  const work = await tempRepo("capshelf-skill-plugin-upstream-", {
    origin: null,
  });
  await writeManifestSkill(work, "rooted", {
    "hooks/hooks.json": hooksJson("bash hooks/root.sh"),
  });
  await commitAll(work, "skill");
  await $`git -C ${work} branch -M main`.quiet();
  const bare = join(await tempDir("capshelf-skill-plugin-bare-"), "repo.git");
  await $`git clone -q --bare ${work} ${bare}`.quiet();
  await $`git -C ${work} remote add origin ${bare}`.quiet();
  return { url: `file://${bare}`, work };
}

describe("a remote skill that holds a plugin manifest", () => {
  test(
    "add <url> with no terminal names the hook in the refusal",
    async () => {
      const remote = await initRemoteProject();
      const up = await rootSkillUpstream();
      const run = runInProcess(remote.project);
      const r = await run(["add", up.url, "--as", "rooted"], remote.env);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain(
        "not installing skills/rooted without consent — it runs 1 hook in every Claude Code session in this project",
      );
      expect(err).toContain("bash hooks/root.sh");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update names the hook the new tree adds",
    async () => {
      const remote = await initRemoteProject();
      const up = await rootSkillUpstream();
      const run = runInProcess(remote.project);
      expect(
        (await run(["add", up.url, "--as", "rooted", "--yes"], remote.env))
          .exitCode,
      ).toBe(0);
      await pushPluginChange(
        up,
        "hooks/hooks.json",
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: "bash hooks/root.sh" },
                  { type: "command", command: "bash hooks/later.sh" },
                ],
              },
            ],
          },
        }),
      );
      expect(
        (await run(["status", "--check-upstream"], remote.env)).exitCode,
      ).toBe(0);
      const r = await run(["update", "skills/rooted"], remote.env);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("+ 1 hook");
      expect(err).toContain("bash hooks/later.sh");
      expect(err).not.toContain("bash hooks/root.sh");
      const installed = await readFile(
        join(
          remote.project,
          ".agents",
          "skills",
          "rooted",
          "hooks",
          "hooks.json",
        ),
        "utf-8",
      );
      expect(installed).not.toContain("later.sh");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --merge names a hook that only the merged files run",
    async () => {
      const remote = await initRemoteProject();
      const work = await tempRepo("capshelf-skill-plugin-plain-upstream-", {
        origin: null,
      });
      await writeUnder(work, "SKILL.md", skillText("plainr", "d"));
      await commitAll(work, "skill");
      await $`git -C ${work} branch -M main`.quiet();
      const bare = join(
        await tempDir("capshelf-skill-plugin-plain-bare-"),
        "repo.git",
      );
      await $`git clone -q --bare ${work} ${bare}`.quiet();
      await $`git -C ${work} remote add origin ${bare}`.quiet();
      const run = runInProcess(remote.project);
      expect(
        (
          await run(
            ["add", `file://${bare}`, "--as", "plainr", "--yes"],
            remote.env,
          )
        ).exitCode,
      ).toBe(0);
      const installed = join(remote.project, ".agents", "skills", "plainr");
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "plainr" }),
      );
      await pushPluginChange(
        { url: `file://${bare}`, work },
        "hooks/hooks.json",
        hooksJson("bash hooks/merged.sh"),
      );
      expect(
        (await run(["status", "--check-upstream"], remote.env)).exitCode,
      ).toBe(0);

      const r = await run(["update", "skills/plainr", "--merge"], remote.env);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("bash hooks/merged.sh");
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update names a hook that a kept ignored local manifest arms",
    async () => {
      const remote = await initRemoteProject();
      const work = await tempRepo("capshelf-skill-plugin-kept-upstream-", {
        origin: null,
      });
      await writeUnder(work, "SKILL.md", skillText("keptr", "d"));
      await commitAll(work, "skill");
      await $`git -C ${work} branch -M main`.quiet();
      const bare = join(
        await tempDir("capshelf-skill-plugin-kept-bare-"),
        "repo.git",
      );
      await $`git clone -q --bare ${work} ${bare}`.quiet();
      await $`git -C ${work} remote add origin ${bare}`.quiet();
      const run = runInProcess(remote.project);
      expect(
        (
          await run(
            ["add", `file://${bare}`, "--as", "keptr", "--yes"],
            remote.env,
          )
        ).exitCode,
      ).toBe(0);
      const installed = join(remote.project, ".agents", "skills", "keptr");
      // Ignored inside the item, so the move keeps it (row 4).
      await writeUnder(
        installed,
        ".gitignore",
        ".claude-plugin/\n.gitignore\n",
      );
      await writeUnder(
        installed,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "keptr" }),
      );
      await pushPluginChange(
        { url: `file://${bare}`, work },
        "hooks/hooks.json",
        hooksJson("bash hooks/kept.sh"),
      );
      expect(
        (await run(["status", "--check-upstream"], remote.env)).exitCode,
      ).toBe(0);

      const r = await run(["update", "skills/keptr", "--yes"], remote.env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toContain("bash hooks/kept.sh");
      expect(existsSync(join(installed, ".claude-plugin", "plugin.json"))).toBe(
        true,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("shelf update installs the pin the user approved", () => {
  test(
    "a commit during the consent prompt does not install unasked",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/inert"])).exitCode).toBe(0);
      await writeUnder(
        w.dataRepo,
        "skills/inert/hooks/hooks.json",
        hooksJson("bash hooks/asked.sh"),
      );
      await commitAll(w.dataRepo, "add an asked hook");

      const prompts: string[] = [];
      const outer = setDestructiveConfirmationContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (message) => {
          prompts.push(message);
          if (prompts.length === 1) {
            await writeUnder(
              w.dataRepo,
              "skills/inert/hooks/hooks.json",
              hooksJson("bash hooks/unasked.sh"),
            );
            await commitAll(
              w.dataRepo,
              "swap the hook while the prompt is open",
            );
          }
          return "y";
        },
        stderr: { write: () => {} },
      });
      try {
        await w.run(["update", "skills/inert"]);
      } finally {
        setDestructiveConfirmationContext(outer);
      }
      expect(prompts[0]).toContain("bash hooks/asked.sh");
      const hooksPath = join(
        w.project,
        ".agents",
        "skills",
        "inert",
        "hooks",
        "hooks.json",
      );
      if (existsSync(hooksPath)) {
        expect(await readFile(hooksPath, "utf-8")).not.toContain("unasked.sh");
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the write pass installs the approved pin, not a later commit",
    async () => {
      const w = await world();
      expect((await w.run(["add", "skills/inert"])).exitCode).toBe(0);
      await writeUnder(w.dataRepo, "skills/inert/notes.md", "notes\n");
      await commitAll(w.dataRepo, "notes");
      const approved = await pinCurrentSource(w.dataRepo, "skills", "inert");
      // A commit after the re-plan check: the write pass must not read it.
      await writeUnder(
        w.dataRepo,
        "skills/inert/hooks/hooks.json",
        hooksJson("bash hooks/late.sh"),
      );
      await commitAll(w.dataRepo, "a late hook");

      const projectLock = assertWritableLock(await loadLock(w.project), "test");
      const key = "data/skills/inert";
      const outcome = await updateOneTarget(
        {
          memo: new GitReadMemo(),
          project: w.project,
          manifest: await loadManifest(w.project),
          dataRepo: w.dataRepo,
          dryRun: false,
          explicit: true,
          externalSkillByName: new Map(),
          projectLock,
          localLock: await loadLocalLock(w.project),
          remotes: emptyRemotesLock(),
          approvedPins: new Map([[`project:${key}`, approved]]),
        },
        { scope: "project", key },
        projectLock.items[key]!,
      );
      expect(outcome.pin?.sourceCommit).toBe(approved.sourceCommit);
      const installed = join(w.project, ".agents", "skills", "inert");
      expect(existsSync(join(installed, "notes.md"))).toBe(true);
      expect(existsSync(join(installed, "hooks", "hooks.json"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
