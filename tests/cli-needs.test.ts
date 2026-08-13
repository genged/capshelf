import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";
import { shaOfGitVisibleItem } from "../src/master";

describe("declared needs CLI lifecycle", () => {
  test("pins, displays, and refreshes needs without rewriting content", async () => {
    const project = await tempRepo("capshelf-needs-project-");
    const dataRepo = await tempRepo("capshelf-needs-data-");
    const extension = join(dataRepo, "pi", "extensions", "exa-mcp");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export default {};\n");
    await writeFile(
      join(extension, ".capshelf.yml"),
      [
        "needs:",
        "  network: [MCP.Exa.AI]",
        "  env: [EXA_API_KEY]",
        "  bin: [agent-browser]",
        "",
      ].join("\n"),
    );
    await mkdir(join(dataRepo, "skills", "network-helper"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "network-helper", "SKILL.md"),
      "helper\n",
    );
    await writeFile(
      join(dataRepo, "skills", "network-helper", ".capshelf.yml"),
      "needs:\n  network: [api.example.com]\n  env: [HELPER_TOKEN]\n",
    );
    await mkdir(join(dataRepo, "bundles"));
    await writeFile(
      join(dataRepo, "bundles", "networked.yml"),
      "includes:\n  skills: [network-helper]\n  pi-extensions: [exa-mcp]\n",
    );
    await commitAll(dataRepo, "add extension");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const bundleShow = JSON.parse(
      (await run(["show", "bundles/networked", "--json"])).stdout.toString(),
    );
    expect(bundleShow.needs).toEqual({
      network: ["api.example.com", "mcp.exa.ai"],
      env: ["EXA_API_KEY", "HELPER_TOKEN"],
      bin: ["agent-browser"],
    });

    const add = await run(["add", "pi-extensions/exa-mcp"]);
    expect(add.exitCode).toBe(0);
    expect(add.stdout.toString()).toContain(
      "reads env: EXA_API_KEY · needs on PATH: agent-browser",
    );

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const addedLock = await file(lockPath).json();
    const addedEntry = addedLock.items["data/pi-extensions/exa-mcp"];
    expect(addedLock.version).toBe(4);
    expect(addedEntry.needs).toEqual({
      network: ["mcp.exa.ai"],
      env: ["EXA_API_KEY"],
      bin: ["agent-browser"],
    });
    expect(addedEntry.needsSourceCommit).toMatch(/^[0-9a-f]{40}$/);

    const statusBefore = JSON.parse(
      (await run(["status", "--json"])).stdout.toString(),
    );
    const beforeRow = statusBefore.items.find(
      (row: { name: string }) => row.name === "exa-mcp",
    );
    expect(beforeRow.needsState).toBe("current");
    expect(beforeRow.lockedNeeds).toEqual(addedEntry.needs);
    expect((await run(["status", "--strict"])).exitCode).toBe(0);

    const humanShow = await run([
      "show",
      "pi-extensions/exa-mcp",
      "--no-content",
    ]);
    expect(humanShow.exitCode).toBe(0);
    expect(humanShow.stdout.toString()).toContain("needs network: mcp.exa.ai");

    const installedPath = join(project, ".pi", "extensions", "exa-mcp");
    const bytesBefore = await file(
      join(installedPath, "index.ts"),
    ).arrayBuffer();
    const mtimeBefore = (await stat(join(installedPath, "index.ts"))).mtimeMs;
    await writeFile(
      join(extension, ".capshelf.yml"),
      [
        "needs:",
        "  network: [mcp.exa.ai, api.example.com]",
        "  env: [EXA_API_KEY]",
        "  bin: [agent-browser]",
        "",
      ].join("\n"),
    );
    await commitAll(dataRepo, "expand network needs");

    const stale = JSON.parse(
      (await run(["status", "--json"])).stdout.toString(),
    ).items.find((row: { name: string }) => row.name === "exa-mcp");
    expect(stale.state).toBe("ok");
    expect(stale.needsState).toBe("update_available");
    expect(stale.lockedNeeds).toEqual(addedEntry.needs);

    const updated = await run(["update", "pi-extensions/exa-mcp", "--json"]);
    expect(updated.exitCode).toBe(0);
    const updatedEntry = (await file(lockPath).json()).items[
      "data/pi-extensions/exa-mcp"
    ];
    expect(updatedEntry.sourcePinDigest).toBe(addedEntry.sourcePinDigest);
    expect(updatedEntry.sourceCommit).toBe(addedEntry.sourceCommit);
    expect(updatedEntry.needs.network).toEqual([
      "api.example.com",
      "mcp.exa.ai",
    ]);
    expect(updatedEntry.needsSourceCommit).not.toBe(
      addedEntry.needsSourceCommit,
    );
    expect(
      Buffer.from(await file(join(installedPath, "index.ts")).arrayBuffer()),
    ).toEqual(Buffer.from(bytesBefore));
    expect((await stat(join(installedPath, "index.ts"))).mtimeMs).toBe(
      mtimeBefore,
    );

    const show = JSON.parse(
      (
        await run(["show", "pi-extensions/exa-mcp", "--json"])
      ).stdout.toString(),
    );
    expect(show.metadata.needs).toEqual(updatedEntry.needs);
    expect(show.lockedNeeds).toEqual(updatedEntry.needs);
    expect(show.needsState).toBe("current");

    const bundleProject = await tempRepo("capshelf-needs-bundle-project-");
    const bundleRun = runInProcess(bundleProject);
    expect((await bundleRun(["init", "--data", dataRepo])).exitCode).toBe(0);
    const bundleAdd = await bundleRun(["add", "bundles/networked"]);
    expect(bundleAdd.exitCode).toBe(0);
    expect(bundleAdd.stdout.toString()).toContain("reads env: HELPER_TOKEN");
    expect(bundleAdd.stdout.toString()).toContain(
      "reads env: EXA_API_KEY · needs on PATH: agent-browser",
    );
    const bundleLock = await file(
      join(bundleProject, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(bundleLock.items["data/skills/network-helper"].needs.env).toEqual([
      "HELPER_TOKEN",
    ]);
    expect(
      bundleLock.items["data/pi-extensions/exa-mcp"].needs.network,
    ).toEqual(["api.example.com", "mcp.exa.ai"]);
  });

  test("a legacy lock stays readable, and every writer points at lock migrate", async () => {
    const project = await tempRepo("capshelf-needs-v2-project-");
    const dataRepo = await tempRepo("capshelf-needs-v2-data-");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(
      join(dataRepo, "skills", "hello", ".capshelf.yml"),
      "needs:\n  network: [api.example.com]\n",
    );
    await commitAll(dataRepo, "hello");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lock = await file(lockPath).json();
    const entry = lock.items["data/skills/hello"];
    // A genuine version-2 entry: identity is the working-tree hash, and there
    // is no needs snapshot at all.
    lock.items["data/skills/hello"] = {
      source: "data",
      sha: await shaOfGitVisibleItem(dataRepo, "skills/hello"),
      sourceCommit: entry.sourceCommit,
      appliedAt: entry.appliedAt,
    };
    lock.version = 2;
    const legacyBytes = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(lockPath, legacyBytes);

    const status = await run(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const row = JSON.parse(status.stdout.toString()).items.find(
      (item: { name: string }) => item.name === "hello",
    );
    expect(row.needsState).toBe("unknown");
    expect(row.lockedNeeds).toBeNull();
    expect((await file(lockPath).json()).version).toBe(2);

    // PIN-12: no ordinary lock write migrates. `update` refuses and names the
    // one command that converts the project, and the lock is byte-identical
    // afterwards.
    const refused = await run(["update", "skills/hello"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("capshelf lock migrate");
    expect(await file(lockPath).text()).toBe(legacyBytes);
  });

  test(
    "preserves clone-local needs through reconciliation and scope moves",
    async () => {
      const project = await tempRepo("capshelf-needs-local-project-");
      const dataRepo = await tempRepo("capshelf-needs-local-data-");
      const extension = join(dataRepo, "pi", "extensions", "local-needs");
      await mkdir(extension, { recursive: true });
      await writeFile(join(extension, "index.ts"), "export default 1;\n");
      await writeFile(
        join(extension, ".capshelf.yml"),
        [
          "needs:",
          "  network: [api.example.com]",
          "  env: [LOCAL_TOKEN]",
          "  bin: [local-tool]",
          "",
        ].join("\n"),
      );
      await commitAll(dataRepo, "add local extension");

      const run = runInProcess(project);
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      const add = await run([
        "add",
        "pi-extensions/local-needs",
        "--local",
        "--json",
      ]);
      expect(add.exitCode).toBe(0);
      expect(JSON.parse(add.stdout.toString())).toMatchObject({
        kind: "pi-extensions",
        name: "local-needs",
        scope: "local",
        needs: {
          network: ["api.example.com"],
          env: ["LOCAL_TOKEN"],
          bin: ["local-tool"],
        },
      });

      const key = "data/pi-extensions/local-needs";
      const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
      const localLockPath = join(project, ".capshelf", "local.lock.json");
      const readSnapshot = async (path: string) => {
        const entry = (await file(path).json()).items[key];
        return {
          needs: entry.needs,
          needsSourceCommit: entry.needsSourceCommit,
        };
      };
      const pinnedSnapshot = await readSnapshot(localLockPath);

      const installed = join(
        project,
        ".pi",
        "extensions",
        "local-needs",
        "index.ts",
      );
      await writeFile(installed, "export default 2;\n");
      expect(
        (
          await run([
            "keep-local",
            "pi-extensions/local-needs",
            "--local",
            "--reason",
            "test divergence",
          ])
        ).exitCode,
      ).toBe(0);
      expect(await readSnapshot(localLockPath)).toEqual(pinnedSnapshot);

      expect((await run(["apply", "--local"])).exitCode).toBe(0);
      expect(await readSnapshot(localLockPath)).toEqual(pinnedSnapshot);
      expect(await file(installed).text()).toBe("export default 2;\n");

      expect(
        (await run(["revert", "pi-extensions/local-needs", "--local", "--yes"]))
          .exitCode,
      ).toBe(0);
      expect(await readSnapshot(localLockPath)).toEqual(pinnedSnapshot);
      expect(await file(installed).text()).toBe("export default 1;\n");
      expect((await file(localLockPath).json()).items[key].local).toBe(true);

      // The marker records intent, not content state, so revert restores bytes
      // and leaves it set: apply keeps skipping until it is explicitly cleared.
      await writeFile(installed, "export default 3;\n");
      expect((await run(["apply", "--local"])).exitCode).toBe(0);
      expect(await file(installed).text()).toBe("export default 3;\n");
      expect(
        (
          await run([
            "keep-local",
            "pi-extensions/local-needs",
            "--local",
            "--unset",
          ])
        ).exitCode,
      ).toBe(0);
      expect((await run(["apply", "--local"])).exitCode).toBe(3);
      expect(await file(installed).text()).toBe("export default 3;\n");
      expect((await run(["apply", "--local", "--yes"])).exitCode).toBe(0);
      expect(await readSnapshot(localLockPath)).toEqual(pinnedSnapshot);
      expect(await file(installed).text()).toBe("export default 1;\n");

      expect(
        (await run(["move", "pi-extensions/local-needs", "--to", "project"]))
          .exitCode,
      ).toBe(0);
      expect(await readSnapshot(projectLockPath)).toEqual(pinnedSnapshot);

      expect(
        (await run(["move", "pi-extensions/local-needs", "--to", "local"]))
          .exitCode,
      ).toBe(0);
      expect(await readSnapshot(localLockPath)).toEqual(pinnedSnapshot);

      const status = JSON.parse(
        (
          await run([
            "status",
            "pi-extensions/local-needs",
            "--local",
            "--json",
          ])
        ).stdout.toString(),
      );
      expect(status.items).toHaveLength(1);
      expect(status.items[0]).toMatchObject({
        scope: "local",
        needsState: "current",
        lockedNeeds: pinnedSnapshot.needs,
      });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("share and promote capture committed needs in the selected lock", async () => {
    const project = await tempRepo("capshelf-needs-share-project-");
    const dataRepo = await tempRepo("capshelf-needs-share-data-");
    await writeFile(join(dataRepo, "README.md"), "data\n");
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const installed = join(project, ".pi", "extensions", "shared");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "index.ts"), "export default 1;\n");
    await writeFile(
      join(installed, ".capshelf.yml"),
      "needs:\n  network: [one.example.com]\n",
    );
    const share = await run([
      "share",
      "pi-extensions/shared",
      "-m",
      "share extension",
      "--json",
    ]);
    expect(share.exitCode).toBe(0);
    expect(JSON.parse(share.stdout.toString())).toMatchObject({
      verb: "share",
      kind: "pi-extensions",
      name: "shared",
      scope: "project",
      needs: { network: ["one.example.com"], env: [], bin: [] },
    });

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    let entry = (await file(lockPath).json()).items[
      "data/pi-extensions/shared"
    ];
    expect(entry.needs.network).toEqual(["one.example.com"]);
    const firstNeedsCommit = entry.needsSourceCommit;

    await writeFile(join(installed, "index.ts"), "export default 2;\n");
    await writeFile(
      join(installed, ".capshelf.yml"),
      "needs:\n  network: [two.example.com]\n",
    );
    const promote = await run([
      "promote",
      "pi-extensions/shared",
      "-m",
      "promote extension",
      "--json",
    ]);
    expect(promote.exitCode).toBe(0);
    expect(JSON.parse(promote.stdout.toString())).toMatchObject({
      source: "data",
      kind: "pi-extensions",
      name: "shared",
      action: "promoted",
      committed: true,
    });

    entry = (await file(lockPath).json()).items["data/pi-extensions/shared"];
    expect(entry.needs.network).toEqual(["two.example.com"]);
    expect(entry.needsSourceCommit).not.toBe(firstNeedsCommit);
    expect(
      await file(
        join(dataRepo, "pi", "extensions", "shared", ".capshelf.yml"),
      ).text(),
    ).toContain("two.example.com");
  });
});
