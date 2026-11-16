import { describe, expect, test } from "bun:test";
import { parseLock } from "../src/lock";
import { parseJsonc } from "../src/json-fragments";
import { isConfigObject } from "../src/config-values";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
  objectField,
  readJsonObject,
} from "./cli-fixtures";

const ABSENT_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function lockFile(project: string): string {
  return join(project, ".capshelf", "capshelf.lock.json");
}

async function breakSourceCommit(
  project: string,
  key: string,
  commit = ABSENT_COMMIT,
): Promise<void> {
  const path = lockFile(project);
  const lock = await readJsonObject(path);
  const entry = objectField(lock, "items")[key];
  if (!isConfigObject(entry)) {
    throw new Error(`test fixture has no lock entry ${key}`);
  }
  entry.sourceCommit = commit;
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

describe("PIN-8 unprovable pin repair", () => {
  test(
    "update repairs an unresolvable copy-item pin; apply and revert refuse it",
    async () => {
      const project = await tempRepo("capshelf-pin-repair-project-");
      const dataRepo = await tempRepo("capshelf-pin-repair-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "v1\n");
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      await breakSourceCommit(project, "data/skills/hello");

      const applied = await run(["apply", "skills/hello"]);
      expect(applied.exitCode).toBe(1);
      const applyText = applied.stdout.toString();
      expect(applyText).toContain("the locked source cannot supply a verified");
      expect(applyText).toContain("capshelf update skills/hello");
      expect(
        await readFile(
          join(project, ".agents", "skills", "hello", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("v1\n");

      const reverted = await run(["revert", "skills/hello", "--json"]);
      expect(reverted.exitCode).not.toBe(0);
      expect(reverted.stderr.toString()).toContain("capshelf update");

      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "v2\n");
      await commitAll(dataRepo, "hello v2");

      const updated = await run(["update", "skills/hello", "--yes"]);
      expect(updated.exitCode).toBe(0);
      expect(
        await readFile(
          join(project, ".agents", "skills", "hello", "SKILL.md"),
          "utf-8",
        ),
      ).toBe("v2\n");

      const lock = parseLock(
        parseJsonc(await readFile(lockFile(project), "utf-8")),
      );
      const entry = lock.items["data/skills/hello"];
      if (entry?.source !== "data") throw new Error("expected a data entry");
      expect(entry.sourceCommit).not.toBe(ABSENT_COMMIT);

      const after = await run(["apply", "skills/hello"]);
      expect(after.exitCode).toBe(0);
      expect(after.stdout.toString()).toContain("already-current");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one unprovable pin no longer aborts a whole-project update",
    async () => {
      const project = await tempRepo("capshelf-pin-sweep-project-");
      const dataRepo = await tempRepo("capshelf-pin-sweep-data-");
      const run = runInProcess(project);
      for (const name of ["alpha", "beta", "gamma"]) {
        await addSkill(dataRepo, name, "v1\n");
      }
      await commitAll(dataRepo, "skills v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      for (const name of ["alpha", "beta", "gamma"]) {
        expect((await run(["add", `skills/${name}`])).exitCode).toBe(0);
      }

      await breakSourceCommit(project, "data/skills/beta");
      for (const name of ["alpha", "beta", "gamma"]) {
        await writeFile(join(dataRepo, "skills", name, "SKILL.md"), "v2\n");
      }
      await commitAll(dataRepo, "skills v2");

      const updated = await run(["update", "--yes"]);
      expect(updated.exitCode).toBe(0);
      for (const name of ["alpha", "beta", "gamma"]) {
        expect(
          await readFile(
            join(project, ".agents", "skills", name, "SKILL.md"),
            "utf-8",
          ),
        ).toBe("v2\n");
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a target-side error reports one row and still writes the healthy items",
    async () => {
      const project = await tempRepo("capshelf-pin-partial-project-");
      const dataRepo = await tempRepo("capshelf-pin-partial-data-");
      const run = runInProcess(project);
      for (const name of ["alpha", "beta", "gamma"]) {
        await addSkill(dataRepo, name, "v1\n");
      }
      await commitAll(dataRepo, "skills v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      for (const name of ["alpha", "beta", "gamma"]) {
        expect((await run(["add", `skills/${name}`])).exitCode).toBe(0);
      }

      await Bun.$`git -C ${dataRepo} rm -r -q skills/beta`.quiet();
      await commitAll(dataRepo, "drop beta");
      for (const name of ["alpha", "gamma"]) {
        await writeFile(join(dataRepo, "skills", name, "SKILL.md"), "v2\n");
      }
      await commitAll(dataRepo, "skills v2");

      const updated = await run(["update", "--yes"]);
      expect(updated.exitCode).toBe(1);
      for (const name of ["alpha", "gamma"]) {
        expect(
          await readFile(
            join(project, ".agents", "skills", name, "SKILL.md"),
            "utf-8",
          ),
        ).toBe("v2\n");
      }
      expect(updated.stdout.toString()).toContain("skills/beta");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "repairing an unprovable pin still reaches the consent boundary",
    async () => {
      const project = await tempRepo("capshelf-pin-consent-project-");
      const dataRepo = await tempRepo("capshelf-pin-consent-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "v1\n");
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
      await writeFile(installed, "local edit\n");
      await breakSourceCommit(project, "data/skills/hello");
      await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "v2\n");
      await commitAll(dataRepo, "hello v2");

      // An unprovable pin can't be classified against the previous commit, but
      // the loss is real and must still prompt rather than surface as a
      // planning error.
      const refused = await run(["update", "skills/hello"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        "Update would destroy local state",
      );
      expect(await readFile(installed, "utf-8")).toBe("local edit\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an unresolvable fragment pin is refused with rm + add guidance",
    async () => {
      const project = await tempRepo("capshelf-pin-fragment-project-");
      const dataRepo = await tempRepo("capshelf-pin-fragment-data-");
      const run = runInProcess(project);
      await Bun.$`mkdir -p ${join(dataRepo, "settings", "base")}`.quiet();
      await writeFile(
        join(dataRepo, "settings", "base", "settings.json"),
        `${JSON.stringify({ env: { A: "1" } }, null, 2)}\n`,
      );
      await commitAll(dataRepo, "settings base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "settings/base"])).exitCode).toBe(0);

      await breakSourceCommit(project, "data/settings/base");

      const updated = await run(["update", "settings/base"]);
      expect(updated.exitCode).toBe(3);
      const text = updated.stdout.toString();
      expect(text).toContain("cannot be resolved");
      expect(text).toContain("capshelf rm settings/base");
      expect(text).toContain("capshelf add settings/base");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
