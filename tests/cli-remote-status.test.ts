import { expect, test } from "bun:test";
import { $ } from "bun";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  jsonOutput,
  objectItems,
  runInProcess,
} from "./cli-fixtures";
import {
  deleteUpstream,
  initRemoteProject,
  upstreamWith,
} from "./remote-fixtures";
import {
  assertLockV4,
  dataKey,
  loadLocalLock,
  serializeLock,
} from "../src/lock";
import type { LockV4 } from "../src/lock";
import { gitTreeSource } from "../src/item-source";
import { pinItemAtCommit } from "../src/pin";
import { headSha } from "../src/git";

async function installOne() {
  const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
  const world = await initRemoteProject();
  const run = runInProcess(world.project);
  const added = await run(["add", upstream.url, "--yes", "--json"], world.env);
  expect(added.exitCode).toBe(0);
  return { upstream, world, run };
}

test(
  "a remote row reports ok, never checked, and its upstream",
  async () => {
    const { world, run } = await installOne();
    const result = await run(["status", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    const remote = rows.find((row) => row.source === "remote");
    expect(remote).toMatchObject({
      source: "remote",
      kind: "skills",
      name: "pdf",
      scope: "local",
      state: "ok",
    });
    expect(remote!.remote).toMatchObject({ ref: "main", lastChecked: null });
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "bare status opens no network connection while a remote row exists",
  async () => {
    const { upstream, world, run } = await installOne();
    await deleteUpstream(upstream);
    const result = await run(["status", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows.find((row) => row.source === "remote")!.state).toBe("ok");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the remote group has its own heading",
  async () => {
    const { world, run } = await installOne();
    const result = await run(["status"], world.env);
    expect(result.stdout.toString()).toContain(
      "remote/  (skills pinned to repos outside your shelf)",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "status --project leaves every remote row out",
  async () => {
    const { world, run } = await installOne();
    const result = await run(["status", "--project", "--json"], world.env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows.some((row) => row.source === "remote")).toBe(false);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "an edited remote skill reports drifted and names share --adopt, never promote",
  async () => {
    const { world, run } = await installOne();
    await appendFile(
      join(world.project, ".agents/skills/pdf/SKILL.md"),
      "\n- always ask about rollback\n",
    );
    const result = await run(["status", "skills/pdf"], world.env);
    const out = result.stdout.toString();
    expect(out).toContain("capshelf share skills/pdf --adopt");
    expect(out).not.toContain("capshelf promote");
    const strict = await run(["status", "--strict"], world.env);
    expect(strict.exitCode).toBe(4);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a deleted install reports the missing installation axis and fails --strict",
  async () => {
    // A tree-pinned copy item whose install is gone reports `drifted_local`
    // with `installation: "missing"`, not the `missing_installed` state: every
    // pinned path is observed as absent, which is a different identity rather
    // than an absent one. Measured against a shelf item on 2026-09-16, and
    // asserted here so a remote row is reported the same way a shelf row is.
    const { world, run } = await installOne();
    await rm(join(world.project, ".agents/skills/pdf"), { recursive: true });
    const json = await run(["status", "--json"], world.env);
    const rows = objectItems(jsonOutput(json), "items");
    const remote = rows.find((row) => row.source === "remote")!;
    expect(remote.state).toBe("drifted_local");
    expect(remote.installation).toBe("missing");
    expect((await run(["status", "--strict"], world.env)).exitCode).toBe(4);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a name tracked in both the shelf and the remotes lock warns and fails --strict",
  async () => {
    // Constructed state, not a raced one: this is the intermediate state an
    // adopt leaves between step 11 and step 12.
    const { upstream, world, run } = await installOne();
    await mkdir(join(world.dataRepo, "skills/pdf"), { recursive: true });
    await writeFile(
      join(world.dataRepo, "skills/pdf/SKILL.md"),
      await readFile(join(world.project, ".agents/skills/pdf/SKILL.md")),
    );
    await $`git -C ${world.dataRepo} add -A`.quiet();
    await $`git -C ${world.dataRepo} commit -qm "adopt pdf"`.quiet();
    // Write the shelf row directly. `add skills/pdf --local` cannot build this
    // state: the ownership check refuses a name the remotes lock holds, which
    // is the whole point of the warning under test.
    // A project with only remote rows has no local lock file yet — every
    // remote row lives in `remotes.lock.json` by A3 — and `loadLocalLock`
    // returns an empty v4 lock for an absent file.
    const localLockPath = join(world.project, ".capshelf", "local.lock.json");
    const pin = await pinItemAtCommit(
      gitTreeSource({
        repo: world.dataRepo,
        kind: "skills",
        name: "pdf",
        commit: await headSha(world.dataRepo),
      }),
      "skills",
      "pdf",
    );
    const withShelfRow: LockV4 = assertLockV4(
      await loadLocalLock(world.project),
      "the fixture",
    );
    withShelfRow.items[dataKey("skills", "pdf")] = {
      source: "data",
      sourcePinDigest: pin.sourcePinDigest,
      sourceCommit: pin.sourceCommit,
      appliedAt: new Date().toISOString(),
      needs: null,
      needsSourceCommit: null,
    };
    // Through the real serializer, so the constructed row is one a real
    // `apply` would accept rather than a hand-shaped object.
    await writeFile(localLockPath, serializeLock(withShelfRow));

    const result = await run(["status", "skills/pdf"], world.env);
    expect(result.stdout.toString()).toContain("an adopt did not finish");
    expect((await run(["status", "--strict"], world.env)).exitCode).toBe(4);
    expect(upstream.url).toContain("file://");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
