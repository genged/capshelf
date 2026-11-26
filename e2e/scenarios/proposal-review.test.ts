import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "proposal-review";

/**
 * A pin can resolve in the project's own clone yet in no fresh clone, which
 * only a transport clone against a real bare remote can show.
 */
test(
  "a pin no fresh clone can resolve fails the strict gate and changes nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "an unreachable source commit is reported as missing_source_commit in a fresh clone, the refusal writes nothing, and update re-pins onto merged history",
      labels: ["reproduced-user-workflow", "modeled-external-step"],
      modeledSteps: [
        "the squash merge and the proposal-branch deletion are performed with plain Git on a local bare remote",
      ],
      proofLimits: [
        "GitHub branch protection, its squash-merge implementation, and its automatic branch deletion are not exercised",
        "a real provider compatibility test owns any claim about GitHub policy",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelfRemote = await world.git.createBareRemote("shelf-remote");
      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: shelfRemote.url,
        skills: { "security-review": "base\n" },
      });
      await world.git.ok(shelf, ["push", "-q", "-u", "origin", "main"]);

      const project = await world.git.createProject("checkout");
      // capshelf refuses to record a local bare remote as upstream, so the
      // project declares itself non-portable to keep a fetchable `origin`.
      expectExit(
        await world.capshelf(project, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );
      expectExit(
        await world.capshelf(project, ["add", "skills/security-review"]),
        0,
      );

      await world.git.ok(shelf, [
        "switch",
        "-q",
        "-c",
        "propose/sqli",
        "origin/main",
      ]);
      await Bun.write(
        join(project, ".agents", "skills", "security-review", "SKILL.md"),
        "base\nSQLi checklist\n",
      );
      expectExit(
        await world.capshelf(project, [
          "promote",
          "skills/security-review",
          "-m",
          "add SQLi checklist",
        ]),
        0,
      );
      const proposed = await world.git.head(shelf);
      await world.git.ok(shelf, ["push", "-q", "-u", "origin", "propose/sqli"]);

      const duringReview = await world.git.cloneViaTransport(
        shelfRemote.url,
        "ci-during-review",
      );
      expect(await world.git.hasCommit(duringReview, proposed)).toBe(true);

      await world.git.ok(shelf, ["switch", "-q", "main"]);
      await world.git.writeAndCommit(
        shelf,
        { "skills/security-review/SKILL.md": "base\nSQLi checklist\n" },
        "squash: add SQLi checklist",
      );
      const squashed = await world.git.head(shelf);
      await world.git.ok(shelf, ["push", "-q", "origin", "main"]);
      await world.git.ok(shelf, [
        "push",
        "-q",
        "origin",
        "--delete",
        "propose/sqli",
      ]);
      await world.git.ok(shelf, ["branch", "-q", "-D", "propose/sqli"]);

      const advertised = (await world.git.advertisedRefs(shelfRemote.url)).join(
        "\n",
      );
      expect(advertised).not.toContain("propose/sqli");

      const ciClone = await world.git.cloneViaTransport(
        shelfRemote.url,
        "ci-shelf",
      );
      expect(await world.git.hasCommit(ciClone, proposed)).toBe(false);
      expect(await world.git.hasCommit(ciClone, squashed)).toBe(true);

      const beforeGate = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
        dataRepo: { path: ciClone, paths: ["skills"] },
      });
      const gate = await world.capshelf(project, [
        "--data",
        ciClone,
        "status",
        "--strict",
        "--json",
      ]);
      expectExit(gate, 4);
      expect(
        statusRow(parseStatusRows(gate.stdout), "skills", "security-review")
          .state,
      ).toBe("missing_source_commit");

      const humanGate = await world.capshelf(project, [
        "--data",
        ciClone,
        "status",
      ]);
      expectOutputContains(humanGate, "is not present in the data repo");
      expectOutputContains(humanGate, "capshelf update skills/security-review");
      expectSameState(
        beforeGate,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: ciClone, paths: ["skills"] },
        }),
        "strict gate on an unreachable pin",
      );

      // Bob's own clone still resolves the orphaned commit, so his status
      // cannot prove what CI sees.
      expect(await world.git.hasCommit(shelf, proposed)).toBe(true);

      const beforeUpdate = await captureOwnedState(world, {
        projectFiles: {
          path: project,
          include: [".agents", ".claude"],
        },
      });
      expectExit(
        await world.capshelf(project, ["update", "skills/security-review"]),
        0,
      );
      expectSameState(
        beforeUpdate,
        await captureOwnedState(world, {
          projectFiles: { path: project, include: [".agents", ".claude"] },
        }),
        "update after a squash merge",
      );

      const afterUpdate = await world.capshelf(project, [
        "--data",
        ciClone,
        "status",
        "--strict",
      ]);
      expectExit(afterUpdate, 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
