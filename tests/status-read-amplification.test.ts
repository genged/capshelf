import { expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as fragments from "../src/fragments";
import * as git from "../src/git";
import { buildStatusDiff } from "../src/status-diff";
import type { StatusDiff, StatusDiffView } from "../src/status-diff";
import { buildStatusReport, collectStatusDiffs } from "../src/status-report";
import { emptyLock, refreshDataLockEntry } from "../src/lock";
import type { Lock } from "../src/lock";
import { emptyManifest } from "../src/manifest";
import { gitTreeSource } from "../src/item-source";
import {
  itemTreeEntriesAtCommit,
  pinCurrentSource,
  sourcePinDigest,
} from "../src/pin";
import { normalizeClaudeSettingsOutput } from "../src/json-fragments";
import { CLI_VERSION } from "../src/bundled";
import {
  commitAll,
  tempDir,
  tempRepo,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
} from "./cli-fixtures";

async function reportFixture(withMcp = false, marker = "fixture") {
  const dataRepo = await tempRepo("capshelf-report-data-");
  const project = await tempDir("capshelf-report-project-");
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(dataRepo, "settings", name), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", name, "settings.json"),
      JSON.stringify({ env: { [name]: marker } }),
    );
    await writeFile(
      join(dataRepo, "settings", name, ".capshelf.yml"),
      "needs:\n  bin: [old-tool]\n",
    );
  }
  const manifest = emptyManifest();
  manifest.settings = ["a", "b", "c"];
  if (withMcp) {
    manifest.mcp = ["claude", "codex", "both"];
    manifest.codexConfig = ["policy"];
    await mkdir(join(dataRepo, "mcp/claude"), { recursive: true });
    await mkdir(join(dataRepo, "mcp/codex"), { recursive: true });
    await mkdir(join(dataRepo, "mcp/both"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp/claude/claude.json"),
      JSON.stringify({
        mcpServers: { claude: { command: `claude-${marker}` } },
      }),
    );
    await writeFile(
      join(dataRepo, "mcp/codex/codex.toml"),
      `[mcp_servers.codex]\ncommand = "codex-${marker}"\n`,
    );
    await writeFile(
      join(dataRepo, "mcp/both/claude.json"),
      JSON.stringify({ mcpServers: { both: { command: `both-${marker}` } } }),
    );
    await writeFile(
      join(dataRepo, "mcp/both/codex.toml"),
      `[mcp_servers.both]\ncommand = "both-${marker}"\n`,
    );
    await mkdir(join(dataRepo, "codex/config/policy"), { recursive: true });
    await writeFile(
      join(dataRepo, "codex/config/policy/config.toml"),
      `[features]\npolicy_${marker} = true\n`,
    );
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(
      join(project, ".codex/config.toml"),
      `[mcp_servers.codex]\ncommand = "codex-${marker}"\n\n[mcp_servers.both]\ncommand = "both-${marker}"\n\n[features]\npolicy_${marker} = true\n`,
    );
  }
  await commitAll(dataRepo, "sources");
  const commit = await git.headSha(dataRepo);
  const projectLock = emptyLock();
  for (const [kind, names] of [
    ["settings", manifest.settings],
    ["mcp", manifest.mcp],
    ["codex-config", manifest.codexConfig],
  ] as const) {
    for (const name of names) {
      projectLock.items[`data/${kind}/${name}`] = {
        source: "data",
        sourceCommit: commit,
        sourcePinDigest: sourcePinDigest(
          await itemTreeEntriesAtCommit(
            gitTreeSource({ repo: dataRepo, kind, name, commit }),
            kind,
          ),
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
      normalizeClaudeSettingsOutput({
        env: { a: marker, b: marker, c: marker },
      }),
    ),
  );
  return { project, dataRepo, manifest, projectLock, localLock: emptyLock() };
}

async function uncachedDiffs(input: {
  project: string;
  dataRepo: string;
  manifest: ReturnType<typeof emptyManifest>;
  projectLock: Lock;
  localLock: Lock;
  rows: Awaited<ReturnType<typeof buildStatusReport>>["rows"];
  view: StatusDiffView;
}): Promise<StatusDiff[]> {
  const diffs: StatusDiff[] = [];
  for (const row of input.rows) {
    const views =
      input.view === "all"
        ? (["installed", "upstream"] as const)
        : [input.view];
    for (const view of views) {
      const diff = await buildStatusDiff({
        project: input.project,
        dataRepo: input.dataRepo,
        manifest: input.manifest,
        lock: row.scope === "local" ? input.localLock : input.projectLock,
        row,
        view,
      });
      if (diff !== null) diffs.push(diff);
    }
  }
  return diffs;
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

test(
  "one fragment plan serves all changed rows for one output",
  async () => {
    const input = await reportFixture();
    input.manifest.settings = ["a", "b"];
    delete input.projectLock.items["data/settings/c"];
    await writeFile(
      join(input.project, ".claude/settings.json"),
      JSON.stringify(normalizeClaudeSettingsOutput({ env: { RISK: "probe" } })),
    );
    const plan = spyOn(fragments, "planFragmentOutput");
    try {
      const report = await buildStatusReport(input);
      const diffs = await collectStatusDiffs({
        ...input,
        rows: report.rows,
        view: "installed",
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(diffs.map((diff) => diff.item).sort()).toEqual([
        "project/data/settings/a",
        "project/data/settings/b",
      ]);
      expect(diffs.every((diff) => diff.text?.includes("RISK"))).toBe(true);

      const repeated = await collectStatusDiffs({
        ...input,
        rows: report.rows,
        view: "installed",
      });
      expect(plan).toHaveBeenCalledTimes(2);
      expect(repeated).toEqual(diffs);

      await writeFile(
        join(input.dataRepo, "settings/a/settings.json"),
        JSON.stringify({ env: { a: "new-source-marker" } }),
      );
      await commitAll(input.dataRepo, "change pinned settings source");
      const key = "data/settings/a";
      const oldEntry = input.projectLock.items[key];
      if (oldEntry?.source !== "data") throw new Error("missing settings pin");
      if (oldEntry.needs === null || oldEntry.needs === undefined)
        throw new Error("missing settings needs snapshot");
      if (
        oldEntry.needsSourceCommit === null ||
        oldEntry.needsSourceCommit === undefined
      )
        throw new Error("missing settings needs commit");
      const pin = await pinCurrentSource(input.dataRepo, "settings", "a");
      input.projectLock.items[key] = refreshDataLockEntry(oldEntry, {
        pin,
        needs: oldEntry.needs,
        needsSourceCommit: oldEntry.needsSourceCommit,
        appliedAt: oldEntry.appliedAt,
      });
      const changedReport = await buildStatusReport(input);
      const changedInput = {
        ...input,
        rows: changedReport.rows,
        view: "installed" as const,
      };
      const changed = await collectStatusDiffs(changedInput);
      expect(changed).toEqual(await uncachedDiffs(changedInput));
      expect(
        changed.some((diff) => diff.text?.includes("new-source-marker")),
      ).toBe(true);

      plan.mockClear();
      const localLock = structuredClone(input.projectLock);
      const scopedRows = [
        ...report.rows,
        ...report.rows.map((row) => ({ ...row, scope: "local" as const })),
      ];
      const scoped = await collectStatusDiffs({
        ...input,
        localLock,
        rows: scopedRows,
        view: "installed",
      });
      expect(plan).toHaveBeenCalledTimes(2);
      expect(scoped.map((diff) => diff.item).sort()).toEqual([
        "local/data/settings/a",
        "local/data/settings/b",
        "project/data/settings/a",
        "project/data/settings/b",
      ]);
      const projectDiffs = scoped.filter((diff) =>
        diff.item.startsWith("project/"),
      );
      const localDiffs = scoped.filter((diff) =>
        diff.item.startsWith("local/"),
      );
      expect(localDiffs.map(({ item: _item, ...diff }) => diff)).toEqual(
        projectDiffs.map(({ item: _item, ...diff }) => diff),
      );
    } finally {
      plan.mockRestore();
      await rm(input.project, { recursive: true, force: true });
      await rm(input.dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "fragment collections key project and repository inputs independently",
  async () => {
    const first = await reportFixture(true, "source_one");
    const second = await reportFixture(true, "source_two");
    const fixtures = [first, second];
    try {
      await writeFile(
        join(first.project, ".claude/settings.json"),
        JSON.stringify(
          normalizeClaudeSettingsOutput({ env: { PROJECT: "one" } }),
        ),
      );
      await writeFile(
        join(second.project, ".claude/settings.json"),
        JSON.stringify(
          normalizeClaudeSettingsOutput({ env: { PROJECT: "two" } }),
        ),
      );
      await writeFile(
        join(first.project, ".codex/config.toml"),
        '[project]\nmarker = "project_one"\n',
      );
      await writeFile(
        join(second.project, ".codex/config.toml"),
        '[project]\nmarker = "project_two"\n',
      );

      const cases = [
        { ...first, expected: ["source_one", "project_one"] },
        {
          ...first,
          dataRepo: second.dataRepo,
          projectLock: second.projectLock,
          expected: ["source_two", "project_one"],
        },
        { ...second, expected: ["source_two", "project_two"] },
      ];
      for (const input of cases) {
        const report = await buildStatusReport(input);
        const diffInput = {
          ...input,
          rows: report.rows,
          view: "installed" as const,
        };
        const collected = await collectStatusDiffs(diffInput);
        expect(collected).toEqual(await uncachedDiffs(diffInput));
        const text = collected.map((diff) => diff.text ?? "").join("\n");
        for (const marker of input.expected) expect(text).toContain(marker);
        expect(collected.some((diff) => diff.item.endsWith("/mcp/both"))).toBe(
          true,
        );
        expect(
          collected.some((diff) => diff.item.endsWith("/codex-config/policy")),
        ).toBe(true);
        expect(
          collected.some((diff) => diff.path.endsWith(".codex/config.toml")),
        ).toBe(true);
      }
    } finally {
      for (const input of fixtures) {
        await rm(input.project, { recursive: true, force: true });
        await rm(input.dataRepo, { recursive: true, force: true });
      }
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "shared-output source diagnostics match uncached diffs for every field",
  async () => {
    const input = await reportFixture(true, "committed");
    try {
      await writeFile(
        join(input.dataRepo, "mcp/both/codex.toml"),
        '[mcp_servers.both]\ncommand = "dirty_mcp_marker"\n',
      );
      await writeFile(
        join(input.dataRepo, "codex/config/policy/config.toml"),
        "[features]\ndirty_config_marker = true\n",
      );
      const report = await buildStatusReport(input);
      const dirtyRows = report.rows.filter(
        (row) => row.name === "both" || row.name === "policy",
      );
      expect(dirtyRows.map((row) => row.state)).toEqual([
        "source_dirty_and_output_drift",
        "source_dirty",
      ]);
      const diffInput = {
        ...input,
        rows: dirtyRows,
        view: "all" as const,
      };
      const collected = await collectStatusDiffs(diffInput);
      expect(collected).toEqual(await uncachedDiffs(diffInput));
      expect(collected.map((diff) => diff.item).sort()).toEqual([
        "project/data/codex-config/policy",
        "project/data/mcp/both",
      ]);
      const text = collected.map((diff) => diff.text ?? "").join("\n");
      expect(text).toContain("dirty_mcp_marker");
      expect(text).toContain("dirty_config_marker");
      expect(
        collected.every(
          (diff) =>
            diff.view === "installed" &&
            diff.unavailableReason === undefined &&
            diff.from.role === "locked" &&
            diff.to.role === "installed",
        ),
      ).toBe(true);
    } finally {
      await rm(input.project, { recursive: true, force: true });
      await rm(input.dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
