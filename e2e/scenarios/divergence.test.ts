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
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      const refusedFragment = await world.capshelf(project, [
        "keep-local",
        "settings/permissions",
      ]);
      expectExit(refusedFragment, 3);

      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const lockAfterMarking = await readFile(lockPath, "utf-8");

      for (let release = 1; release <= 5; release += 1) {
        await world.git.writeAndCommit(
          shelf,
          { "skills/security-review/SKILL.md": `shared rules v${release}\n` },
          `release ${release}`,
        );
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

      const refusedPromote = await world.capshelf(project, [
        "promote",
        "skills/security-review",
        "-m",
        "publish PCI rules",
      ]);
      expectExit(refusedPromote, 3);
      expectOutputContains(refusedPromote, "--unset");

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
