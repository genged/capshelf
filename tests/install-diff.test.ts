import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyInstalledFile,
  installDifferenceLabel,
  isDestructiveDifference,
} from "../src/install-diff";
import type { InstallDifferenceKind } from "../src/install-diff";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

function classify(installed: Buffer | string, pinned: Buffer | string) {
  return classifyInstalledFile({
    path: "f.txt",
    installed: Buffer.isBuffer(installed) ? installed : Buffer.from(installed),
    pinned: Buffer.isBuffer(pinned) ? pinned : Buffer.from(pinned),
    installedMode: "100644",
    pinnedMode: "100644",
  });
}

describe("PIN-6 install classification", () => {
  test("identical bytes and modes are untouched", () => {
    expect(classify("a\n", "a\n").kind).toBe("untouched");
  });

  test("identical bytes with a different mode is a mode difference", () => {
    expect(
      classifyInstalledFile({
        path: "run.sh",
        installed: Buffer.from("#!/bin/sh\n"),
        pinned: Buffer.from("#!/bin/sh\n"),
        installedMode: "100755",
        pinnedMode: "100644",
      }),
    ).toEqual({ path: "run.sh", kind: "mode", modeChanged: true });
  });

  test("CRLF against LF is a line-ending difference", () => {
    expect(classify("a,b\r\nc,d\r\n", "a,b\nc,d\n").kind).toBe("line-endings");
  });

  test("a bare CR is data, not a line ending", () => {
    expect(classify("a\rb", "ab").kind).toBe("content-edit");
  });

  test("UTF-16 against UTF-8 is an encoding difference", () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("héllo\n", "utf16le"),
    ]);
    expect(classify(utf16, "héllo\n").kind).toBe("encoding");
  });

  test("an expanded $Id$ keyword is an ident difference", () => {
    expect(classify("$Id: f.txt 4c1f9 2026-08-01 $\n", "$Id$\n").kind).toBe(
      "ident",
    );
  });

  test("a git-lfs pointer on one side only is a filter artifact", () => {
    const pointer =
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n";
    expect(classify(pointer, "real bytes\n").kind).toBe("filter-artifact");
    expect(classify("real bytes\n", pointer).kind).toBe("filter-artifact");
  });

  test("anything else is a content edit, with the mode as a secondary fact", () => {
    expect(classify("edited\n", "original\n").kind).toBe("content-edit");
    expect(
      classifyInstalledFile({
        path: "run.sh",
        installed: Buffer.from("edited\n"),
        pinned: Buffer.from("original\n"),
        installedMode: "100755",
        pinnedMode: "100644",
      }),
    ).toEqual({ path: "run.sh", kind: "content-edit", modeChanged: true });
  });

  test("a normalized edit is labelled by its bytes, not by its cause", () => {
    // A user who deliberately converts a file to CRLF for a Windows tool
    // produces bytes indistinguishable from a checkout that did it. The label
    // says so as a possibility, and PIN-7 keeps the prompt either way.
    const difference = classify("a,b\r\n", "a,b\n");
    expect(installDifferenceLabel(difference)).toContain("may have rewritten");
    expect(isDestructiveDifference(difference.kind)).toBe(true);
  });
});

describe("PIN-7 gating", () => {
  const destructive: InstallDifferenceKind[] = [
    "mode",
    "line-endings",
    "encoding",
    "ident",
    "content-edit",
    "name-fold",
    "visible-extra",
    "filter-artifact",
    "unsupported-type",
    "unreadable",
  ];
  const harmless: InstallDifferenceKind[] = [
    "missing",
    "untouched",
    "ignored-extra",
  ];

  test("every kind that replaces or deletes bytes reaches consent", () => {
    for (const kind of destructive) {
      expect(isDestructiveDifference(kind)).toBe(true);
    }
  });

  test("an absent file and a preserved local file do not", () => {
    for (const kind of harmless) {
      expect(isDestructiveDifference(kind)).toBe(false);
    }
  });

  test(
    "a checkout-shaped difference still prompts, and says what it is",
    async () => {
      const project = await tempRepo("capshelf-crlf-project-");
      const dataRepo = await tempRepo("capshelf-crlf-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "csv-report", "# report\n");
      await writeFile(
        join(dataRepo, "skills", "csv-report", "template.csv"),
        "a,b\nc,d\n",
      );
      await commitAll(dataRepo, "csv report v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/csv-report"])).exitCode).toBe(0);

      // Exactly what a Windows teammate's checkout produces.
      const installed = join(
        project,
        ".agents",
        "skills",
        "csv-report",
        "template.csv",
      );
      await writeFile(installed, "a,b\r\nc,d\r\n");
      await writeFile(
        join(dataRepo, "skills", "csv-report", "SKILL.md"),
        "# report v2\n",
      );
      await commitAll(dataRepo, "csv report v2");

      const refused = await run(["update", "skills/csv-report"]);
      expect(refused.exitCode).toBe(3);
      const message = refused.stderr.toString();
      expect(message).toContain("Update would destroy local state");
      expect(message).toContain("template.csv");
      expect(message).toContain(
        "line endings differ — a checkout may have rewritten this file",
      );
      // Nothing was written without consent.
      expect(await readFile(installed, "utf-8")).toBe("a,b\r\nc,d\r\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a missing managed file and an ignored extra never prompt",
    async () => {
      const project = await tempRepo("capshelf-gate-none-project-");
      const dataRepo = await tempRepo("capshelf-gate-none-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "hello v1\n");
      await writeFile(
        join(dataRepo, "skills", "hello", "extra.md"),
        "extra v1\n",
      );
      await commitAll(dataRepo, "hello v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello");
      // A managed file that is simply absent: writing it destroys nothing.
      await Bun.$`rm ${join(installed, "extra.md")}`.quiet();
      // A local file the project's own ignore rules hide: preserved, untouched.
      await writeFile(join(project, ".gitignore"), "*.local.md\n");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "notes.local.md"), "mine\n");

      await writeFile(
        join(dataRepo, "skills", "hello", "SKILL.md"),
        "hello v2\n",
      );
      await commitAll(dataRepo, "hello v2");

      const updated = await run(["update", "skills/hello"]);
      expect(updated.exitCode).toBe(0);
      expect(await readFile(join(installed, "extra.md"), "utf-8")).toBe(
        "extra v1\n",
      );
      expect(await readFile(join(installed, "notes.local.md"), "utf-8")).toBe(
        "mine\n",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
