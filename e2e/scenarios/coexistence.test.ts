import { expect, test } from "bun:test";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseApplyRows,
  parseStatusRows,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, type World, withWorld } from "../support/world";

const SCENARIO = "coexistence";

const SKILLS_SH_LOCK = `${JSON.stringify(
  {
    version: 1,
    skills: {
      "legacy-helper": {
        source: "acme/agent-skills",
        sourceType: "github",
        skillPath: "skills/legacy-helper/SKILL.md",
      },
    },
  },
  null,
  2,
)}\n`;

interface ExternalPayload {
  external: { name: string; source: string }[];
  externalUserSkills: {
    name: string;
    surface: string;
    shadows: { scope: string; source: string }[];
  }[];
}

function externalOf(stdout: string): ExternalPayload {
  const parsed = JSON.parse(stdout) as Partial<ExternalPayload>;
  return {
    external: parsed.external ?? [],
    externalUserSkills: parsed.externalUserSkills ?? [],
  };
}

async function writePersonalSkill(world: World, name: string): Promise<string> {
  const root = join(world.home, ".claude", "skills", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `personal ${name}\n`);
  return root;
}

test(
  "a skills.sh-owned name is reported and never adopted",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "capshelf refuses to co-manage a skills.sh-owned skill, reports it as external, and never writes its paths; external entries do not move the strict exit code",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "skills.sh itself is not installed or run: the lockfile and its on-disk layout are fixture state",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: {
          "legacy-helper": "shared helper\n",
          "release-notes": "notes\n",
        },
      });
      const project = await world.git.createProject("console");

      // The project predates capshelf: skills.sh owns one name, in the Codex
      // layout it writes (a real directory plus a compatibility symlink).
      await writeFile(join(project, "skills-lock.json"), SKILLS_SH_LOCK);
      const owned = join(project, ".agents", "skills", "legacy-helper");
      await mkdir(owned, { recursive: true });
      await writeFile(join(owned, "SKILL.md"), "skills.sh helper\n");
      await mkdir(join(project, ".claude", "skills"), { recursive: true });
      await symlink(
        "../../.agents/skills/legacy-helper",
        join(project, ".claude", "skills", "legacy-helper"),
      );

      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      const externalPaths = {
        path: project,
        include: [
          "skills-lock.json",
          ".agents/skills/legacy-helper",
          ".claude/skills/legacy-helper",
        ],
      };
      const before = await captureOwnedState(world, {
        projectFiles: externalPaths,
      });

      const refused = await world.capshelf(project, [
        "add",
        "skills/legacy-helper",
      ]);
      // "a system or externally managed item was selected" is exit 3
      // (docs/cli.md:1250-1261).
      expectExit(refused, 3);
      expectOutputContains(refused, "skills.sh");
      expectOutputContains(refused, "skills.sh remove legacy-helper");

      // A whole command sweep must not write a skills.sh-owned path.
      expectExit(
        await world.capshelf(project, ["add", "skills/release-notes"]),
        0,
      );
      expectExit(await world.capshelf(project, ["apply"]), 0);
      expectExit(await world.capshelf(project, ["update"]), 0);
      expectSameState(
        before,
        await captureOwnedState(world, { projectFiles: externalPaths }),
        "command sweep over a skills.sh-owned name",
      );

      // Null second run: the sweep above already converged, so the same
      // reconcile must report no work and write nothing.
      const converged = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const second = await world.capshelf(project, ["apply", "--json"]);
      expectExit(second, 0);
      for (const row of parseApplyRows(second.stdout)) {
        expect(row.action).toBe("already-current");
      }
      expectSameState(
        converged,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "second apply",
      );

      const status = await world.capshelf(project, ["status", "--json"]);
      expectExit(status, 0);
      expect(
        externalOf(status.stdout).external.map((entry) => entry.name),
      ).toContain("legacy-helper");
      // External state never moves the strict exit code.
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a personal skill that shadows a managed one fails strict, and the same real path does not",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "a user-level Claude skill with the same name as a managed project skill is reported as a shadow and fails --strict, while a symlink to the project skill is not a shadow",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "Claude Code is not started, so the precedence this warning describes is not observed, only reported",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { "personal-shadow-demo": "shared version\n" },
      });
      const project = await world.git.createProject("console");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      // Nothing is shadowed yet, so personal inventory alone is not a fault.
      const personal = await writePersonalSkill(world, "personal-shadow-demo");
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      const added = await world.capshelf(project, [
        "add",
        "skills/personal-shadow-demo",
      ]);
      expectExit(added, 0);
      // The message names the personal path and states the precedence.
      expectOutputContains(added, "~/.claude/skills/personal-shadow-demo");
      expectOutputContains(added, "before this project skill");

      const strict = await world.capshelf(project, ["status", "--strict"]);
      expectExit(strict, 4);

      const json = await world.capshelf(project, ["status", "--json"]);
      const shadowRow = externalOf(json.stdout).externalUserSkills.find(
        (skill) => skill.name === "personal-shadow-demo",
      );
      expect(shadowRow?.surface).toBe("claude");
      expect(shadowRow?.shadows).toEqual([
        { scope: "project", source: "data" },
      ]);
      const row = parseStatusRows(json.stdout).find(
        (item) => item.name === "personal-shadow-demo",
      );
      expect(JSON.stringify(row?.runtimeWarnings ?? [])).toContain(
        "shadowed_by_personal_claude_skill",
      );

      // Renaming the personal skill clears it.
      await rename(personal, join(world.home, ".claude", "skills", "renamed"));
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      // A symlink to the project skill resolves to the same real path, so it
      // is not a shadow. This is the false-positive guard.
      await symlink(
        join(project, ".agents", "skills", "personal-shadow-demo"),
        join(world.home, ".claude", "skills", "personal-shadow-demo"),
      );
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
