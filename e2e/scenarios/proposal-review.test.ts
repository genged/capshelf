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
 * The gate this scenario exists for: a project can pin a commit that its own
 * clone resolves and no fresh clone can. Only a transport clone can show that,
 * which is why the fixture pushes a proposal branch to a real bare remote and
 * then models the squash merge on that remote.
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
      // A local bare remote is not a portable upstream, and capshelf refuses
      // to record one. The project declares itself non-portable so the shelf
      // can keep a fetchable `origin`; this scenario is about pin
      // reachability, not about publishing the project.
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

      // Bob proposes on a branch, exactly as the shelf's protected main
      // requires. capshelf commits; the human pushes.
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

      // While the proposal branch lives, a fresh clone can resolve the pin.
      const duringReview = await world.git.cloneViaTransport(
        shelfRemote.url,
        "ci-during-review",
      );
      expect(await world.git.hasCommit(duringReview, proposed)).toBe(true);

      // The squash merge: main gains the same content under a new commit, and
      // the proposal branch is deleted.
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

      // CI clones the shelf fresh. The pinned commit is gone from every
      // advertised ref, so the gate must fail rather than compare content.
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

      // The human form names the failure and the repair, not only the state.
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

      // Re-pinning onto the merged commit is metadata-only: the content is
      // identical, so no installed byte changes.
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
