import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, runInProcess, tempRepo } from "./cli-fixtures";

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
    expect(addedLock.version).toBe(3);
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
    expect(updatedEntry.sha).toBe(addedEntry.sha);
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

  test("v2 status stays read-only and update captures an unknown snapshot", async () => {
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
    delete lock.items["data/skills/hello"].needs;
    delete lock.items["data/skills/hello"].needsSourceCommit;
    lock.version = 2;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const status = await run(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const row = JSON.parse(status.stdout.toString()).items.find(
      (item: { name: string }) => item.name === "hello",
    );
    expect(row.needsState).toBe("unknown");
    expect(row.lockedNeeds).toBeNull();
    expect((await file(lockPath).json()).version).toBe(2);

    expect((await run(["update", "skills/hello"])).exitCode).toBe(0);
    const refreshed = await file(lockPath).json();
    expect(refreshed.version).toBe(3);
    expect(refreshed.items["data/skills/hello"].needs.network).toEqual([
      "api.example.com",
    ]);
  });

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
    expect(
      (await run(["share", "pi-extensions/shared", "-m", "share extension"]))
        .exitCode,
    ).toBe(0);

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
    expect(
      (
        await run([
          "promote",
          "pi-extensions/shared",
          "-m",
          "promote extension",
        ])
      ).exitCode,
    ).toBe(0);

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
