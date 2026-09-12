import { expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as fragments from "../src/fragments";
import * as git from "../src/git";
import { buildStatusReport } from "../src/status-report";
import { emptyLock } from "../src/lock";
import { emptyManifest } from "../src/manifest";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "../src/pin";
import { normalizeClaudeSettingsOutput } from "../src/json-fragments";
import { CLI_VERSION } from "../src/bundled";
import {
  commitAll,
  tempDir,
  tempRepo,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
} from "./cli-fixtures";

async function reportFixture(withMcp = false) {
  const dataRepo = await tempRepo("capshelf-report-data-");
  const project = await tempDir("capshelf-report-project-");
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(dataRepo, "settings", name), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", name, "settings.json"),
      JSON.stringify({ env: { [name]: "1" } }),
    );
    await writeFile(
      join(dataRepo, "settings", name, ".capshelf.yml"),
      "needs:\n  bin: [old-tool]\n",
    );
  }
  const manifest = emptyManifest();
  manifest.settings = ["a", "b", "c"];
  if (withMcp) {
    manifest.mcp = ["claude", "codex"];
    await mkdir(join(dataRepo, "mcp/claude"), { recursive: true });
    await mkdir(join(dataRepo, "mcp/codex"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp/claude/claude.json"),
      '{"mcpServers":{"claude":{"command":"claude-tool"}}}',
    );
    await writeFile(
      join(dataRepo, "mcp/codex/codex.toml"),
      '[mcp_servers.codex]\ncommand = "codex-tool"\n',
    );
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(
      join(project, ".codex/config.toml"),
      '[mcp_servers.codex]\ncommand = "codex-tool"\n',
    );
  }
  await commitAll(dataRepo, "sources");
  const commit = await git.headSha(dataRepo);
  const projectLock = emptyLock();
  for (const kind of ["settings", "mcp"] as const) {
    for (const name of manifest[kind]) {
      projectLock.items[`data/${kind}/${name}`] = {
        source: "data",
        sourceCommit: commit,
        sourcePinDigest: sourcePinDigest(
          await itemTreeEntriesAtCommit(dataRepo, kind, name, commit),
        ),
        needs: {
          bin: kind === "settings" ? ["old-tool"] : [],
          env: [],
          network: [],
        },
        needsSourceCommit: commit,
        appliedAt: "2026-09-12T00:00:00.000Z",
      };
    }
  }
  await mkdir(join(project, ".claude"), { recursive: true });
  await writeFile(
    join(project, ".claude/settings.json"),
    JSON.stringify(
      normalizeClaudeSettingsOutput({ env: { a: "1", b: "1", c: "1" } }),
    ),
  );
  return { project, dataRepo, manifest, projectLock, localLock: emptyLock() };
}

