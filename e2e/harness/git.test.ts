import { expect, test } from "bun:test";
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
