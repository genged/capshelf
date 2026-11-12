import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { CommanderError } from "commander";
import { createProgram } from "../src/cli";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

async function projectWithSkills(
  names: string[],
): Promise<{ project: string; dataRepo: string }> {
  const project = await tempRepo("capshelf-excess-project-");
  const dataRepo = await tempRepo("capshelf-excess-data-");
  for (const name of names) await addSkill(dataRepo, name);
  await commitAll(dataRepo, "skills");
  const run = runInProcess(project);
  expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
  return { project, dataRepo };
}

function lockText(project: string): Promise<string> {
  return readFile(join(project, ".capshelf", "capshelf.lock.json"), "utf-8");
}

interface CommandPath {
  path: string[];
  command: Command;
}

function walk(command: Command, prefix: string[] = []): CommandPath[] {
  return command.commands.flatMap((child) => {
    const path = [...prefix, child.name()];
    return [{ path, command: child }, ...walk(child, path)];
  });
}

describe("excess positional arguments", () => {
  test(
    "rm refuses a second item and removes neither",
    async () => {
      const { project } = await projectWithSkills(["foo", "bar"]);
      const run = runInProcess(project);
      expect((await run(["add", "skills/foo"])).exitCode).toBe(0);
      expect((await run(["add", "skills/bar"])).exitCode).toBe(0);
      const lockBefore = await lockText(project);

      const result = await run(["rm", "skills/foo", "skills/bar", "--yes"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("too many arguments");
      expect(existsSync(join(project, ".agents", "skills", "foo"))).toBe(true);
      expect(existsSync(join(project, ".agents", "skills", "bar"))).toBe(true);
      expect(await lockText(project)).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "add refuses a second ref and installs nothing",
    async () => {
      const { project } = await projectWithSkills(["foo"]);
      const run = runInProcess(project);
      const lockBefore = await lockText(project);

      const result = await run([
        "add",
        "skills/foo",
        "skills/nonexistent-typo",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("too many arguments");
      expect(existsSync(join(project, ".agents", "skills", "foo"))).toBe(false);
      expect(await lockText(project)).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("a nested subcommand with fixed arity refuses an extra positional", async () => {
    const project = await tempDir("capshelf-excess-nested-");
    const run = runInProcess(project);

    for (const args of [
      ["data", "bind", "one", "two"],
      ["marketplace", "show", "one", "two"],
      ["marketplace", "plugin", "delete", "--target", "claude", "one", "two"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("too many arguments");
    }
  });

  test(
    "a variadic command still accepts two items",
    async () => {
      const { project } = await projectWithSkills(["foo", "bar"]);
      const run = runInProcess(project);
      expect((await run(["add", "skills/foo"])).exitCode).toBe(0);
      expect((await run(["add", "skills/bar"])).exitCode).toBe(0);

      const result = await run([
        "update",
        "skills/foo",
        "skills/bar",
        "--dry-run",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain("too many arguments");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("the root and every command in the tree set allowExcessArguments(false)", () => {
    const program = createProgram();
    const all = [{ path: ["(root)"], command: program }, ...walk(program)];
    // Commander 12.1.0 has a setter, allowExcessArguments(), and no getter.
    // The only way to see the value on a variadic command, which never
    // reaches the argument-count check, is the private field. If Commander
    // renames the field, the value is undefined and this test fails.
    const unset = all
      .filter(({ command }) => {
        // Commander 12.1.0 sets `_allowExcessArguments` in the Command
        // constructor (node_modules/commander/lib/command.js:28). The `in`
        // test narrows the type without an assertion.
        return !(
          "_allowExcessArguments" in command &&
          command._allowExcessArguments === false
        );
      })
      .map(({ path }) => path.join(" "));
    expect(unset).toEqual([]);
    expect(
      all.some(({ command }) =>
        command.registeredArguments.some((arg) => arg.variadic),
      ),
    ).toBe(true);
  });

  test(
    "every fixed-arity command in the tree refuses an extra positional",
    async () => {
      const commands = walk(createProgram());
      // Guard against a walk that silently sees nothing.
      const names = commands.map((entry) => entry.path.join(" "));
      expect(names).toContain("rm");
      expect(names).toContain("data bind");
      expect(names).toContain("marketplace plugin create");

      const cwd = await tempDir("capshelf-excess-walk-");
      const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
        () => true,
      );
      const previousCwd = process.cwd();
      const failures: string[] = [];
      try {
        process.chdir(cwd);
        for (const { path, command } of commands) {
          if (command.registeredArguments.some((arg) => arg.variadic)) continue;
          // Commander checks required options before the argument count.
          const required = command.options
            .filter((option) => option.mandatory)
            .flatMap((option) => [
              option.long ?? "",
              option.long === "--target"
                ? "claude"
                : option.long === "--to"
                  ? "local"
                  : "x",
            ]);
          const extra = Array.from(
            { length: command.registeredArguments.length + 1 },
            (_, index) => `x${index}`,
          );
          // A fresh tree per probe: Commander retains parsed state.
          try {
            await createProgram().parseAsync([
              process.execPath,
              "capshelf",
              ...path,
              ...required,
              ...extra,
            ]);
            failures.push(`${path.join(" ")}: accepted an extra argument`);
          } catch (err) {
            // A group command has no arguments of its own: its extra word is
            // read as an unknown subcommand, which is also a refusal.
            const expected =
              command.commands.length > 0
                ? ["commander.excessArguments", "commander.unknownCommand"]
                : ["commander.excessArguments"];
            if (
              !(err instanceof CommanderError) ||
              !expected.includes(err.code)
            ) {
              failures.push(
                `${path.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } finally {
        process.chdir(previousCwd);
        stderrSpy.mockRestore();
      }

      expect(failures).toEqual([]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
