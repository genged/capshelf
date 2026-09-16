import { expect, test } from "bun:test";
import { join } from "node:path";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

/**
 * The two clone modes are separate operations because Git treats them
 * differently: a clone from a local *path* may copy objects that no advertised
 * ref reaches, so it cannot stand in for what a new machine receives.
 */
test(
  "a transport clone cannot resolve an unadvertised commit that a local path clone copies",
  async () => {
    await withWorld("clone-modes", async (world) => {
      const source = await world.git.createRepo("source", { origin: null });
      await world.git.writeAndCommit(source, { "a.txt": "a\n" }, "advertised");

      // A commit on a deleted branch: still in the object store, reachable
      // from no ref.
      await world.git.ok(source, ["switch", "-q", "-c", "side"]);
      const unadvertised = await world.git.writeAndCommit(
        source,
        { "b.txt": "b\n" },
        "unadvertised",
      );
      await world.git.ok(source, ["switch", "-q", "main"]);
      await world.git.ok(source, ["branch", "-q", "-D", "side"]);
      expect(await world.git.hasCommit(source, unadvertised)).toBe(true);

      const viaPath = await world.git.cloneFromLocalPath(source, "via-path");
      expect(await world.git.hasCommit(viaPath, unadvertised)).toBe(true);

      const viaTransport = await world.git.cloneViaTransport(
        `file://${source}`,
        "via-transport",
      );
      expect(await world.git.hasCommit(viaTransport, unadvertised)).toBe(false);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test("the transport helper refuses a local path", async () => {
  await withWorld("transport-refuses-path", async (world) => {
    await expect(
      world.git.cloneViaTransport(world.stage, "nope"),
    ).rejects.toThrow("needs a remote URL");
  });
});

test("the local-path helper refuses a URL", async () => {
  await withWorld("path-refuses-url", async (world) => {
    await expect(
      world.git.cloneFromLocalPath(`file://${world.stage}`, "nope"),
    ).rejects.toThrow("needs a path");
  });
});

/**
 * The recorder is what an offline claim rests on, so its own failure modes are
 * proved here: a shim that recorded nothing would make "no fetch ran" pass
 * without measuring anything.
 */
test(
  "the recorder logs the measured command, skips fixture Git, and passes the real answer through",
  async () => {
    await withWorld("git-recorder", async (world) => {
      const repo = await world.git.createRepo("subject", { origin: null });
      const head = await world.git.writeAndCommit(
        repo,
        { "a.txt": "a\n" },
        "one",
      );

      const recorder = await world.git.recordInvocations();
      // Fixture Git runs without the recorder's environment, so the log holds
      // the subject's invocations and nothing the test itself ran.
      await world.git.ok(repo, ["status", "--porcelain=v1"]);
      expect(await recorder.invocations()).toEqual([]);

      const measured = await world.run(
        world.stage,
        ["git", "-C", repo, "rev-parse", "HEAD"],
        { env: recorder.env },
      );
      expect(measured.outcome).toMatchObject({ kind: "exit", exitCode: 0 });
      expect(measured.stdout.trim()).toBe(head);
      expect(await recorder.invocations()).toEqual([
        ["-C", repo, "rev-parse", "HEAD"],
      ]);
      // Read past `-C <repo>`: capshelf puts it before every repository
      // command, so the first argument is an option, not the subcommand.
      expect(await recorder.subcommands()).toEqual(["rev-parse"]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "the recorder names a network subcommand when one runs",
  async () => {
    await withWorld("git-recorder-network", async (world) => {
      const source = await world.git.createRepo("source", { origin: null });
      await world.git.writeAndCommit(source, { "a.txt": "a\n" }, "one");

      const recorder = await world.git.recordInvocations();
      const cloned = await world.run(
        world.stage,
        ["git", "clone", "-q", `file://${source}`, join(world.stage, "copy")],
        { env: recorder.env },
      );
      expect(cloned.outcome).toMatchObject({ kind: "exit", exitCode: 0 });
      expect(await recorder.subcommands()).toContain("clone");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a bare remote advertises what a project pushed to it",
  async () => {
    await withWorld("bare-remote", async (world) => {
      const project = await world.git.createProject("project");
      const remote = await world.git.createBareRemote("remote");
      expect(await world.git.advertisedRefs(remote.url)).toEqual([]);

      await world.git.ok(project, ["remote", "add", "origin", remote.url]);
      await world.git.ok(project, ["push", "-q", "-u", "origin", "main"]);

      const advertised = await world.git.advertisedRefs(remote.url);
      expect(advertised.join("\n")).toContain("refs/heads/main");
      expect(advertised.join("\n")).toContain(await world.git.head(project));
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
