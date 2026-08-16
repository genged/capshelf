import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, runInProcess, tempRepo } from "./cli-fixtures";

/**
 * Lock version 4 replaced the identity a data entry records: `sha`, a content
 * hash of the working tree, became `sourcePinDigest`, a digest over the
 * committed Git tree. `entryIdentity` (`src/lock.ts`) reads either. The
 * reconciliation code moved onto it; several *display* paths did not, and read
 * `entry.sha` directly.
 *
 * That fails two ways, neither of them loudly:
 *   - in a template literal, a missing field renders the text "undefined";
 *   - in an object, `JSON.stringify` drops the key entirely, so a script sees
 *     no field at all rather than an error.
 *
 * It stayed hidden because the populations that still carry `sha` are exactly
 * the ones tests reach for: system items, and unmigrated v2/v3 locks.
 */
describe("lock v4 identity reaches every display path", () => {
  interface Fixture {
    project: string;
    run: ReturnType<typeof runInProcess>;
    lockedSha: (key: string) => Promise<string>;
  }

  async function fixture(prefix: string): Promise<Fixture> {
    const project = await tempRepo(`capshelf-${prefix}-project-`);
    const dataRepo = await tempRepo(`capshelf-${prefix}-data-`, {
      origin: null,
    });
    await mkdir(join(dataRepo, "mcp", "deepwiki"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "deepwiki", "claude.json"),
      JSON.stringify({ mcpServers: { deepwiki: { command: "deepwiki-mcp" } } }),
    );
    await mkdir(join(dataRepo, "skills", "demo"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill.\n---\nbody\n",
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "mcp/deepwiki"])).exitCode).toBe(0);
    expect((await run(["add", "skills/demo"])).exitCode).toBe(0);

    const lockedSha = async (key: string): Promise<string> => {
      const lock = JSON.parse(
        await readFile(
          join(project, ".capshelf", "capshelf.lock.json"),
          "utf-8",
        ),
      );
      const entry = lock.items[key];
      expect(entry).toBeDefined();
      // The point of the whole class: a v4 data entry has no `sha`.
      expect(entry.sha).toBeUndefined();
      expect(entry.sourcePinDigest).toBeString();
      return entry.sourcePinDigest;
    };

    return { project, run, lockedSha };
  }

  test("no command prints the literal string undefined", async () => {
    const { run } = await fixture("identity-sweep");

    // The blunt assertion, on purpose: it catches the class rather than the
    // three sites that happened to be found. A missing field in a template
    // literal renders as this exact text.
    for (const args of [
      ["ls", "--here"],
      ["ls"],
      ["show", "mcp/deepwiki", "--no-content"],
      ["show", "skills/demo", "--no-content"],
      ["status"],
      ["add", "mcp/deepwiki"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain("undefined");
    }
  });

  test("ls --here renders the locked identity, human and JSON", async () => {
    const { run, lockedSha } = await fixture("identity-ls");
    const mcp = await lockedSha("data/mcp/deepwiki");

    const human = await run(["ls", "--here"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.toString()).toContain(mcp.slice(0, 12));

    const rows = JSON.parse(
      (await run(["ls", "--here", "--json"])).stdout.toString(),
    );
    for (const row of rows) {
      expect(row.lockedSha).toBeString();
      expect(row.lockedSha.length).toBeGreaterThan(0);
    }
    expect(
      rows.find(
        (row: { kind: string; name: string }) =>
          row.kind === "mcp" && row.name === "deepwiki",
      ).lockedSha,
    ).toBe(mcp);
  });

  test("add --json on an already-installed item still carries sha", async () => {
    const { run, lockedSha } = await fixture("identity-add-json");
    const mcp = await lockedSha("data/mcp/deepwiki");

    const parsed = JSON.parse(
      (await run(["add", "mcp/deepwiki", "--json"])).stdout.toString(),
    );
    expect(parsed.action).toBe("already-installed");
    // `JSON.stringify` drops an undefined value, so the regression is a missing
    // key rather than a wrong one — assert presence, not just the value.
    expect(Object.keys(parsed)).toContain("sha");
    expect(parsed.sha).toBe(mcp);
  });

  test("revert --json reports the locked identity", async () => {
    const { run, lockedSha } = await fixture("identity-revert");
    const skill = await lockedSha("data/skills/demo");

    const parsed = JSON.parse(
      (await run(["revert", "skills/demo", "--json"])).stdout.toString(),
    );
    expect(Object.keys(parsed)).toContain("sha");
    expect(parsed.sha).toBe(skill);
  });

  test("show does not claim an update right after a clean add", async () => {
    const { run } = await fixture("identity-show");

    // `masterSha` hashes the data repo's working tree; the lock holds a digest
    // over a committed tree. They can never be equal, so comparing them
    // reported an update for every item forever. `status` owns update
    // detection — and reports these same items as up-to-date.
    for (const ref of ["mcp/deepwiki", "skills/demo"]) {
      const shown = await run(["show", ref, "--no-content"]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout.toString()).not.toContain("update available");
    }

    const status = await run(["status"]);
    expect(status.stdout.toString()).toContain("up-to-date");
    expect(status.stdout.toString()).not.toContain("update available");
  });
});
