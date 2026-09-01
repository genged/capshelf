import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setPickContext } from "../src/pick";
import type { PickContext } from "../src/pick";
import { diffNamedFiles } from "../src/promote-preview";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  baselineRepo,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

let previousPick: PickContext | null = null;

afterEach(() => {
  setPickContext(previousPick);
  previousPick = null;
});

async function projectWithEditedTypeScriptSkill(prefix: string): Promise<{
  project: string;
  dataRepo: string;
  installedFile: string;
  run: ReturnType<typeof runInProcess>;
}> {
  const project = await tempRepo(`${prefix}project-`);
  const dataRepo = await baselineRepo(`${prefix}data-`);
  await mkdir(join(dataRepo, "skills", "typed"), { recursive: true });
  await writeFile(join(dataRepo, "skills", "typed", "SKILL.md"), "# typed\n");
  await writeFile(
    join(dataRepo, "skills", "typed", "index.ts"),
    "export const value: number = 1;\n",
  );
  await $`git -C ${dataRepo} add skills`.quiet();
  await $`git -C ${dataRepo} commit -qm typed`.quiet();
  const run = runInProcess(project);
  expect(
    (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
  ).toBe(0);
  expect((await run(["add", "skills/typed"])).exitCode).toBe(0);
  const installedFile = join(project, ".agents", "skills", "typed", "index.ts");
  await writeFile(installedFile, "export const value: number = 2;\n");
  return { project, dataRepo, installedFile, run };
}

describe("promote picker diff preview", () => {
  test("a controlled file name cannot inject a diff header", async () => {
    const text = await diffNamedFiles(
      [],
      [
        {
          path: "real\n+++ b/forged.ts\u001b",
          content: Buffer.from("export const safe = true;\n"),
          mode: "100644",
        },
      ],
    );

    expect(text.match(/^\+\+\+ /gm)).toHaveLength(1);
    expect(text).toContain("+++ b/real +++ b/forged.ts ");
    expect(text).not.toContain("\u001b");
  });

  test("a binary candidate renders a stanza instead of its bytes", async () => {
    const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xff, 0xfe]);
    const named = {
      path: "assets/font.woff2",
      content: font,
      mode: "100644",
    } as const;

    expect(await diffNamedFiles([], [named])).toBe(
      "--- /dev/null\n+++ b/assets/font.woff2\nBinary files differ\n",
    );
    expect(
      await diffNamedFiles(
        [named],
        [
          {
            ...named,
            content: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x02]),
          },
        ],
      ),
    ).toBe(
      "--- a/assets/font.woff2\n+++ b/assets/font.woff2\nBinary files differ\n",
    );
    expect(await diffNamedFiles([named], [named])).toBe("");
  });

  test(
    "a reviewed candidate is the candidate that gets committed",
    async () => {
      const { dataRepo, run } = await projectWithEditedTypeScriptSkill(
        "capshelf-previewcommit-",
      );
      let shown = "";
      previousPick = setPickContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (request) => {
          const row = request.rows.find(
            (entry) => entry.ref === "skills/typed",
          );
          if (!row || !request.preview) throw new Error("preview unavailable");
          const preview = await request.preview(row);
          if (!preview.version) throw new Error("preview guard unavailable");
          shown = preview.text;
          return {
            kind: "picked",
            refs: [row.ref],
            previewVersions: { [row.ref]: preview.version },
          };
        },
      });

      const result = await run(["promote"]);

      expect(result.exitCode).toBe(0);
      expect(shown).toContain("--- a/index.ts");
      expect(shown).toContain("+++ b/index.ts");
      expect(shown).toContain("+export const value: number = 2;");
      expect(
        await readFile(join(dataRepo, "skills", "typed", "index.ts"), "utf-8"),
      ).toBe("export const value: number = 2;\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a candidate change after the preview refuses the promote",
    async () => {
      const { dataRepo, installedFile, run } =
        await projectWithEditedTypeScriptSkill("capshelf-previewstale-");
      const before = await $`git -C ${dataRepo} rev-parse HEAD`.quiet().text();
      previousPick = setPickContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (request) => {
          const row = request.rows.find(
            (entry) => entry.ref === "skills/typed",
          );
          if (!row || !request.preview) throw new Error("preview unavailable");
          const preview = await request.preview(row);
          if (!preview.version) throw new Error("preview guard unavailable");
          await writeFile(installedFile, "export const value: number = 3;\n");
          return {
            kind: "picked",
            refs: [row.ref],
            previewVersions: { [row.ref]: preview.version },
          };
        },
      });

      const result = await run(["promote"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("diff preview");
      expect(result.stderr.toString()).toContain("is stale");
      expect(result.stderr.toString()).toContain("press Ctrl-V");
      const after = await $`git -C ${dataRepo} rev-parse HEAD`.quiet().text();
      expect(after).toBe(before);
      expect(
        await readFile(join(dataRepo, "skills", "typed", "index.ts"), "utf-8"),
      ).toBe("export const value: number = 1;\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an item base change after the preview refuses the promote",
    async () => {
      const { dataRepo, run } = await projectWithEditedTypeScriptSkill(
        "capshelf-previewbase-",
      );
      const dataFile = join(dataRepo, "skills", "typed", "index.ts");
      let concurrentHead = "";
      previousPick = setPickContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (request) => {
          const row = request.rows.find(
            (entry) => entry.ref === "skills/typed",
          );
          if (!row || !request.preview) throw new Error("preview unavailable");
          const preview = await request.preview(row);
          if (!preview.version) throw new Error("preview guard unavailable");
          await writeFile(dataFile, "export const value: number = 9;\n");
          await $`git -C ${dataRepo} add skills/typed/index.ts`.quiet();
          await $`git -C ${dataRepo} commit -qm concurrent`.quiet();
          concurrentHead = await $`git -C ${dataRepo} rev-parse HEAD`
            .quiet()
            .text();
          return {
            kind: "picked",
            refs: [row.ref],
            previewVersions: { [row.ref]: preview.version },
          };
        },
      });

      const result = await run(["promote"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("diff preview");
      expect(result.stderr.toString()).toContain("is stale");
      const after = await $`git -C ${dataRepo} rev-parse HEAD`.quiet().text();
      expect(after).toBe(concurrentHead);
      expect(await readFile(dataFile, "utf-8")).toBe(
        "export const value: number = 9;\n",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
