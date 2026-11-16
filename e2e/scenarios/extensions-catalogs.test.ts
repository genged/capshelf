import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectAbsent,
  expectExit,
  expectOutputContains,
  expectSameState,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "extensions-catalogs";

const EXTENSION = "console.log('deploy helper');\n";

test(
  "a Pi extension is adopted at clone-local scope, warns that it executes code, and never touches Pi's own state",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "share adopts an on-disk Pi extension into the shelf at local scope, excludes the install path from project Git, warns about code execution without failing strict, and writes neither the user Pi extension root nor .pi/settings.json",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "Pi is not installed or started, so extension loading and the dependency warning's runtime consequence are not observed",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { "code-review": "code review\n" },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      const extensionDir = join(project, ".pi", "extensions", "deploy-helper");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(join(extensionDir, "index.ts"), EXTENSION);
      await writeFile(
        join(project, ".pi", "settings.json"),
        '{"theme":"dark"}\n',
      );

      const userPiRoot = join(world.home, ".pi", "agent", "extensions");
      const piSettings = join(project, ".pi", "settings.json");

      // `--to local` is explicit because the default scope for Pi extensions is
      // project.
      const shared = await world.capshelf(project, [
        "share",
        "pi-extensions/deploy-helper",
        "--to",
        "local",
        "-m",
        "adopt the deploy helper",
      ]);
      expectExit(shared, 0);
      expectOutputContains(shared, "execute arbitrary code");

      expect(
        await readFile(
          join(shelf, "pi", "extensions", "deploy-helper", "index.ts"),
          "utf-8",
        ),
      ).toBe(EXTENSION);
      const exclude = await readFile(
        join(project, ".git", "info", "exclude"),
        "utf-8",
      );
      expect(exclude).toContain(".pi/extensions/deploy-helper/");

      await expectAbsent(userPiRoot);
      expect(await readFile(piSettings, "utf-8")).toBe('{"theme":"dark"}\n');

      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      const shelfBefore = await captureOwnedState(world, {
        dataRepo: { path: shelf, paths: ["pi"] },
      });
      expectExit(
        await world.capshelf(project, [
          "move",
          "pi-extensions/deploy-helper",
          "--to",
          "project",
        ]),
        0,
      );
      expectSameState(
        shelfBefore,
        await captureOwnedState(world, {
          dataRepo: { path: shelf, paths: ["pi"] },
        }),
        "move between scopes",
      );

      // A project-scope snapshot contains only Git-visible files, so a
      // gitignored entrypoint cannot be promoted.
      await writeFile(join(extensionDir, ".gitignore"), "index.ts\n");
      await writeFile(
        join(extensionDir, "index.ts"),
        `${EXTENSION}// edited\n`,
      );
      const refused = await world.capshelf(project, [
        "promote",
        "pi-extensions/deploy-helper",
        "-m",
        "publish the edit",
      ]);
      expectExit(refused, 3);
      expectOutputContains(refused, "index.ts");
      expectSameState(
        shelfBefore,
        await captureOwnedState(world, {
          dataRepo: { path: shelf, paths: ["pi"] },
        }),
        "promote with an ignored entrypoint",
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "catalog authoring commits in the shelf, never pushes, and never touches the project's manifest or lock",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "marketplace init, plugin create, and pack are shelf-side operations: they commit locally, leave the remote and both project locks untouched, and rebuilding an unchanged package reports already-built",
      labels: ["reproduced-user-workflow", "modeled-external-step"],
      modeledSteps: [
        "the shelf's remote is a local bare repository, so 'never pushes' is measured as its advertised refs never moving",
      ],
      proofLimits: [
        "no Claude or Codex runtime consumes the catalog, so registration and installation are not exercised",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const remote = await world.git.createBareRemote("shelf-remote");
      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: remote.url,
        skills: {
          "code-review": "code review\n",
          "test-planning": "planning\n",
        },
      });
      await world.git.ok(shelf, ["push", "-q", "-u", "origin", "main"]);
      const project = await world.git.createProject("atlas");
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
        await world.capshelf(project, ["add", "skills/code-review"]),
        0,
      );

      const projectStateBefore = await captureOwnedState(world, {
        projectFiles: { path: project, include: [".capshelf"] },
      });
      const remoteRefsBefore = await world.git.advertisedRefs(remote.url);
      const commitsBefore = Number(
        (
          await world.git.ok(shelf, ["rev-list", "--count", "HEAD"])
        ).stdout.trim(),
      );

      expectExit(
        await world.capshelf(project, [
          "marketplace",
          "init",
          "--target",
          "claude",
          "--name",
          "company",
          "--owner",
          "Engineering",
        ]),
        0,
      );
      expectExit(
        await world.capshelf(project, [
          "marketplace",
          "plugin",
          "create",
          "engineering",
          "--target",
          "claude",
          "--skill",
          "skills/code-review",
          "--skill",
          "skills/test-planning",
        ]),
        0,
      );

      const commitsAfter = Number(
        (
          await world.git.ok(shelf, ["rev-list", "--count", "HEAD"])
        ).stdout.trim(),
      );
      expect(commitsAfter).toBe(commitsBefore + 2);
      expect(await world.git.advertisedRefs(remote.url)).toEqual(
        remoteRefsBefore,
      );
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      expectSameState(
        projectStateBefore,
        await captureOwnedState(world, {
          projectFiles: { path: project, include: [".capshelf"] },
        }),
        "catalogs are shelf state, not project items",
      );

      const listed = await world.capshelf(project, ["marketplace", "ls"]);
      expectExit(listed, 0);
      expectOutputContains(listed, "engineering");
      expectExit(
        await world.capshelf(project, [
          "marketplace",
          "validate",
          "--target",
          "claude",
        ]),
        0,
      );

      const out = world.path("packages");
      await mkdir(out, { recursive: true });
      const packagePath = join(out, "engineering.plugin");
      const packed = await world.capshelf(project, [
        "marketplace",
        "plugin",
        "pack",
        "engineering",
        "--target",
        "claude",
        "--output",
        packagePath,
        "--json",
      ]);
      expectExit(packed, 0);
      const rebuild = await world.capshelf(project, [
        "marketplace",
        "plugin",
        "pack",
        "engineering",
        "--target",
        "claude",
        "--output",
        packagePath,
        "--json",
      ]);
      expectExit(rebuild, 0);
      expect(rebuild.stdout).toContain("already-built");

      const inside = await world.capshelf(project, [
        "marketplace",
        "plugin",
        "pack",
        "engineering",
        "--target",
        "claude",
        "--output",
        join(shelf, "packages", "engineering.plugin"),
        "--json",
      ]);
      expectExit(inside, 3);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
