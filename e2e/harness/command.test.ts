import { afterEach, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  clearSecrets,
  describeCommand,
  registerSecret,
  runCommand,
} from "../support/command";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

afterEach(() => {
  clearSecrets();
});

test("a normal refusal renders as an exit code", async () => {
  await withWorld("outcome-exit", async (world) => {
    const result = await world.run(world.stage, ["/bin/sh", "-c", "exit 3"]);
    expect(result.outcome).toEqual({ kind: "exit", exitCode: 3 });
    expect(describeCommand(result)).toContain("outcome: exit 3");
  });
});

test("a signalled process is not reported as an exit code", async () => {
  await withWorld("outcome-signal", async (world) => {
    const result = await world.run(world.stage, [
      "/bin/sh",
      "-c",
      "kill -TERM $$",
    ]);
    expect(result.outcome.kind).toBe("signal");
    expect(describeCommand(result)).toContain("killed by signal SIGTERM");
  });
});

test("a process that cannot start renders as a spawn error", async () => {
  await withWorld("outcome-spawn-error", async (world) => {
    const result = await world.run(world.stage, [
      join(world.stage, "no-such-program"),
    ]);
    expect(result.outcome.kind).toBe("spawn-error");
    expect(describeCommand(result)).toContain("could not start the process");
  });
});

test(
  "the deadline stops the whole process tree, parent and grandchild",
  async () => {
    await withWorld("outcome-timeout", async (world) => {
      const outer = join(world.stage, "outer.log");
      const inner = join(world.stage, "inner.log");
      const result = await runCommand(
        [
          "/bin/sh",
          "-c",
          `( while true; do printf . >> "${inner}"; sleep 0.1; done ) & while true; do printf . >> "${outer}"; sleep 0.1; done`,
        ],
        {
          cwd: world.stage,
          env: world.env,
          timeoutMs: 700,
          graceMs: 200,
          drainMs: 500,
        },
      );

      expect(result.outcome.kind).toBe("timeout");
      expect(describeCommand(result)).toContain("timed out after 700 ms");

      // A dead process writes nothing. Comparing sizes across a pause proves
      // both the parent and the grandchild stopped, without needing a pid.
      const sizes = async () => ({
        outer: (await stat(outer)).size,
        inner: (await stat(inner)).size,
      });
      const first = await sizes();
      await Bun.sleep(600);
      expect(await sizes()).toEqual(first);
      expect(first.outer).toBeGreaterThan(0);
      expect(first.inner).toBeGreaterThan(0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test("a declared secret is redacted from every diagnostic field", async () => {
  const sentinel = "capshelf-e2e-sentinel-6f4a1c";
  await withWorld(
    "redaction",
    async (world) => {
      const cwd = join(world.stage, sentinel);
      await mkdir(cwd, { recursive: true });
      const result = await world.run(cwd, [
        "/bin/sh",
        "-c",
        `printf '%s\\n' "$GH_TOKEN"; printf '%s\\n' "${sentinel}" >&2`,
        sentinel,
      ]);
      // The result itself is what the command produced; the diagnostic is
      // what a log receives.
      expect(result.stdout).toContain(sentinel);
      const diagnostic = world.describe(result);
      expect(diagnostic).not.toContain(sentinel);
      expect(diagnostic).toContain("[redacted]");
      // Names are printed so a reader can see which inputs were declared.
      expect(diagnostic).toContain("GH_TOKEN");
    },
    { env: { GH_TOKEN: sentinel } },
  );
});

test("a secret shorter than four characters is not registered", () => {
  registerSecret("ab");
  expect(
    describeCommand({
      command: ["echo", "ab"],
      cwd: "/tmp",
      outcome: { kind: "exit", exitCode: 0 },
      stdout: "ab",
      stderr: "",
    }),
  ).toContain("ab");
});
