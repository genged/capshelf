import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectSameState,
  parseStatusRows,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "bundles";

const BUNDLE_V1 = `description: Everything a Go backend service needs.
tags: [go, backend]
includes:
  skills:   [security-review, go-test-writer]
  settings: [permissions-base]
  mcp:      [github]
`;

const BUNDLE_V2 = `description: Everything a Go backend service needs.
tags: [go, backend]
includes:
  skills:   [security-review, go-test-writer, incident-response]
  settings: [permissions-base]
  mcp:      [github]
`;

const SHELF_FILES: Record<string, string> = {
  "skills/security-review/SKILL.md": "security review\n",
  "skills/go-test-writer/SKILL.md": "go test writer\n",
  "skills/incident-response/SKILL.md": "incident response\n",
  "settings/permissions-base/settings.json":
    '{"permissions":{"allow":["Bash(go test ./...)"]}}\n',
  "mcp/github/claude.json":
    '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
  "bundles/go-backend.yml": BUNDLE_V1,
};

async function lockKeys(project: string): Promise<string[]> {
  const lock = JSON.parse(
    await readFile(join(project, ".capshelf", "capshelf.lock.json"), "utf-8"),
  ) as { items: Record<string, unknown> };
  return Object.keys(lock.items).sort();
}

test(
  "a bundle expands into independent items, leaves no trace, and never moves a pin on re-run",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "expansion produces one lock entry per member and no bundle record, a re-run adds only new members without bumping a pin, and a refused expansion writes nothing",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: SHELF_FILES,
      });
      const project = await world.git.createProject("service-1");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      const expanded = await world.capshelf(project, [
        "add",
        "bundles/go-backend",
        "--json",
      ]);
      expectExit(expanded, 0);
      expect(await lockKeys(project)).toEqual([
        "data/mcp/github",
        "data/settings/permissions-base",
        "data/skills/go-test-writer",
        "data/skills/security-review",
        "system/skills/capshelf",
      ]);

      // A macro leaves no versioning unit behind: the bundle name appears in
      // neither file a later reader would consult.
      const manifest = await readFile(
        join(project, ".capshelf", "capshelf.json"),
        "utf-8",
      );
      const lock = await readFile(
        join(project, ".capshelf", "capshelf.lock.json"),
        "utf-8",
      );
      expect(manifest).not.toContain("go-backend");
      expect(lock).not.toContain("go-backend");
      expect(manifest).not.toContain("bundle");

      // Re-running the same bundle is convergent, not an update.
      const beforeRerun = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      expectExit(
        await world.capshelf(project, ["add", "bundles/go-backend"]),
        0,
      );
      expectSameState(
        beforeRerun,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "re-running an unchanged bundle",
      );

      // The platform team advances an existing member and adds a new one.
      // Only the new member may install; the older pins must not move.
      await world.git.writeAndCommit(
        shelf,
        {
          "skills/security-review/SKILL.md": "security review v2\n",
          "bundles/go-backend.yml": BUNDLE_V2,
        },
        "grow the bundle and advance a member",
      );
      const pinnedBefore = parseStatusRows(
        (await world.capshelf(project, ["status", "--json"])).stdout,
      );
      expectExit(
        await world.capshelf(project, ["add", "bundles/go-backend"]),
        0,
      );
      expect(await lockKeys(project)).toEqual([
        "data/mcp/github",
        "data/settings/permissions-base",
        "data/skills/go-test-writer",
        "data/skills/incident-response",
        "data/skills/security-review",
        "system/skills/capshelf",
      ]);
      const pinnedAfter = parseStatusRows(
        (await world.capshelf(project, ["status", "--json"])).stdout,
      );
      const lockedSha = (
        rows: ReturnType<typeof parseStatusRows>,
        name: string,
      ) =>
        rows.find((row) => row.kind === "skills" && row.name === name)
          ?.lockedSha;
      expect(lockedSha(pinnedAfter, "security-review")).toBe(
        lockedSha(pinnedBefore, "security-review"),
      );
      expect(
        await readFile(
          join(project, ".agents", "skills", "security-review", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("security review\n");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a refused expansion installs no member at all",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "one member that fails preflight refuses the whole expansion, including members that would have installed cleanly",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: SHELF_FILES,
      });
      const project = await world.git.createProject("service-4");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      // An untracked directory already occupies one member's install path.
      const occupied = join(project, ".agents", "skills", "security-review");
      await mkdir(occupied, { recursive: true });
      await writeFile(join(occupied, "SKILL.md"), "local copy\n");

      const before = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
        requiredAbsent: [
          join(project, ".agents", "skills", "go-test-writer"),
          join(project, ".mcp.json"),
        ],
      });
      const refused = await world.capshelf(project, [
        "add",
        "bundles/go-backend",
      ]);
      expectExit(refused, 3);
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          requiredAbsent: [
            join(project, ".agents", "skills", "go-test-writer"),
            join(project, ".mcp.json"),
          ],
        }),
        "refused bundle expansion",
      );
      expect(await lockKeys(project)).toEqual(["system/skills/capshelf"]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
