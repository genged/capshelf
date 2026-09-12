import { expect, spyOn, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../src/git";
import { installDataItem } from "../src/commands/add";
import { GitReadMemo } from "../src/git-read-memo";
import { loadManifest } from "../src/manifest";
import { loadLock, loadLocalLock } from "../src/lock";
import { loadLocalConfig } from "../src/local-config";
import { findMasterItemByRef } from "../src/item-ref";
import { setPickContext } from "../src/pick";
import * as fsUtils from "../src/fs-utils";
import * as materialization from "../src/materialize";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  jsonOutput,
  objectItems,
  readJsonObject,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

async function fragmentProject() {
  const dataRepo = await tempRepo("capshelf-writer-memo-data-");
  const project = await tempRepo("capshelf-writer-memo-project-");
  const run = runInProcess(project);
  for (const name of ["first", "second"]) {
    await mkdir(join(dataRepo, "settings", name), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", name, "settings.json"),
      JSON.stringify({ permissions: { deny: [`Bash(${name} *)`] } }),
    );
    await commitAll(dataRepo, name);
  }
  expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
  for (const name of ["first", "second"])
    expect((await run(["add", `settings/${name}`])).exitCode).toBe(0);
  const output = join(project, ".claude", "settings.json");
  const current = await readJsonObject(output);
  await writeFile(output, JSON.stringify({ ...current, model: "local-model" }));
  return {
    dataRepo,
    project,
    run,
    output,
    guarded: [
      join(project, ".capshelf", "capshelf.json"),
      join(project, ".capshelf", "capshelf.lock.json"),
      output,
    ],
  };
}

async function removeProject(
  fixture: Awaited<ReturnType<typeof fragmentProject>>,
) {
  await rm(fixture.project, { recursive: true, force: true });
  await rm(fixture.dataRepo, { recursive: true, force: true });
}

function immutableTreeOrBlobRequest(
  repo: string,
  args: string[],
  stdin: string | Uint8Array | undefined,
): string | null {
  const fullObject = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (args[0] === "ls-tree") {
    const object = args[args.indexOf("--") - 1];
    if (object === undefined || !fullObject.test(object)) return null;
  } else if (args[0] === "cat-file" && args[1] === "--batch") {
    if (stdin === undefined) return null;
    const input =
      stdin instanceof Uint8Array
        ? Buffer.from(stdin).toString("utf-8")
        : stdin;
    const objects = input.trimEnd().split("\n");
    if (objects.length === 0 || !objects.every((id) => fullObject.test(id)))
      return null;
  } else return null;
  return JSON.stringify([repo, args, stdin ?? null]);
}

for (const scenario of ["apply", "update", "changed update"] as const) {
  test(
    `${scenario} shares immutable CLI reads and starts fresh on the next command`,
    async () => {
      const fixture = await fragmentProject();
      const verb = scenario === "apply" ? "apply" : "update";
      try {
        if (scenario === "changed update") {
          await writeFile(
            join(fixture.dataRepo, "settings", "second", "settings.json"),
            '{"permissions":{"deny":["Bash(new-second *)"]}}',
          );
          await commitAll(fixture.dataRepo, "new second contribution");
        }
        const counts = new Map<string, number>();
        const sourceRead = git.sourceRead;
        const read = spyOn(git, "sourceRead").mockImplementation(
          async (repo, args, options) => {
            const result = await sourceRead(repo, args, options);
            const key = immutableTreeOrBlobRequest(repo, args, options?.stdin);
            if (result.exitCode === 0 && key !== null)
              counts.set(key, (counts.get(key) ?? 0) + 1);
            return result;
          },
        );
        try {
          let firstRequests: string[] = [];
          let firstBytes: Buffer<ArrayBuffer>[] = [];
          for (const invocation of [1, 2]) {
            read.mockClear();
            counts.clear();
            const result = await fixture.run([verb, "--json"]);
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(counts.size, `invocation ${invocation}`).toBeGreaterThan(0);
            expect(
              [...counts].filter(([, count]) => count !== 1),
              `repeated immutable requests in invocation ${invocation}`,
            ).toEqual([]);
            expect((await readJsonObject(fixture.output)).model).toBe(
              "local-model",
            );
            const requests = [...counts.keys()].sort();
            const bytes = await Promise.all(
              fixture.guarded.map((path) => readFile(path)),
            );
            if (invocation === 1) {
              firstRequests = requests;
              firstBytes = bytes;
            } else {
              if (scenario !== "changed update")
                expect(requests).toEqual(firstRequests);
              expect(bytes).toEqual(firstBytes);
              expect(
                objectItems(jsonOutput(result), "items").every(
                  (row) => row.action === "already-current",
                ),
              ).toBe(true);
            }
          }
        } finally {
          read.mockRestore();
        }
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

for (const verb of ["apply", "update"] as const) {
  test(
    `${verb} refuses a blob removed after a successful command`,
    async () => {
      const fixture = await fragmentProject();
      try {
        expect((await fixture.run([verb, "--json"])).exitCode).toBe(0);
        const source = "settings/first/settings.json";
        const commit = await git.headSha(fixture.dataRepo);
        const blob = (
          await git.sourceReadText(fixture.dataRepo, [
            "rev-parse",
            `${commit}:${source}`,
          ])
        ).trim();
        const before = await Promise.all(
          fixture.guarded.map((path) => readFile(path)),
        );
        await rm(
          join(
            fixture.dataRepo,
            ".git",
            "objects",
            blob.slice(0, 2),
            blob.slice(2),
          ),
        );
        const result = await fixture.run([verb, "--json"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.toString() + result.stderr.toString()).toContain(
          source,
        );
        expect(
          await Promise.all(fixture.guarded.map((path) => readFile(path))),
        ).toEqual(before);
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    `${verb} refuses an output edit made during confirmation`,
    async () => {
      const fixture = await fragmentProject();
      let prompts = 0;
      const duringPrompt = '{"model":"edited-during-prompt"}\n';
      const previous = setDestructiveConfirmationContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async () => {
          prompts++;
          await writeFile(fixture.output, duringPrompt);
          return "y";
        },
        stderr: { write: () => true },
      });
      try {
        await writeFile(fixture.output, '{"model":"local-model"}\n');
        const metadata = await Promise.all(
          fixture.guarded.slice(0, 2).map((path) => readFile(path)),
        );
        const result = await fixture.run([verb]);
        expect(prompts).toBe(1);
        expect(result.exitCode).toBe(3);
        expect(result.stderr.toString()).toContain(
          "changed after destructive-change preflight",
        );
        expect(await readFile(fixture.output, "utf-8")).toBe(duringPrompt);
        expect(
          await Promise.all(
            fixture.guarded.slice(0, 2).map((path) => readFile(path)),
          ),
        ).toEqual(metadata);
      } finally {
        setDestructiveConfirmationContext(previous);
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    `${verb} restores published materialization damage and preserves local settings`,
    async () => {
      const fixture = await fragmentProject();
      try {
        await addSkill(fixture.dataRepo, "damaged", "locked skill\n");
        await commitAll(fixture.dataRepo, "skill");
        expect((await fixture.run(["add", "skills/damaged"])).exitCode).toBe(0);
        const installed = join(
          fixture.project,
          ".agents",
          "skills",
          "damaged",
          "SKILL.md",
        );
        await writeFile(installed, "local skill\n");
        if (verb === "update") {
          await addSkill(fixture.dataRepo, "damaged", "upstream skill\n");
          await commitAll(fixture.dataRepo, "upstream skill");
        }
        const paths = [...fixture.guarded, installed];
        const before = await Promise.all(paths.map((path) => readFile(path)));
        const materialize = materialization.materializeLockEntry;
        let damaged = false;
        const writer = spyOn(
          materialization,
          "materializeLockEntry",
        ).mockImplementation(async (options) =>
          materialize({
            ...options,
            ...(!options.dryRun &&
              options.key === "data/skills/damaged" && {
                hooks: {
                  afterPublish: async () => {
                    damaged = true;
                    await writeFile(installed, "corrupted publication\n");
                  },
                },
              }),
          }),
        );
        try {
          const result = await fixture.run([verb, "--yes", "--json"]);
          expect(damaged).toBe(true);
          expect(result.exitCode).toBe(1);
          expect(result.stdout.toString()).toContain(
            "does not match the staged regular-file tree",
          );
          expect(
            await Promise.all(paths.map((path) => readFile(path))),
          ).toEqual(before);
        } finally {
          writer.mockRestore();
        }
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    `${verb} rolls back an earlier fragment publication when the next output write fails`,
    async () => {
      const fixture = await fragmentProject();
      try {
        const source = join(fixture.dataRepo, "mcp", "tool", "claude.json");
        await mkdir(join(fixture.dataRepo, "mcp", "tool"), { recursive: true });
        await writeFile(source, '{"mcpServers":{"tool":{"command":"tool"}}}');
        await commitAll(fixture.dataRepo, "MCP source");
        expect((await fixture.run(["add", "mcp/tool"])).exitCode).toBe(0);
        const mcp = join(fixture.project, ".mcp.json");
        await writeFile(fixture.output, '{"model":"local-model"}\n');
        await writeFile(
          mcp,
          '{"mcpServers":{"local":{"command":"local-tool"}}}\n',
        );
        if (verb === "update") {
          await writeFile(
            source,
            '{"mcpServers":{"tool":{"command":"updated-tool"}}}',
          );
          await commitAll(fixture.dataRepo, "updated MCP source");
        }
        const paths = [...fixture.guarded, mcp];
        const before = await Promise.all(paths.map((path) => readFile(path)));
        const atomicWrite = fsUtils.atomicWriteFile;
        const published: string[] = [];
        let injected = false;
        let firstPublishedText: Buffer | undefined;
        const writer = spyOn(fsUtils, "atomicWriteFile").mockImplementation(
          async (path, bytes) => {
            if (!injected && (path === fixture.output || path === mcp)) {
              if (published.length === 1) {
                firstPublishedText = await readFile(published[0]!);
                injected = true;
                throw new Error("injected second fragment write failure");
              }
              await atomicWrite(path, bytes);
              published.push(path);
              return;
            }
            await atomicWrite(path, bytes);
          },
        );
        try {
          const result = await fixture.run([verb, "--yes", "--json"]);
          expect(injected).toBe(true);
          expect(published).toHaveLength(1);
          expect(firstPublishedText).not.toEqual(
            before[paths.indexOf(published[0]!)],
          );
          expect(result.exitCode).toBe(1);
          expect(result.stdout.toString()).toContain(
            "injected second fragment write failure",
          );
          expect(
            await Promise.all(paths.map((path) => readFile(path))),
          ).toEqual(before);
        } finally {
          writer.mockRestore();
        }
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

test(
  "update refuses a new HEAD selected during confirmation",
  async () => {
    const fixture = await fragmentProject();
    let prompts = 0;
    const previous = setDestructiveConfirmationContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async () => {
        prompts++;
        await writeFile(
          join(fixture.dataRepo, "settings", "first", "settings.json"),
          '{"permissions":{"deny":["Bash(new-first *)"]}}',
        );
        await commitAll(fixture.dataRepo, "changed during confirmation");
        return "y";
      },
      stderr: { write: () => true },
    });
    try {
      await writeFile(fixture.output, '{"model":"local-model"}\n');
      const before = await Promise.all(
        fixture.guarded.map((path) => readFile(path)),
      );
      const result = await fixture.run(["update"]);
      expect(prompts).toBe(1);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(
        "changed after destructive-change preflight",
      );
      expect(
        await Promise.all(fixture.guarded.map((path) => readFile(path))),
      ).toEqual(before);
    } finally {
      setDestructiveConfirmationContext(previous);
      await removeProject(fixture);
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

async function addFragmentSources(dataRepo: string) {
  for (const name of ["third", "fourth", "fifth"]) {
    await mkdir(join(dataRepo, "settings", name), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", name, "settings.json"),
      JSON.stringify({ permissions: { deny: [`Bash(${name} *)`] } }),
    );
    await commitAll(dataRepo, name);
  }
}

for (const route of ["standalone", "bundle", "interactive"] as const) {
  test(
    `fragment add ${route} shares successful immutable reads across its invocation`,
    async () => {
      const fixture = await fragmentProject();
      try {
        await addFragmentSources(fixture.dataRepo);
        await mkdir(join(fixture.dataRepo, "bundles"), { recursive: true });
        await writeFile(
          join(fixture.dataRepo, "bundles", "extra.yml"),
          "includes:\n  settings: [third, fourth]\n",
        );
        const counts = new Map<string, number>();
        const sourceRead = git.sourceRead;
        const read = spyOn(git, "sourceRead").mockImplementation(
          async (repo, args, options) => {
            const result = await sourceRead(repo, args, options);
            const key = immutableTreeOrBlobRequest(repo, args, options?.stdin);
            if (result.exitCode === 0 && key !== null)
              counts.set(key, (counts.get(key) ?? 0) + 1);
            return result;
          },
        );
        const previousPick = setPickContext({
          stdinIsTTY: true,
          stderrIsTTY: true,
          prompt: async () => ({
            kind: "picked",
            refs: ["bundles/extra", "settings/fourth", "settings/fifth"],
          }),
        });
        try {
          const args =
            route === "standalone"
              ? ["add", "settings/third", "--json"]
              : route === "bundle"
                ? ["add", "bundles/extra", "--json"]
                : ["add"];
          const result = await fixture.run(args);
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          const names =
            route === "standalone"
              ? ["first", "second", "third"]
              : route === "bundle"
                ? ["first", "second", "third", "fourth"]
                : ["first", "second", "third", "fourth", "fifth"];
          expect(await readJsonObject(fixture.output)).toMatchObject({
            model: "local-model",
            permissions: { deny: names.map((name) => `Bash(${name} *)`) },
          });
          expect((await loadManifest(fixture.project)).settings).toEqual(names);
          const lock = await loadLock(fixture.project);
          for (const name of names)
            expect(lock.items[`data/settings/${name}`]?.source).toBe("data");
          if (route === "interactive")
            expect(result.stdout.toString()).toContain("already installed");
          expect(counts.size).toBeGreaterThan(0);
          expect(
            [...counts].filter(([, count]) => count !== 1),
            `repeated immutable requests through ${route}`,
          ).toEqual([]);
        } finally {
          setPickContext(previousPick);
          read.mockRestore();
        }
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

for (const route of ["command", "exported install"] as const) {
  test(
    `fragment add ${route} refuses a removed contributor on its next invocation`,
    async () => {
      const fixture = await fragmentProject();
      try {
        await addFragmentSources(fixture.dataRepo);
        const ctx = {
          project: fixture.project,
          dataRepo: fixture.dataRepo,
          manifest: await loadManifest(fixture.project),
          projectLock: await loadLock(fixture.project),
          localLock: await loadLocalLock(fixture.project),
          localConfig: await loadLocalConfig(fixture.project),
          local: false,
          memo: new GitReadMemo(),
        };
        const third = await findMasterItemByRef(fixture.dataRepo, {
          kind: "settings",
          name: "third",
        });
        const fourth = await findMasterItemByRef(fixture.dataRepo, {
          kind: "settings",
          name: "fourth",
        });
        if (!third || !fourth) throw new Error("missing fixture fragments");
        if (route === "command") {
          expect(
            (await fixture.run(["add", "settings/third", "--json"])).exitCode,
          ).toBe(0);
        } else {
          await installDataItem(ctx, third);
        }
        const source = "settings/first/settings.json";
        const commit = await git.headSha(fixture.dataRepo);
        const blob = (
          await git.sourceReadText(fixture.dataRepo, [
            "rev-parse",
            `${commit}:${source}`,
          ])
        ).trim();
        const before = await Promise.all(
          fixture.guarded.map((path) => readFile(path)),
        );
        await rm(
          join(
            fixture.dataRepo,
            ".git",
            "objects",
            blob.slice(0, 2),
            blob.slice(2),
          ),
        );
        if (route === "command") {
          const result = await fixture.run([
            "add",
            "settings/fourth",
            "--json",
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.toString() + result.stderr.toString()).toContain(
            source,
          );
        } else {
          await expect(installDataItem(ctx, fourth)).rejects.toThrow(source);
        }
        expect(
          await Promise.all(fixture.guarded.map((path) => readFile(path))),
        ).toEqual(before);
      } finally {
        await removeProject(fixture);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}
