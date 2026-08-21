import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expectExit,
  expectOutputContains,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "divergence";

const INSTALLED = ".agents/skills/security-review/SKILL.md";

test(
  "a recorded divergence survives five upstream releases and only one command clears it",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "keep-local records intent: update and apply skip the item, promote refuses, revert keeps the marker and never rewrites the lock, and only keep-local --unset clears it",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "upstream movement is modeled as five commits in one clone rather than five releases over a quarter; capshelf reads commits, not dates",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/security-review/SKILL.md": "shared rules\n",
          "settings/permissions/settings.json":
            '{"permissions":{"allow":["Bash(git status)"]}}\n',
        },
      });
      const project = await world.git.createProject("payments");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(
        await world.capshelf(project, ["add", "skills/security-review"]),
        0,
      );
      expectExit(
        await world.capshelf(project, ["add", "settings/permissions"]),
        0,
      );

      const installed = join(project, INSTALLED);
      await writeFile(installed, "shared rules\nPCI rules\n");
      const drifted = await world.capshelf(project, [
        "status",
        "skills/security-review",
        "--json",
      ]);
      expectExit(drifted, 0);
      expect(
        statusRow(parseStatusRows(drifted.stdout), "skills", "security-review")
          .state,
      ).toBe("drifted_local");

      expectExit(
        await world.capshelf(project, [
          "keep-local",
          "skills/security-review",
          "--reason",
          "payments is PCI-scoped",
        ]),
        0,
      );
      const marked = await world.capshelf(project, ["status", "--json"]);
      expect(
        statusRow(parseStatusRows(marked.stdout), "skills", "security-review")
          .state,
      ).toBe("kept-local");
      // kept-local is the one non-ok state --strict tolerates.
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      // A fragment has no marker: project-only values belong in the output.
      const refusedFragment = await world.capshelf(project, [
        "keep-local",
        "settings/permissions",
      ]);
      expectExit(refusedFragment, 3);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lockAfterMarking = await readFile(lockPath, "utf-8");

      // Five upstream releases. None of them may revoke the intent.
      for (let release = 1; release <= 5; release += 1) {
        await world.git.writeAndCommit(
          shelf,
          { "skills/security-review/SKILL.md": `shared rules v${release}\n` },
          `release ${release}`,
        );
        // Skipping is not silent: each run prints the reason and ends with
        // the command that would resume reconciliation
        // (docs/cli.md:958-961).
        const updated = await world.capshelf(project, ["update"]);
        expectExit(updated, 0);
        expectOutputContains(updated, "--unset");
        const applied = await world.capshelf(project, ["apply"]);
        expectExit(applied, 0);
        expectOutputContains(applied, "--unset");
        expect(await readFile(installed, "utf-8")).toBe(
          "shared rules\nPCI rules\n",
        );
        expect(
          statusRow(
            parseStatusRows(
              (await world.capshelf(project, ["status", "--json"])).stdout,
            ),
            "skills",
            "security-review",
          ).state,
        ).toBe("kept-local");
      }
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      // Publishing the divergence would end it, so promote refuses and names
      // the pair of commands that would do it deliberately.
      const refusedPromote = await world.capshelf(project, [
        "promote",
        "skills/security-review",
        "-m",
        "publish PCI rules",
      ]);
      expectExit(refusedPromote, 3);
      expectOutputContains(refusedPromote, "--unset");

      // revert is the explicit override that keeps the intent: it restores
      // the pinned bytes and never rewrites the lock.
      expectExit(
        await world.capshelf(project, [
          "revert",
          "skills/security-review",
          "--yes",
        ]),
        0,
      );
      expect(await readFile(installed, "utf-8")).toBe("shared rules\n");
      expect(await readFile(lockPath, "utf-8")).toBe(lockAfterMarking);

      // A second revert has nothing to restore and says the marker is still
      // set (docs/cli.md:966-967).
      const again = await world.capshelf(project, [
        "revert",
        "skills/security-review",
      ]);
      expectExit(again, 0);
      expectOutputContains(again, "already current");
      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(project, ["status", "--json"])).stdout,
          ),
          "skills",
          "security-review",
        ).state,
      ).toBe("kept-local");

      // Exactly one command clears it.
      expectExit(
        await world.capshelf(project, [
          "keep-local",
          "skills/security-review",
          "--unset",
        ]),
        0,
      );
      const cleared = statusRow(
        parseStatusRows(
          (await world.capshelf(project, ["status", "--json"])).stdout,
        ),
        "skills",
        "security-review",
      );
      expect(cleared.state).not.toBe("kept-local");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "update merge reconciles locally before a separate promote",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "promote refuses when upstream moved past the lock, update --merge reconciles and pins without changing the shelf, and a later normal promote publishes the reviewed result",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: { "skills/security-review/SKILL.md": "base\nmiddle\ntail\n" },
      });
      const project = await world.git.createProject("payments");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(
        await world.capshelf(project, ["add", "skills/security-review"]),
        0,
      );

      // Upstream changes the head of the file; the project changes the tail.
      await world.git.writeAndCommit(
        shelf,
        { "skills/security-review/SKILL.md": "base upstream\nmiddle\ntail\n" },
        "upstream edit",
      );
      await writeFile(
        join(project, INSTALLED),
        "base\nmiddle\ntail plus PCI rules\n",
      );

      const stale = await world.capshelf(project, [
        "promote",
        "skills/security-review",
        "-m",
        "publish",
      ]);
      expectExit(stale, 3);
      // The refusal offers three safe choices (docs/cli.md:969-977): merge the
      // two committed lines of work, take upstream, or overwrite on purpose.
      // A user in this state whose edit and upstream's edit both matter needs
      // the first one named — the other two each discard a side.
      expectOutputContains(stale, "capshelf update skills/security-review");
      expectOutputContains(stale, "--stale-ok");
      expectOutputContains(stale, "--merge");

      const bothDiffs = await world.capshelf(project, [
        "status",
        "skills/security-review",
        "--diff",
      ]);
      expectExit(bothDiffs, 0);
      expectOutputContains(bothDiffs, "[locked -> installed]");
      expectOutputContains(bothDiffs, "[locked -> upstream]");

      const commitsBefore = (
        await world.git.ok(shelf, ["rev-list", "--count", "HEAD"])
      ).stdout.trim();
      const merged = await world.capshelf(project, [
        "update",
        "skills/security-review",
        "--merge",
        "--json",
      ]);
      expectExit(merged, 0);
      const commitsAfterUpdate = (
        await world.git.ok(shelf, ["rev-list", "--count", "HEAD"])
      ).stdout.trim();
      expect(commitsAfterUpdate).toBe(commitsBefore);
      expect(
        await readFile(
          join(shelf, "skills", "security-review", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("base upstream\nmiddle\ntail\n");
      expect(await readFile(join(project, INSTALLED), "utf-8")).toBe(
        "base upstream\nmiddle\ntail plus PCI rules\n",
      );

      const review = await world.capshelf(project, [
        "status",
        "skills/security-review",
        "--diff-view",
        "installed",
      ]);
      expectExit(review, 0);
      expectOutputContains(review, "[locked -> installed]");

      expectExit(
        await world.capshelf(project, [
          "promote",
          "skills/security-review",
          "-m",
          "merge PCI rules with upstream",
        ]),
        0,
      );
      const commitsAfterPromote = (
        await world.git.ok(shelf, ["rev-list", "--count", "HEAD"])
      ).stdout.trim();
      expect(Number(commitsAfterPromote) - Number(commitsBefore)).toBe(1);
      // One ordinary single-parent commit, not a merge commit.
      expect(
        (
          await world.git.ok(shelf, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            "HEAD",
          ])
        ).stdout
          .trim()
          .split(" ").length,
      ).toBe(2);

      const upstreamText = await readFile(
        join(shelf, "skills", "security-review", "SKILL.md"),
        "utf-8",
      );
      expect(upstreamText).toBe("base upstream\nmiddle\ntail plus PCI rules\n");
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
