import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectSameState,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { asArray, asObject, asString, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "remote-plugin-skill";

const PLAIN_SKILL = "---\nname: plain\ndescription: Plain skill\n---\n\nbody\n";
const WORKER_SKILL = `---\nname: worker\ndescription: Heavy skill\n---\n\nReads \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh and dispatches \`assistant\`.\n`;
const ASSISTANT_AGENT = "agent\n";
const MARKETPLACE = JSON.stringify({
  name: "fixture",
  owner: { name: "fixture" },
  plugins: [
    { name: "plain", source: "./plugins/plain" },
    { name: "heavy", source: "./plugins/heavy" },
  ],
});

test(
  "a plugin repository lists its plugins, refuses a plugin root at --path, and installs one plugin skill with its facts",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "add <url> --list --json reports the plugins array for a repository published through a Claude plugin catalog, add <url> --path <plugin root> refuses with exit 3 and leaves the project byte-identical, and add <url> --path <skill> --yes installs the skill directory only and carries usesPluginParts in its JSON result",
      labels: ["reproduced-user-workflow", "modeled-external-step"],
      modeledSteps: [
        "the third-party host is a local bare repository reached over file://, standing in for github.com",
      ],
      proofLimits: [
        "GitHub itself, its authentication, and its rate limits stay unproved: the suite carries no credentials and every fetch is local",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      // The third-party plugin repository: two plugins under one Claude
      // catalog, one of them (heavy) holding a skill that reaches outside its
      // own directory through the plugin-root variable and a namespaced
      // agent reference.
      const upstream = await world.git.createBareRemote("plugin-host");
      const upstreamWork = await world.git.createDataRepo({
        name: "plugin-host-work",
        origin: upstream.url,
        files: {
          ".claude-plugin/marketplace.json": MARKETPLACE,
          "plugins/plain/skills/plain/SKILL.md": PLAIN_SKILL,
          "plugins/heavy/skills/worker/SKILL.md": WORKER_SKILL,
          "plugins/heavy/agents/assistant.md": ASSISTANT_AGENT,
        },
      });
      await world.git.ok(upstreamWork, ["push", "-q", "-u", "origin", "main"]);

      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: null,
        skills: { placeholder: "---\nname: placeholder\n---\n\nbody\n" },
      });
      const project = await world.git.createProject("app");
      expectExit(
        await world.capshelf(project, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );

      // List: both plugins, and the worker skill's facts.
      const listed = await world.capshelf(project, [
        "add",
        upstream.url,
        "--list",
        "--json",
      ]);
      expectExit(listed, 0);
      const listPayload = asObject(
        parseJsonText(listed.stdout, "add --list --json"),
        "add --list --json",
      );
      expect(asArray(listPayload.plugins, "plugins")).toHaveLength(2);
      const listedSkills = asArray(listPayload.skills, "skills").map((skill) =>
        asObject(skill, "skill row"),
      );
      expect(listedSkills).toHaveLength(2);
      const workerRow = listedSkills.find(
        (skill) => asString(skill.name, "skill name") === "worker",
      )!;
      expect(
        asArray(workerRow.usesPluginParts, "usesPluginParts"),
      ).not.toHaveLength(0);

      // Refuse a plugin root at --path. Safe failure: the project, Git
      // included, does not change.
      const beforeRefusal = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const refused = await world.capshelf(project, [
        "add",
        upstream.url,
        "--path",
        "plugins/heavy",
      ]);
      expectExit(refused, 3);
      expect(refused.stderr).toContain("is a plugin, not a skill");
      expect(refused.stderr).toContain("install the skill: capshelf add");
      expect(refused.stderr).toContain("plugins/heavy/skills/worker");
      expectSameState(
        beforeRefusal,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "a plugin-root refusal at --path",
      );

      // Install the one plugin skill. `--yes` authorizes the facts warning,
      // which prints to stderr, never stdout, so `--json` still parses.
      const installed = await world.capshelf(project, [
        "add",
        upstream.url,
        "--path",
        "plugins/heavy/skills/worker",
        "--yes",
        "--json",
      ]);
      expectExit(installed, 0);
      const installPayload = asObject(
        parseJsonText(installed.stdout, "add --path --yes --json"),
        "add --path --yes --json",
      );
      const usesPluginParts = asArray(
        installPayload.usesPluginParts,
        "usesPluginParts",
      );
      expect(usesPluginParts.length).toBeGreaterThan(0);
      expect(
        asString(asObject(installPayload.plugin, "plugin").name, "plugin.name"),
      ).toBe("heavy");

      // Independent observation: the skill directory installed, and the
      // plugin's agent file did not come with it — "the skill directory
      // only" (docs/cli.md, Remote skills).
      const installDir = join(project, ".agents", "skills", "worker");
      expect(await readFile(join(installDir, "SKILL.md"), "utf-8")).toBe(
        WORKER_SKILL,
      );
      expect(await readdir(installDir)).toEqual(["SKILL.md"]);

      expectExit(
        await world.capshelf(project, ["status", "--strict", "--json"]),
        0,
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
