import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectAbsent,
  expectBytes,
  expectExit,
  expectHeadTreeContains,
  expectHeadTreeExcludes,
  expectIgnored,
  expectRealDirectory,
  expectRecovery,
  expectRelativeSymlink,
  expectSameState,
  parseApplyRows,
} from "../support/assertions";
import type { CommandResult } from "../support/command";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const exited = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
  command: ["capshelf", "apply"],
  cwd: "/tmp",
  outcome: { kind: "exit", exitCode },
  stdout,
  stderr,
});

test("exit assertions separate a refusal from a signal, timeout, and spawn failure", () => {
  expect(() => expectExit(exited(0), 0)).not.toThrow();
  expect(() => expectExit(exited(6), 0)).toThrow("expected exit 0, got exit 6");
  expect(() =>
    expectExit(
      {
        command: ["capshelf"],
        cwd: "/tmp",
        outcome: { kind: "timeout", timeoutMs: 5, finalSignal: "SIGKILL" },
        stdout: "",
        stderr: "",
      },
      0,
    ),
  ).toThrow("timed out after 5 ms");
  expect(() =>
    expectExit(
      {
        command: ["capshelf"],
        cwd: "/tmp",
        outcome: { kind: "signal", signal: "SIGKILL" },
        stdout: "",
        stderr: "",
      },
      0,
    ),
  ).toThrow("killed by signal SIGKILL");
});

test("a recovery assertion fails when the message names no way out", () => {
  expect(() =>
    expectRecovery(
      exited(6, "", "no data repo configured"),
      "capshelf set-data <path>",
    ),
  ).toThrow("expected output to contain");
});

test("apply rows are rejected when the payload is not the documented shape", () => {
  expect(
    parseApplyRows('{"items":[{"key":"data/skills/x","action":"reconciled"}]}'),
  ).toEqual([{ key: "data/skills/x", action: "reconciled" }]);
  expect(() => parseApplyRows('{"results":[]}')).toThrow("no items array");
  expect(() => parseApplyRows('{"items":[{"key":1}]}')).toThrow(
    "unexpected apply row",
  );
});

test(
  "filesystem assertions fail against a deliberately wrong state",
  async () => {
    await withWorld("assertion-faults", async (world) => {
      const dir = world.path("probe");
      await mkdir(join(dir, "real"), { recursive: true });
      await writeFile(join(dir, "file.txt"), "content\n");
      await symlink("../real", join(dir, "link"));

      await expectBytes(join(dir, "file.txt"), "content\n");
      await expect(
        expectBytes(join(dir, "file.txt"), "other\n"),
      ).rejects.toThrow("bytes differ");
      await expect(expectBytes(join(dir, "file.txt"), null)).rejects.toThrow(
        "to be absent",
      );
      await expect(expectBytes(join(dir, "missing.txt"), "x")).rejects.toThrow(
        "to exist",
      );
      await expectBytes(join(dir, "missing.txt"), null);

      await expectAbsent(join(dir, "missing.txt"));
      await expect(expectAbsent(join(dir, "file.txt"))).rejects.toThrow(
        "to be absent",
      );

      await expectRealDirectory(join(dir, "real"));
      await expect(expectRealDirectory(join(dir, "link"))).rejects.toThrow(
        "found a symlink",
      );
      await expect(expectRealDirectory(join(dir, "file.txt"))).rejects.toThrow(
        "expected a directory",
      );

      await expectRelativeSymlink(join(dir, "link"), "../real");
      await expect(
        expectRelativeSymlink(join(dir, "link"), "../elsewhere"),
      ).rejects.toThrow("points at");
      await expect(
        expectRelativeSymlink(join(dir, "real"), "../real"),
      ).rejects.toThrow("found a real entry");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "git assertions fail against a deliberately wrong repository state",
  async () => {
    await withWorld("git-assertion-faults", async (world) => {
      const repo = await world.git.createRepo("repo", { origin: null });
      await world.git.writeFiles(repo, {
        ".gitignore": "secret.txt\n",
        "kept.txt": "kept\n",
        "secret.txt": "secret\n",
      });
      await world.git.commit(repo, "seed");

      await expectHeadTreeContains(world, repo, ["kept.txt", ".gitignore"]);
      await expect(
        expectHeadTreeContains(world, repo, ["absent.txt"]),
      ).rejects.toThrow("is missing");

      await expectHeadTreeExcludes(world, repo, ["secret.txt"]);
      await expect(
        expectHeadTreeExcludes(world, repo, ["kept.txt"]),
      ).rejects.toThrow("must not contain");

      await expectIgnored(world, repo, ["secret.txt"]);
      await expect(expectIgnored(world, repo, ["kept.txt"])).rejects.toThrow(
        "to be ignored",
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "an owned-state snapshot needs a selection and detects any change it covers",
  async () => {
    await withWorld("snapshot", async (world) => {
      const repo = await world.git.createRepo("project", { origin: null });
      await world.git.writeFiles(repo, {
        ".capshelf/capshelf.json": "{}\n",
        "README.md": "x\n",
      });
      await world.git.commit(repo, "seed");

      await expect(captureOwnedState(world, {})).rejects.toThrow(
        "at least one selected snapshot",
      );

      const before = await captureOwnedState(world, {
        projectFiles: repo,
        projectGit: repo,
      });
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: repo,
          projectGit: repo,
        }),
        "unchanged",
      );

      await world.git.writeFiles(repo, { ".capshelf/capshelf.json": "{ }\n" });
      const after = await captureOwnedState(world, {
        projectFiles: repo,
        projectGit: repo,
      });
      expect(() => expectSameState(before, after, "edited")).toThrow(
        "owned state changed",
      );

      // A required-absence selection is itself an assertion.
      await expect(
        captureOwnedState(world, {
          requiredAbsent: [join(repo, "README.md")],
        }),
      ).rejects.toThrow("to be absent");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