test(
  "one contribution merge per output, with fresh output observations in each report",
  async () => {
    const input = await reportFixture();
    const merge = spyOn(fragments, "fragmentContributionState");
    try {
      const first = await buildStatusReport(input);
      expect(
        first.rows
          .filter((row) => row.kind === "settings")
          .map((row) => row.state),
      ).toEqual(["ok", "ok", "ok"]);
      expect(merge).toHaveBeenCalledTimes(1);
      await rm(join(input.project, ".claude", "settings.json"));
      const second = await buildStatusReport(input);
      expect(
        second.rows
          .filter((row) => row.kind === "settings")
          .map((row) => row.state),
      ).toEqual(["missing_output", "missing_output", "missing_output"]);
      expect(merge).toHaveBeenCalledTimes(2);
    } finally {
      merge.mockRestore();
      await rm(input.project, { recursive: true, force: true });
      await rm(input.dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

for (const failure of ["none", "first", "all"] as const) {
  test(
    `report HEAD observations: ${failure} failures`,
    async () => {
      const input = await reportFixture();
      const original = git.headSha;
      let reads = 0;
      const read = spyOn(git, "headSha").mockImplementation(async (repo) => {
        reads += 1;
        if (failure === "all" || (failure === "first" && reads === 1))
          throw new Error("injected HEAD failure");
        return await original(repo);
      });
      try {
        const report = await buildStatusReport(input);
        const rows = report.rows.filter((row) => row.kind === "settings");
        expect(reads).toBe(
          failure === "none" ? 1 : failure === "first" ? 2 : 3,
        );
        expect(rows.map((row) => row.needsState)).toEqual(
          failure === "all"
            ? ["unavailable", "unavailable", "unavailable"]
            : failure === "first"
              ? ["unavailable", "current", "current"]
              : ["current", "current", "current"],
        );
        if (failure === "none") {
          await writeFile(
            join(input.dataRepo, "settings/a/.capshelf.yml"),
            "needs:\n  bin: [new-tool]\n",
          );
          await commitAll(input.dataRepo, "new needs");
          const second = await buildStatusReport(input);
          expect(reads).toBe(2);
          expect(second.rows.find((row) => row.name === "a")?.needsState).toBe(
            "update_available",
          );
        }
      } finally {
        read.mockRestore();
        await rm(input.project, { recursive: true, force: true });
        await rm(input.dataRepo, { recursive: true, force: true });
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

for (const failure of ["none", "first", "all"] as const) {
  test(
    `report object-directory observations: ${failure} failures`,
    async () => {
      const input = await reportFixture();
      const original = git.repositoryObjectsDirectory;
      let reads = 0;
      const read = spyOn(git, "repositoryObjectsDirectory").mockImplementation(
        async (repo) => {
          reads += 1;
          if (failure === "all" || (failure === "first" && reads === 1))
            throw new Error("injected object directory failure");
          return await original(repo);
        },
      );
      try {
        const report = await buildStatusReport(input);
        expect(reads).toBe(
          failure === "none" ? 1 : failure === "first" ? 2 : 3,
        );
        expect(
          report.rows
            .filter((row) => row.kind === "settings")
            .map((row) => row.state),
        ).toEqual(["ok", "ok", "ok"]);
        await buildStatusReport(input);
        expect(reads).toBe(
          failure === "none" ? 2 : failure === "first" ? 3 : 6,
        );
      } finally {
        read.mockRestore();
        await rm(input.project, { recursive: true, force: true });
        await rm(input.dataRepo, { recursive: true, force: true });
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

test(
  "empty, system-only, and unbound reports do not read repository observations",
  async () => {
    const input = await reportFixture();
    const head = spyOn(git, "headSha");
    const objects = spyOn(git, "repositoryObjectsDirectory");
    try {
      await buildStatusReport({ ...input, projectLock: emptyLock() });
      const systemLock = emptyLock();
      systemLock.items["system/skills/capshelf"] = {
        source: "system",
        sha: "fixture",
        cliVersion: CLI_VERSION,
        appliedAt: "2026-09-12T00:00:00.000Z",
      };
      await buildStatusReport({ ...input, projectLock: systemLock });
      await buildStatusReport({ ...input, dataRepo: null });
      expect(head).not.toHaveBeenCalled();
      expect(objects).not.toHaveBeenCalled();
    } finally {
      head.mockRestore();
      objects.mockRestore();
      await rm(input.project, { recursive: true, force: true });
      await rm(input.dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "contribution reuse keeps each item's own target set",
  async () => {
    const input = await reportFixture(true);
    try {
      const merge = spyOn(fragments, "fragmentContributionState");
      try {
        const report = await buildStatusReport(input);
        expect(
          report.rows.find((row) => row.kind === "mcp" && row.name === "claude")
            ?.state,
        ).toBe("missing_output");
        expect(
          report.rows.find((row) => row.kind === "mcp" && row.name === "codex")
            ?.state,
        ).toBe("ok");
        expect(merge.mock.calls.map((call) => call[4]).sort()).toEqual([
          "claude-mcp",
          "claude-settings",
          "codex-config",
        ]);
      } finally {
        merge.mockRestore();
      }
    } finally {
      await rm(input.project, { recursive: true, force: true });
      await rm(input.dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
