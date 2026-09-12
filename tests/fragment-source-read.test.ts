import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadFragmentSourcesAtCommit,
  shaOfFragmentItem,
  shaOfFragmentItemAtCommit,
} from "../src/fragments";
import { headSha, sourceReadText } from "../src/git";
import {
  commitAll,
  runInProcess,
  tempRepo,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
} from "./cli-fixtures";

for (const verb of ["apply", "update"] as const) {
  test(
    `${verb} refuses an unreadable pinned blob without writing`,
    async () => {
      const dataRepo = await tempRepo("capshelf-corrupt-data-");
      const project = await tempRepo("capshelf-corrupt-project-");
      try {
        const source = "settings/base/settings.json";
        await mkdir(join(dataRepo, "settings/base"), { recursive: true });
        await writeFile(join(dataRepo, source), '{"env":{"BASE":"1"}}\n');
        await commitAll(dataRepo, "source");
        const commit = await headSha(dataRepo);
        const run = runInProcess(project);
        expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
        expect((await run(["add", "settings/base"])).exitCode).toBe(0);
        const paths = [
          ".capshelf/capshelf.json",
          ".capshelf/capshelf.lock.json",
          ".claude/settings.json",
        ];
        const before = await Promise.all(
          paths.map((path) => readFile(join(project, path))),
        );
        const id = (
          await sourceReadText(dataRepo, ["rev-parse", `${commit}:${source}`])
        ).trim();
        await rm(join(dataRepo, ".git/objects", id.slice(0, 2), id.slice(2)));
        const result = await run([verb, "settings/base", "--json"]);
        expect(result.exitCode).not.toBe(0);
        const diagnostic = result.stdout.toString() + result.stderr.toString();
        expect(diagnostic).toContain(source);
        expect(diagnostic).toContain(commit);
        expect(diagnostic).not.toContain('"action": "already-current"');
        expect(diagnostic).not.toContain("remove and re-add");
        if (verb === "update")
          expect(diagnostic).toContain("restore its Git objects");
        const status = await run(["status", "settings/base", "--json"]);
        expect(status.exitCode).not.toBe(0);
        expect(status.stdout.toString()).not.toContain('"state": "ok"');
        expect(
          await Promise.all(paths.map((path) => readFile(join(project, path)))),
        ).toEqual(before);
      } finally {
        await rm(dataRepo, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
}

test(
  "committed fragment hashes preserve whitespace, comments, and key order",
  async () => {
    const dataRepo = await tempRepo("capshelf-raw-fragment-");
    try {
      const path = "settings/base/settings.json";
      await mkdir(join(dataRepo, "settings/base"), { recursive: true });
      const hashes = new Set<string>();
      for (const raw of [
        '{"env":{"A":"1","B":"2"}}\n',
        '{\n // source comment\n "env": { "B": "2", "A": "1" }\n}\n',
      ]) {
        await writeFile(join(dataRepo, path), raw);
        await commitAll(dataRepo, "source bytes");
        const commit = await headSha(dataRepo);
        const loaded = await loadFragmentSourcesAtCommit({
          dataRepo,
          kind: "settings",
          name: "base",
          commit,
        });
        expect(loaded.rawByRelPath.get(path)).toEqual(Buffer.from(raw));
        const committed = await shaOfFragmentItemAtCommit(
          dataRepo,
          "settings",
          "base",
          commit,
        );
        expect(committed).toBe(
          await shaOfFragmentItem(dataRepo, "settings", "base"),
        );
        hashes.add(committed);
      }
      expect(hashes.size).toBe(2);
      await writeFile(join(dataRepo, path), '{"env":');
      await commitAll(dataRepo, "invalid source");
      const commit = await headSha(dataRepo);
      await expect(
        loadFragmentSourcesAtCommit({
          dataRepo,
          kind: "settings",
          name: "base",
          commit,
        }),
      ).rejects.toThrow(`cannot parse ${path} at ${commit}`);
    } finally {
      await rm(dataRepo, { recursive: true, force: true });
    }
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
