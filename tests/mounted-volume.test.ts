import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  runIn,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

// A container can attach a volume on a folder inside an installed item, for
// example a skill's node_modules. These tests mount a tmpfs there in a new
// user and mount namespace, so they need no root. They skip where the system
// does not allow such a namespace.
const canMount =
  process.platform === "linux" &&
  spawnSync("unshare", [
    "--user",
    "--map-root-user",
    "--mount",
    "sh",
    "-c",
    'd=$(mktemp -d) && mount -t tmpfs probe "$d"',
  ]).status === 0;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Run `script` with a tmpfs mounted on `mountPoint`, which holds `lib.js`.
 * The mount exists only for this one process tree.
 */
function withVolume(mountPoint: string, cwd: string, script: string) {
  return spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "sh",
      "-c",
      `set -e; mount -t tmpfs vol "$1"; echo lib > "$1/lib.js"; ${script}`,
      "sh",
      mountPoint,
      process.execPath,
      CLI,
    ],
    { cwd, env: process.env, encoding: "utf-8" },
  );
}

async function projectWithSkill(): Promise<{
  dataRepo: string;
  project: string;
  installed: string;
}> {
  const dataRepo = await baselineRepo("capshelf-mount-data-");
  const skill = await addSkill(dataRepo, "draw", "v1\n");
  await writeFile(join(skill, ".gitignore"), "node_modules/\n");
  await commitAll(dataRepo, "add draw");
  const project = await tempRepo("capshelf-mount-project-", { origin: null });
  const run = runIn(project);
  expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(0);
  expect(run(["add", "skills/draw"]).exitCode).toBe(0);
  const installed = join(project, ".agents", "skills", "draw");
  await mkdir(join(installed, "node_modules"));
  return { dataRepo, project, installed };
}

