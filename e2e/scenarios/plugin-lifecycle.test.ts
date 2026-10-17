import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectBytes,
  expectExit,
  expectOutputContains,
  expectRelativeSymlink,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  parseJsonText,
} from "../support/json";
import type { JsonObject } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, type World, withWorld } from "../support/world";

const SCENARIO = "plugin-lifecycle";

const MODELED_HOST =
  "the third-party host is a local bare repository reached over file://, standing in for github.com";
const HOST_LIMIT =
  "GitHub itself, its authentication, and its rate limits stay unproved: the suite carries no credentials and every fetch is local";
const RUNTIME_LIMIT =
  "no Claude Code or Codex runs here, so whether a runtime loads the installed plugin or runs its hooks stays unproved";

const PLUGIN_JSON = '{"name":"gh-cli","version":"1.6.2"}\n';
const PLUGIN_JSON_V2 = '{"name":"gh-cli","version":"1.7.0"}\n';
const SKILL = "---\nname: gh-cli\ndescription: Use the gh CLI\n---\n\nbody\n";
const SKILL_EDITED = `${SKILL}Prefer gh api over curl.\n`;
const HOOKS_V1 = `${JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
    ],
  },
})}\n`;
const HOOKS_V2 = `${JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
    ],
    PostToolUse: [
      { hooks: [{ type: "command", command: "bash hooks/format.sh" }] },
    ],
  },
})}\n`;

const UPSTREAM_FILES = {
  "plugins/gh-cli/.claude-plugin/plugin.json": PLUGIN_JSON,
  "plugins/gh-cli/skills/gh-cli/SKILL.md": SKILL,
  "plugins/gh-cli/hooks/hooks.json": HOOKS_V1,
  "plugins/gh-cli/hooks/setup.sh": "echo setup\n",
} satisfies Readonly<Record<string, string>>;

async function readJson(path: string): Promise<JsonObject> {
  return asObject(parseJsonText(await readFile(path, "utf-8"), path), path);
}

async function remoteKeys(project: string): Promise<string[]> {
  const lock = await readJson(join(project, ".capshelf", "remotes.lock.json"));
  return Object.keys(asObject(lock.items, "remotes.lock.json items")).sort();
}

async function lockKeys(project: string, file: string): Promise<string[]> {
  const lock = await readJson(join(project, ".capshelf", file));
  expect(asNumber(lock.version, `${file} version`)).toBe(5);
  return Object.keys(asObject(lock.items, `${file} items`)).sort();
}

async function pluginState(
  world: World,
  project: string,
): Promise<{ state: string; scope: string; source: string }> {
  const status = await world.capshelf(project, ["status", "--json"]);
  expectExit(status, 0);
  const row = statusRow(parseStatusRows(status.stdout), "plugins", "gh-cli");
  return { state: row.state, scope: row.scope, source: row.source };
}

function projectState(world: World, project: string) {
  return captureOwnedState(world, {
    projectFiles: project,
    projectGit: project,
  });
}

