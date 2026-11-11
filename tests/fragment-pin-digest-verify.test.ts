import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectItems,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";
import { manifestPath } from "../src/paths";

/**
 * `apply` and `revert` must refuse a fragment whose locked commit resolves but
 * whose tree does not match the lock, the same way they refuse a skill.
 */

const LOCK = join(".capshelf", "capshelf.lock.json");
const KEY = "data/settings/demo";

async function fragmentProject(prefix: string): Promise<{
  project: string;
  run: ReturnType<typeof runInProcess>;
  output: string;
  lockPath: string;
}> {
  const project = await tempRepo(`${prefix}-project-`);
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const run = runInProcess(project);
  await mkdir(join(dataRepo, "settings", "demo"), { recursive: true });
  await writeFile(
    join(dataRepo, "settings", "demo", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2)}\n`,
  );
  await commitAll(dataRepo, "settings demo");
  expect(
    (await run(["init", "--data", dataRepo, "--no-upstream", "--no-pick"]))
      .exitCode,
  ).toBe(0);
  expect((await run(["add", "settings/demo"])).exitCode).toBe(0);
  return {
    project,
    run,
    output: join(project, ".claude", "settings.json"),
    lockPath: join(project, LOCK),
  };
}

type Break = "v4" | "v3";

async function breakPin(lockPath: string, mode: Break): Promise<void> {
  const lock = await file(lockPath).json();
  const entry = lock.items[KEY];
  if (mode === "v4") {
    entry.sourcePinDigest = "0".repeat(64);
  } else {
    delete entry.sourcePinDigest;
    entry.sha = "0".repeat(12);
    lock.version = 3;
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

describe.each([
  "v4",
  "v3",
] as const)("fragment apply and revert verify the locked pin (%s)", (mode) => {
  // `revert` writes the lock, so it refuses a version 3 lock before it
  // reads any fragment. Only `apply` reaches the legacy hash path.
  const verbs =
    mode === "v3" ? (["apply"] as const) : (["apply", "revert"] as const);
  for (const verb of verbs) {
    test(
      `${verb} refuses a contradictory pin and writes nothing`,
      async () => {
        const { project, run, output, lockPath } = await fragmentProject(
          `capshelf-fragment-pin-${verb}-${mode}`,
        );
        await breakPin(lockPath, mode);
        await rm(output);
        const lockBefore = await readFile(lockPath);
        const metaBefore = await readFile(manifestPath(project));

        const result = await run([verb, "settings/demo", "--json"]);
        expect(result.exitCode).not.toBe(0);
        // `apply` reports the refusal as an item row. `revert` fails the
        // command, so its message is the error on stderr.
        const text =
          verb === "apply"
            ? String(objectItems(jsonOutput(result), "items")[0]!.error)
            : result.stderr.toString();
        expect(text).toContain("settings/demo");
        expect(text).toContain("but lock expects");
        expect(text).toContain("capshelf update settings/demo");
        expect(existsSync(output)).toBe(false);
        expect(await readFile(lockPath)).toEqual(lockBefore);
        expect(await readFile(manifestPath(project))).toEqual(metaBefore);
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }

  // `update` writes the lock, so a version 3 lock needs `lock migrate` first.
  test.skipIf(mode === "v3")(
    "update repairs the contradictory pin",
    async () => {
      const { run, output, lockPath } = await fragmentProject(
        `capshelf-fragment-pin-update-${mode}`,
      );
      await breakPin(lockPath, mode);
      await rm(output);
      const updated = await run(["update", "settings/demo", "--yes"]);
      expect(updated.exitCode).toBe(0);
      const lock = await file(lockPath).json();
      expect(lock.items[KEY].sourcePinDigest).not.toBe("0".repeat(64));
      const applied = await run(["apply", "settings/demo", "--json"]);
      expect(applied.exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("fragment apply and revert with a correct pin", () => {
  for (const verb of ["apply", "revert"] as const) {
    test(
      `${verb} reconciles and exits 0`,
      async () => {
        const { run, output } = await fragmentProject(
          `capshelf-fragment-pin-ok-${verb}`,
        );
        await rm(output);
        const result = await run([verb, "settings/demo", "--json"]);
        expect(result.exitCode).toBe(0);
        expect(existsSync(output)).toBe(true);
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }
});

// A shared output holds the bytes of every contributing item. A bad pin on a
// contributor that the command did not name must still refuse the write.
describe("fragment apply and revert verify every contributor of a shared output", () => {
  async function twoItemProject(prefix: string) {
    const project = await tempRepo(`${prefix}-project-`);
    const dataRepo = await tempRepo(`${prefix}-data-`);
    const run = runInProcess(project);
    for (const [name, rule] of [
      ["a", "Bash(ls)"],
      ["b", "Bash(pwd)"],
    ] as const) {
      await mkdir(join(dataRepo, "settings", name), { recursive: true });
      await writeFile(
        join(dataRepo, "settings", name, "settings.json"),
        `${JSON.stringify({ permissions: { allow: [rule] } }, null, 2)}\n`,
      );
    }
    await commitAll(dataRepo, "settings a and b");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream", "--no-pick"]))
        .exitCode,
    ).toBe(0);
    expect((await run(["add", "settings/a"])).exitCode).toBe(0);
    expect((await run(["add", "settings/b"])).exitCode).toBe(0);
    return {
      project,
      run,
      output: join(project, ".claude", "settings.json"),
      lockPath: join(project, LOCK),
    };
  }

  const cases = [
    ["apply", ["apply", "settings/a", "--json"]],
    ["apply (unnamed)", ["apply", "--json"]],
    ["revert", ["revert", "settings/a", "--json"]],
  ] as const;
  for (const [label, argv] of cases) {
    test(
      `${label} refuses when another contributor has a contradictory pin`,
      async () => {
        const { project, run, output, lockPath } = await twoItemProject(
          `capshelf-fragment-pin-shared-${label.replace(/\W+/g, "-")}`,
        );
        const lock = await file(lockPath).json();
        lock.items["data/settings/b"].sourcePinDigest = "0".repeat(64);
        await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        await rm(output);
        const lockBefore = await readFile(lockPath);
        const metaBefore = await readFile(manifestPath(project));

        const result = await run([...argv]);
        expect(result.exitCode).not.toBe(0);
        const text = `${result.stdout.toString()}${result.stderr.toString()}`;
        expect(text).toContain("settings/b");
        expect(text).toContain("but lock expects");
        expect(text).toContain("capshelf update settings/b");
        expect(existsSync(output)).toBe(false);
        expect(await readFile(lockPath)).toEqual(lockBefore);
        expect(await readFile(manifestPath(project))).toEqual(metaBefore);
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }
});