describe.skipIf(!canMount)("an installed item with a mounted volume", () => {
  test(
    "update replaces the item and keeps the volume and its files",
    async () => {
      const { dataRepo, project, installed } = await projectWithSkill();
      await addSkill(dataRepo, "draw", "v2\n");
      await commitAll(dataRepo, "update draw");

      const result = withVolume(
        join(installed, "node_modules"),
        project,
        `"$2" "$3" update skills/draw --yes >&2
         cat "$1/lib.js"
         mountpoint -q "$1" && echo still-mounted`,
      );

      expect(result.stderr).not.toContain("EBUSY");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("lib\nstill-mounted\n");
      expect(await Bun.file(join(installed, "SKILL.md")).text()).toBe("v2\n");
      const leftovers = (
        await readdir(join(project, ".agents", "skills"))
      ).filter((name) => name.startsWith(".capshelf-"));
      expect(leftovers).toEqual([]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update refuses a managed file on the volume and changes nothing",
    async () => {
      const { dataRepo, project, installed } = await projectWithSkill();
      const skill = join(dataRepo, "skills", "draw");
      await writeFile(join(skill, ".gitignore"), "");
      await mkdir(join(skill, "node_modules"));
      await writeFile(join(skill, "node_modules", "shipped.js"), "shipped\n");
      await commitAll(dataRepo, "ship a node_modules file");

      const result = withVolume(
        join(installed, "node_modules"),
        project,
        `"$2" "$3" update skills/draw --yes >&2 || echo refused
         cat "$1/lib.js"`,
      );

      expect(result.stdout).toBe("refused\nlib\n");
      expect(result.stderr).toContain("mount point node_modules");
      expect(await Bun.file(join(installed, "SKILL.md")).text()).toBe("v1\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!canMount)("scratch folder removal", () => {
  test("refuses a folder with a mount point and deletes nothing", async () => {
    const root = await tempDir("capshelf-mount-scratch-");
    const volume = join(root, "original", "node_modules");
    await mkdir(volume, { recursive: true });
    const script = join(root, "remove.ts");
    await writeFile(
      script,
      `import { removeScratchTree } from ${JSON.stringify(join(import.meta.dir, "..", "src", "mount-points.ts"))};
await removeScratchTree(process.argv[2]).catch((error) => console.log(String(error)));`,
    );

    const result = withVolume(
      volume,
      root,
      `"$2" ${JSON.stringify(script)} ${JSON.stringify(root)}
       cat "$1/lib.js"`,
    );

    expect(result.stdout).toContain("is a mount point");
    expect(result.stdout).toEndWith("lib\n");
  });
});

describe.skipIf(!canMount)("installed reconciliation", () => {
  test("commit and rollback keep a mounted volume in place", async () => {
    const root = await tempDir("capshelf-mount-reconcile-");
    const installed = join(root, "draw");
    await mkdir(join(installed, "lib", "node_modules"), { recursive: true });
    await writeFile(join(installed, "local.md"), "local\n");
    await writeFile(join(installed, "lib", "kept.md"), "kept\n");
    const script = join(root, "reconcile.ts");
    const source = join(import.meta.dir, "..", "src", "promote-transaction.ts");
    await writeFile(
      script,
      `import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beginInstalledReconciliation } from ${JSON.stringify(source)};
const installed = process.argv[2];
const file = (path, content) => ({ path, content: Buffer.from(content), mode: "100644" });
const show = async () =>
  console.log(JSON.stringify({
    top: (await readdir(installed)).sort(),
    lib: (await readdir(join(installed, "lib"))).sort(),
    volume: await readFile(join(installed, "lib", "node_modules", "lib.js"), "utf-8"),
  }));
const first = await beginInstalledReconciliation(installed, [file("local.md", "local\\n")], [file("merged.md", "merged\\n")]);
await first.commit();
await show();
const second = await beginInstalledReconciliation(installed, [], [file("lib/other.md", "other\\n")]);
await second.rollback();
await show();
console.log((await readdir(join(installed, ".."))).filter((name) => name.startsWith(".capshelf-")).length);`,
    );

    const result = withVolume(
      join(installed, "lib", "node_modules"),
      root,
      `"$2" ${JSON.stringify(script)} ${JSON.stringify(installed)}`,
    );

    expect(result.stderr).toBe("");
    const [afterCommit, afterRollback, leftovers] = result.stdout
      .trim()
      .split("\n");
    const expected = {
      top: ["lib", "merged.md"],
      lib: ["kept.md", "node_modules"],
      volume: "lib\n",
    };
    expect(JSON.parse(afterCommit ?? "")).toEqual(expected);
    expect(JSON.parse(afterRollback ?? "")).toEqual(expected);
    expect(leftovers).toBe("0");
  });
});

const SRC = join(import.meta.dir, "..", "src");

/** A project with `skills/draw` installed. `gitignore` null means none. */
async function projectWith(opts: {
  gitignore: string | null;
  local?: boolean;
}): Promise<{ dataRepo: string; project: string; installed: string }> {
  const dataRepo = await baselineRepo("capshelf-mount2-data-");
  const skill = await addSkill(dataRepo, "draw", "v1\n");
  if (opts.gitignore !== null) {
    await writeFile(join(skill, ".gitignore"), opts.gitignore);
  }
  await commitAll(dataRepo, "add draw");
  const project = await tempRepo("capshelf-mount2-project-", { origin: null });
  const run = runIn(project);
  expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(0);
  expect(
    run(["add", "skills/draw", ...(opts.local ? ["--local"] : [])]).exitCode,
  ).toBe(0);
  const installed = join(project, ".agents", "skills", "draw");
  await mkdir(join(installed, "node_modules"), { recursive: true });
  return { dataRepo, project, installed };
}

describe.skipIf(!canMount)(
  "rm, add, and share with a mounted volume (D7)",
  () => {
    test(
      "rm keeps the volume and says so, share skips the leftover, add fills it",
      async () => {
        const { project, installed } = await projectWith({
          gitignore: "node_modules/\n",
        });
        const rmJson = join(project, "rm.json");
        const scan = join(project, "scan.ts");
        await writeFile(
          scan,
          `import { loadManifest } from ${JSON.stringify(join(SRC, "manifest.ts"))};
import { loadLocalLock, loadLock } from ${JSON.stringify(join(SRC, "lock.ts"))};
import { scanUntrackedShareItems } from ${JSON.stringify(join(SRC, "share-scan.ts"))};
const project = process.argv[2];
const result = await scanUntrackedShareItems({
  project,
  dataRepo: project,
  manifest: await loadManifest(project),
  projectLock: await loadLock(project),
  localLock: await loadLocalLock(project),
});
console.log("SHARE " + JSON.stringify([...result.picks.keys()]));`,
        );
        const result = withVolume(
          join(installed, "node_modules"),
          project,
          `"$2" "$3" rm skills/draw --json --yes > ${JSON.stringify(rmJson)}
         "$2" ${JSON.stringify(scan)} ${JSON.stringify(project)}
         "$2" "$3" add skills/draw >&2
         cat "$1/lib.js"
         mountpoint -q "$1" && echo still-mounted`,
        );
        expect(result.stderr).not.toContain("EBUSY");
        expect(result.status).toBe(0);
        const [shareLine, lib, mounted] = result.stdout.trim().split("\n");
        expect(shareLine).toBe("SHARE []");
        expect(lib).toBe("lib");
        expect(mounted).toBe("still-mounted");
        const rm = JSON.parse(await Bun.file(rmJson).text());
        expect(rm.keptMountPoints).toEqual([
          ".agents/skills/draw/node_modules",
        ]);
        expect(await Bun.file(join(installed, "SKILL.md")).text()).toBe("v1\n");
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );

    test(
      "rm text output names the kept volume",
      async () => {
        const { project, installed } = await projectWith({
          gitignore: "node_modules/\n",
        });
        const result = withVolume(
          join(installed, "node_modules"),
          project,
          `"$2" "$3" rm skills/draw
         cat "$1/lib.js"`,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "! kept .agents/skills/draw/node_modules: it is a mounted volume",
        );
        expect(result.stdout).toEndWith("lib\n");
        expect(await Bun.file(join(installed, "SKILL.md")).exists()).toBe(
          false,
        );
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!canMount)("a visible path on a mounted volume (D5)", () => {
  for (const local of [false, true]) {
    test(
      `update refuses before the first write (${local ? "local" : "project"} scope)`,
      async () => {
        const { dataRepo, project, installed } = await projectWith({
          gitignore: null,
          local,
        });
        await addSkill(dataRepo, "draw", "v2\n");
        await commitAll(dataRepo, "v2");
        const result = withVolume(
          join(installed, "node_modules"),
          project,
          `"$2" "$3" update ${local ? "--local " : ""}skills/draw >&2 || echo "exit=$?"
           cat "$1/lib.js"`,
        );
        expect(result.stdout).toBe("exit=3\nlib\n");
        expect(result.stderr).toContain("is on mounted volume node_modules");
        expect(result.stderr).toContain(
          "Ignore node_modules/ in the item's .gitignore",
        );
        expect(await Bun.file(join(installed, "SKILL.md")).text()).toBe("v1\n");
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }
});

describe.skipIf(!canMount)("row-4 state around a mount (D3)", () => {
  test(
    "an ignored folder that holds a mount stays, and its other files are kept",
    async () => {
      const { dataRepo, project, installed } = await projectWith({
        gitignore: "vendor/\n",
      });
      const vendor = join(installed, "vendor");
      await mkdir(join(vendor, "node_modules"), { recursive: true });
      await writeFile(join(vendor, "notes.txt"), "notes\n");
      await addSkill(dataRepo, "draw", "v2\n");
      await commitAll(dataRepo, "v2");
      const result = withVolume(
        join(vendor, "node_modules"),
        project,
        `"$2" "$3" update skills/draw >&2
         cat "$1/lib.js"
         mountpoint -q "$1" && echo still-mounted`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("lib\nstill-mounted\n");
      expect(await Bun.file(join(vendor, "notes.txt")).text()).toBe("notes\n");
      expect(await Bun.file(join(installed, "SKILL.md")).text()).toBe("v2\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!canMount)("transaction defects (D2)", () => {
  test("a scratch folder that is itself a mount gets the scratch message", async () => {
    const root = await tempDir("capshelf-mount-scratch-root-");
    const scratch = join(root, ".capshelf-materialize-x");
    await mkdir(scratch);
    const script = join(root, "remove.ts");
    await writeFile(
      script,
      `import { removeScratchTree } from ${JSON.stringify(join(SRC, "mount-points.ts"))};
await removeScratchTree(process.argv[2]).catch((error) => console.log(String(error)));`,
    );
    const result = withVolume(
      scratch,
      root,
      `"$2" ${JSON.stringify(script)} ${JSON.stringify(scratch)}
       cat "$1/lib.js"`,
    );
    expect(result.stdout).toContain("did not delete the scratch folder");
    expect(result.stdout).not.toContain("cannot replace a folder");
    expect(result.stdout).toEndWith("lib\n");
  });

  // The restore used to clear the target with mounts even when the detach
  // moved nothing, which deleted the original install.
  test("a failed detach around a mount keeps the original install", async () => {
    const root = await tempDir("capshelf-mount-detach-");
    const target = join(root, "draw");
    await mkdir(join(target, "node_modules"), { recursive: true });
    await writeFile(join(target, "SKILL.md"), "old\n");
    const script = join(root, "detach.ts");
    await writeFile(
      script,
      `import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beginDirectoryReplacement } from ${JSON.stringify(join(SRC, "promote-transaction.ts"))};
const target = process.argv[2];
let message = "";
try {
  await beginDirectoryReplacement(target, async (replacement) => {
    await mkdir(replacement);
    await writeFile(join(replacement, "SKILL.md"), "new\\n");
    // A file where the backup folder goes makes mkdir(backup) fail.
    await writeFile(join(dirname(replacement), "original"), "in the way\\n");
    return [];
  });
} catch (error) {
  message = String(error);
}
console.log(JSON.stringify({ message, kept: existsSync(join(target, "SKILL.md")) }));`,
    );
    const result = withVolume(
      join(target, "node_modules"),
      root,
      `"$2" ${JSON.stringify(script)} ${JSON.stringify(target)}
       cat "$1/lib.js"`,
    );
    const [report, lib] = result.stdout.trim().split("\n");
    const parsed = JSON.parse(report ?? "{}");
    expect(parsed.message).toContain("EEXIST");
    expect(parsed.kept).toBe(true);
    expect(lib).toBe("lib");
  });
});