test(
  "a plugin walks from an upstream repository onto the shelf and into a second project",
  async () => {
    await withWorld(SCENARIO, async (world) => {
      const upstream = await world.git.createBareRemote("third-party");
      const upstreamWork = await world.git.createDataRepo({
        name: "third-party-work",
        origin: upstream.url,
        files: UPSTREAM_FILES,
      });
      await world.git.ok(upstreamWork, ["push", "-q", "-u", "origin", "main"]);

      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: null,
        skills: { placeholder: "---\nname: placeholder\n---\n\nbody\n" },
      });
      const app = await world.git.createProject("app");
      expectExit(
        await world.capshelf(app, ["init", "--data", shelf, "--no-upstream"]),
        0,
      );
      const installed = join(app, ".agents", "skills", "gh-cli");

      // ---- install from upstream ------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "add <url> --path <plugin> installs the whole plugin directory into a gitignored remote row, refuses with exit 3 and writes nothing when the plugin runs a hook and --yes is absent, and a second add is a byte-stable no-op",
        labels: ["reproduced-user-workflow", "modeled-external-step"],
        modeledSteps: [MODELED_HOST],
        proofLimits: [HOST_LIMIT, RUNTIME_LIMIT],
      });
      const beforeInstall = await projectState(world, app);
      const refusedInstall = await world.capshelf(app, [
        "add",
        upstream.url,
        "--path",
        "plugins/gh-cli",
      ]);
      expectExit(refusedInstall, 3);
      expectOutputContains(refusedInstall, "without consent");
      expectOutputContains(refusedInstall, "bash hooks/setup.sh");
      expectSameState(
        beforeInstall,
        await projectState(world, app),
        "a plugin install with no consent",
      );

      expectExit(
        await world.capshelf(app, [
          "add",
          upstream.url,
          "--path",
          "plugins/gh-cli",
          "--yes",
          "--json",
        ]),
        0,
      );
      expect(await remoteKeys(app)).toEqual(["remote/plugins/gh-cli"]);
      await expectBytes(
        join(installed, ".claude-plugin", "plugin.json"),
        PLUGIN_JSON,
      );
      await expectBytes(join(installed, "hooks", "hooks.json"), HOOKS_V1);
      await expectRelativeSymlink(
        join(app, ".claude", "skills", "gh-cli"),
        "../../.agents/skills/gh-cli",
      );
      const tracked = await world.git.ok(app, [
        "ls-files",
        ".capshelf/remotes.lock.json",
      ]);
      expect(tracked.stdout.trim()).toBe("");

      const afterInstall = await projectState(world, app);
      const again = await world.capshelf(app, [
        "add",
        upstream.url,
        "--path",
        "plugins/gh-cli",
        "--yes",
        "--json",
      ]);
      expectExit(again, 0);
      expect(again.stdout).toContain('"action": "already-current"');
      expectSameState(
        afterInstall,
        await projectState(world, app),
        "a second add of the same plugin",
      );
      const status = await world.capshelf(app, ["status", "--json"]);
      expectExit(status, 0);
      const row = asArray(
        asObject(parseJsonText(status.stdout, "status --json"), "status").items,
        "items",
      )
        .map((item) => asObject(item, "status row"))
        .find((item) => item.kind === "plugins");
      expect(asObject(row?.runs ?? null, "runs")).toEqual({
        hooks: 1,
        mcpServers: 0,
        unknown: [],
      });

      // ---- check upstream -------------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "after the upstream adds a hook, a bare status still reports the plugin up to date and only status --check-upstream reports the update",
        labels: ["reproduced-user-workflow", "modeled-external-step"],
        modeledSteps: [MODELED_HOST],
        proofLimits: [HOST_LIMIT],
      });
      await world.git.writeAndCommit(
        upstreamWork,
        {
          "plugins/gh-cli/.claude-plugin/plugin.json": PLUGIN_JSON_V2,
          "plugins/gh-cli/hooks/hooks.json": HOOKS_V2,
          "plugins/gh-cli/hooks/format.sh": "echo format\n",
        },
        "gh-cli: add a hook",
      );
      await world.git.ok(upstreamWork, ["push", "-q", "origin", "main"]);
      expect((await pluginState(world, app)).state).toBe("ok");
      expectExit(
        await world.capshelf(app, ["status", "--check-upstream", "--json"]),
        0,
      );
      expect((await pluginState(world, app)).state).toBe("update_available");

      // ---- move the pin ---------------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "a named update of a remote plugin whose new tree adds a hook refuses with exit 3 and writes nothing without --yes, names the new hook, and moves the pin with --yes",
        labels: ["reproduced-user-workflow", "modeled-external-step"],
        modeledSteps: [MODELED_HOST],
        proofLimits: [HOST_LIMIT],
      });
      const beforeUpdate = await projectState(world, app);
      const refusedUpdate = await world.capshelf(app, [
        "update",
        "plugins/gh-cli",
      ]);
      expectExit(refusedUpdate, 3);
      expectOutputContains(refusedUpdate, "bash hooks/format.sh");
      expectSameState(
        beforeUpdate,
        await projectState(world, app),
        "a plugin pin move with no consent",
      );
      expectExit(
        await world.capshelf(app, ["update", "plugins/gh-cli", "--yes"]),
        0,
      );
      await expectBytes(join(installed, "hooks", "hooks.json"), HOOKS_V2);
      await expectBytes(
        join(installed, ".claude-plugin", "plugin.json"),
        PLUGIN_JSON_V2,
      );
      expect((await pluginState(world, app)).state).toBe("ok");

      // ---- keep a local fix: adopt ---------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "share plugins/<p> --adopt commits the plugin to plugins/<p> in the data repo with its provenance in .capshelf.yml, releases the remote row, and tracks the plugin in local scope behind the shelves fence",
        labels: ["reproduced-user-workflow"],
      });
      const shelfHeadBeforeAdopt = await world.git.head(shelf);
      const adopted = await world.capshelf(app, [
        "share",
        "plugins/gh-cli",
        "--adopt",
        "--json",
        "-m",
        "adopt gh-cli",
      ]);
      expectExit(adopted, 0);
      expect(adopted.stdout).toContain('"previousOwnerReleased": true');
      expect(await remoteKeys(app)).toEqual([]);
      expect(await world.git.head(shelf)).not.toBe(shelfHeadBeforeAdopt);
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      await expectBytes(
        join(shelf, "plugins", "gh-cli", "hooks", "hooks.json"),
        HOOKS_V2,
      );
      expect(
        await readFile(join(shelf, "plugins/gh-cli/.capshelf.yml"), "utf-8"),
      ).toContain("upstreamPath: plugins/gh-cli");
      await expectBytes(join(installed, ".capshelf.yml"), null);
      expect(await lockKeys(app, "local.lock.json")).toContain(
        "data/plugins/gh-cli",
      );
      const localConfig = await readJson(join(app, ".capshelf", "local.json"));
      expect(asArray(localConfig.plugins, "local plugins")).toEqual(["gh-cli"]);
      expect(asString(localConfig.shelves, "local shelves")).toStartWith(
        "plugin items:",
      );
      expect(await pluginState(world, app)).toEqual({
        state: "ok",
        scope: "local",
        source: "data",
      });

      // ---- give to the team -----------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "move plugins/<p> --to project refuses with exit 3 and writes nothing for a plugin that runs a hook unless --yes is given, and with --yes it moves the plugin and the shelves fence into the committed manifest and lock",
        labels: ["reproduced-user-workflow"],
      });
      const beforeMove = await projectState(world, app);
      const refusedMove = await world.capshelf(app, [
        "move",
        "plugins/gh-cli",
        "--to",
        "project",
      ]);
      expectExit(refusedMove, 3);
      expectOutputContains(refusedMove, "every teammate's");
      expectSameState(
        beforeMove,
        await projectState(world, app),
        "a move to project scope with no consent",
      );
      expectExit(
        await world.capshelf(app, [
          "move",
          "plugins/gh-cli",
          "--to",
          "project",
          "--yes",
        ]),
        0,
      );
      const manifest = await readJson(join(app, ".capshelf", "capshelf.json"));
      expect(asArray(manifest.plugins, "plugins")).toEqual(["gh-cli"]);
      expect(asString(manifest.shelves, "shelves")).toStartWith(
        "plugin items:",
      );
      expect(
        (await readJson(join(app, ".capshelf", "local.json"))).shelves,
      ).toBeUndefined();
      expect(await lockKeys(app, "capshelf.lock.json")).toContain(
        "data/plugins/gh-cli",
      );
      expect(await lockKeys(app, "local.lock.json")).not.toContain(
        "data/plugins/gh-cli",
      );
      expectExit(await world.capshelf(app, ["status", "--strict"]), 0);

      // ---- another project ------------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "a second project adds the shelf plugin in project scope with --yes and receives the same bytes, without the .capshelf.yml sidecar",
        labels: ["reproduced-user-workflow"],
      });
      const billing = await world.git.createProject("billing");
      expectExit(
        await world.capshelf(billing, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );
      expectExit(
        await world.capshelf(billing, ["add", "plugins/gh-cli", "--yes"]),
        0,
      );
      const billingInstalled = join(billing, ".agents", "skills", "gh-cli");
      await expectBytes(
        join(billingInstalled, "hooks", "hooks.json"),
        HOOKS_V2,
      );
      await expectBytes(
        join(billingInstalled, "skills", "gh-cli", "SKILL.md"),
        SKILL,
      );
      await expectBytes(join(billingInstalled, ".capshelf.yml"), null);
      expect(await pluginState(world, billing)).toEqual({
        state: "ok",
        scope: "project",
        source: "data",
      });

      // ---- change it ------------------------------------------------------
      declareEvidence({
        scenario: SCENARIO,
        property:
          "an edit to the installed plugin promotes to the data repo, a second promote is a no-op, and the other project only reports update_available and keeps its bytes until it runs update",
        labels: ["reproduced-user-workflow"],
      });
      await writeFile(
        join(installed, "skills", "gh-cli", "SKILL.md"),
        SKILL_EDITED,
      );
      expect((await pluginState(world, app)).state).toBe("drifted_local");
      const shelfHeadBeforePromote = await world.git.head(shelf);
      const promoted = await world.capshelf(app, [
        "promote",
        "plugins/gh-cli",
        "-m",
        "gh-cli: prefer gh api",
        "--json",
      ]);
      expectExit(promoted, 0);
      expect(promoted.stdout).toContain('"action": "promoted"');
      expect(await world.git.head(shelf)).not.toBe(shelfHeadBeforePromote);
      await expectBytes(
        join(shelf, "plugins", "gh-cli", "skills", "gh-cli", "SKILL.md"),
        SKILL_EDITED,
      );
      expect((await pluginState(world, app)).state).toBe("ok");

      const afterPromote = await captureOwnedState(world, {
        projectFiles: app,
        dataRepo: { path: shelf, paths: ["plugins"] },
      });
      const promotedAgain = await world.capshelf(app, [
        "promote",
        "plugins/gh-cli",
        "-m",
        "again",
        "--json",
      ]);
      expectExit(promotedAgain, 0);
      expect(promotedAgain.stdout).toContain('"action": "already-current"');
      expectSameState(
        afterPromote,
        await captureOwnedState(world, {
          projectFiles: app,
          dataRepo: { path: shelf, paths: ["plugins"] },
        }),
        "a second promote of an unchanged plugin",
      );

      expect((await pluginState(world, billing)).state).toBe(
        "update_available",
      );
      await expectBytes(
        join(billingInstalled, "skills", "gh-cli", "SKILL.md"),
        SKILL,
      );
      expectExit(
        await world.capshelf(billing, ["update", "plugins/gh-cli"]),
        0,
      );
      await expectBytes(
        join(billingInstalled, "skills", "gh-cli", "SKILL.md"),
        SKILL_EDITED,
      );
      expectExit(await world.capshelf(billing, ["status", "--strict"]), 0);
      expectExit(await world.capshelf(app, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
