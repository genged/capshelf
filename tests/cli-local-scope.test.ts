import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, runInProcess, tempDir, tempRepo } from "./cli-fixtures";

describe("cli integration", () => {
  test("add --local writes local manifest, lock, excludes, and status group", async () => {
    const project = await tempRepo("capshelf-local-project-");
    const dataRepo = await tempRepo("capshelf-local-data-");

    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/local-only"]);
    expect(add.exitCode).toBe(0);

    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["local-only"],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/local-only"].source).toBe("data");
    const projectManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(projectManifest.skills).toEqual([]);
    const metadataIgnore = await readFile(
      join(project, ".capshelf", ".gitignore"),
      "utf-8",
    );
    expect(metadataIgnore).toContain("local.json");
    expect(metadataIgnore).toContain("local.lock.json");
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".capshelf/local.json");
    expect(exclude).not.toContain(".capshelf/local.lock.json");
    expect(exclude).toContain(".agents/skills/local-only/");

    const status = await run(["status", "--local", "--json"]);
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].scope).toBe("local");
    expect(statusJson.items[0].kind).toBe("skills");
    expect(statusJson.items[0].name).toBe("local-only");
    expect(statusJson.items[0].state).toBe("ok");

    const lsHere = await run(["ls", "--here", "--json"]);
    expect(lsHere.exitCode).toBe(0);
    const installedItems = JSON.parse(lsHere.stdout.toString()) as Array<{
      scope?: string;
      kind?: string;
      name?: string;
    }>;
    expect(
      installedItems.some(
        (item) =>
          item.scope === "local" &&
          item.kind === "skills" &&
          item.name === "local-only",
      ),
    ).toBe(true);

    const move = await run(["move", "skills/local-only", "--to", "project"]);
    expect(move.exitCode).toBe(0);

    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
    const nextLocalLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(nextLocalLock.items["data/skills/local-only"]).toBeUndefined();
    const nextProjectManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(nextProjectManifest.skills).toEqual(["local-only"]);
    const nextExclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(nextExclude).not.toContain(".agents/skills/local-only/");
    expect(nextExclude).not.toContain(".claude/skills/local-only");

    const gitStatus =
      await $`git -C ${project} status --short -- .agents/skills/local-only .claude/skills/local-only`.text();
    expect(gitStatus).toContain(".agents/skills/local-only");
  });

  test("rm --local removes local skill files and git exclude entries", async () => {
    const project = await tempRepo("capshelf-rm-local-project-");
    const dataRepo = await tempRepo("capshelf-rm-local-data-");

    await mkdir(join(dataRepo, "skills", "local-remove"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "local-remove", "SKILL.md"),
      "remove me\n",
    );
    await commitAll(dataRepo, "local removable skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/local-remove"]);
    expect(add.exitCode).toBe(0);
    let exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/local-remove/");
    expect(exclude).toContain(".claude/skills/local-remove");

    const rm = await run(["rm", "--local", "skills/local-remove"]);
    expect(rm.exitCode).toBe(0);

    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/local-remove"]).toBeUndefined();
    expect(
      await file(join(project, ".agents", "skills", "local-remove")).exists(),
    ).toBe(false);
    expect(
      await file(join(project, ".claude", "skills", "local-remove")).exists(),
    ).toBe(false);
    exclude = await readFile(join(project, ".git", "info", "exclude"), "utf-8");
    expect(exclude).not.toContain(".agents/skills/local-remove/");
    expect(exclude).not.toContain(".claude/skills/local-remove");
  });

  test("rm without --local points at local scope for a local-only item", async () => {
    const project = await tempRepo("capshelf-rm-scope-hint-project-");
    const dataRepo = await tempRepo("capshelf-rm-scope-hint-data-");

    await mkdir(join(dataRepo, "skills", "local-hinted"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-hinted", "SKILL.md"),
      "hint me\n",
    );
    await commitAll(dataRepo, "local hinted skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/local-hinted"]);
    expect(add.exitCode).toBe(0);

    for (const itemRef of ["skills/local-hinted", "local-hinted"]) {
      const rm = await run(["rm", itemRef]);
      expect(rm.exitCode).toBe(3);
      const stderr = rm.stderr.toString();
      expect(stderr).toContain(
        "skills/local-hinted is installed at local scope",
      );
      expect(stderr).toContain(
        "remove it with: capshelf rm --local skills/local-hinted",
      );
    }
    expect(
      await file(
        join(project, ".agents", "skills", "local-hinted", "SKILL.md"),
      ).exists(),
    ).toBe(true);

    const rmLocal = await run(["rm", "--local", "skills/local-hinted"]);
    expect(rmLocal.exitCode).toBe(0);
  });

  test("rm --local points at project scope for a project-only item", async () => {
    const project = await tempRepo("capshelf-rm-scope-hint-proj-project-");
    const dataRepo = await tempRepo("capshelf-rm-scope-hint-proj-data-");

    await mkdir(join(dataRepo, "skills", "project-hinted"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "project-hinted", "SKILL.md"),
      "hint me\n",
    );
    await commitAll(dataRepo, "project hinted skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "skills/project-hinted"]);
    expect(add.exitCode).toBe(0);

    const rm = await run(["rm", "--local", "skills/project-hinted"]);
    expect(rm.exitCode).toBe(3);
    const stderr = rm.stderr.toString();
    expect(stderr).toContain(
      "skills/project-hinted is installed at project scope",
    );
    expect(stderr).toContain(
      "remove it with: capshelf rm skills/project-hinted",
    );

    const rmProject = await run(["rm", "skills/project-hinted"]);
    expect(rmProject.exitCode).toBe(0);
  });

  test("rm --local reports an actionable error when the tree cannot be deleted", async () => {
    const project = await tempRepo("capshelf-rm-eacces-project-");
    const dataRepo = await tempRepo("capshelf-rm-eacces-data-");

    await mkdir(join(dataRepo, "skills", "stuck"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "stuck", "SKILL.md"), "x\n");
    await commitAll(dataRepo, "stuck skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/stuck"]);
    expect(add.exitCode).toBe(0);

    const skillsDir = join(project, ".agents", "skills");
    await chmod(skillsDir, 0o555);
    try {
      const rm = await run(["rm", "--local", "skills/stuck"]);
      expect(rm.exitCode).toBe(1);
      const stderr = rm.stderr.toString();
      expect(stderr).toContain("could not delete");
      expect(stderr).toContain("delete the directory manually");
      // The failed delete must not have untracked the item.
      const localConfig = await file(
        join(project, ".capshelf", "local.json"),
      ).json();
      expect(localConfig.skills).toEqual(["stuck"]);
    } finally {
      await chmod(skillsDir, 0o755);
    }

    const retry = await run(["rm", "--local", "skills/stuck"]);
    expect(retry.exitCode).toBe(0);
  });

  test("rm --local refuses a local-config item with no local lock entry", async () => {
    const project = await tempRepo("capshelf-rm-local-unlocked-project-");
    const dataRepo = await tempRepo("capshelf-rm-local-unlocked-data-");

    await mkdir(join(dataRepo, "skills", "unlocked"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "unlocked", "SKILL.md"), "x\n");
    await commitAll(dataRepo, "unlocked skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/unlocked"]);
    expect(add.exitCode).toBe(0);

    const lockPath = join(project, ".capshelf", "local.lock.json");
    const lock = await file(lockPath).json();
    delete lock.items["data/skills/unlocked"];
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const rm = await run(["rm", "--local", "skills/unlocked"]);
    expect(rm.exitCode).toBe(3);
    expect(rm.stderr.toString()).toContain(
      "no data lock entry exists, so installed files are not managed by capshelf",
    );
  });

  test("add --local works in non-git projects without git excludes", async () => {
    const project = await tempDir("capshelf-local-non-git-project-");
    const dataRepo = await tempRepo("capshelf-local-non-git-data-");

    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "local-only"]);
    expect(add.exitCode).toBe(0);

    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["local-only"],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
  });

  test("add --local treats a capshelf project nested under parent git as non-git", async () => {
    const parent = await tempRepo("capshelf-local-parent-git-");
    const project = join(parent, "examples", "old-albums");
    const dataRepo = await tempRepo("capshelf-local-nested-data-");

    await mkdir(join(project), { recursive: true });
    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "local-only"]);
    expect(add.exitCode).toBe(0);
    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(
      await file(join(parent, ".git", "info", "exclude")).text(),
    ).not.toContain(".agents/skills/local-only/");
  });

  test("update/apply/revert --local verify git-excluded local skills", async () => {
    const project = await tempRepo("capshelf-local-update-project-");
    const dataRepo = await tempRepo("capshelf-local-update-data-");
    const run = runInProcess(project);

    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v1\n",
    );
    await commitAll(dataRepo, "hello v1");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "--local", "skills/hello"])).exitCode).toBe(0);
    // The local install path is git-excluded — the setup that used to make
    // materialization verification hash an empty file list.
    expect(
      await readFile(join(project, ".git", "info", "exclude"), "utf-8"),
    ).toContain(".agents/skills/hello/");
    const lockBefore = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    const oldEntry = lockBefore.items["data/skills/hello"];

    // Advance upstream: edit the skill and add a second file.
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    await writeFile(join(dataRepo, "skills", "hello", "NEW.md"), "new\n");
    await commitAll(dataRepo, "hello v2");

    // Dry run reports the real installed hash — not the empty git-visible
    // digest e3b0c44298fc — and writes nothing.
    const dry = await run([
      "update",
      "skills/hello",
      "--local",
      "--dry-run",
      "--json",
    ]);
    expect(dry.exitCode).toBe(0);
    const dryJson = JSON.parse(dry.stdout.toString());
    expect(dryJson.items[0].action).toBe("would-update");
    expect(dryJson.items[0].currentSha).toBe(oldEntry.sha);
    expect(dryJson.items[0].currentSha).not.toBe("e3b0c44298fc");
    expect(
      await file(
        join(project, ".agents", "skills", "hello", "NEW.md"),
      ).exists(),
    ).toBe(false);
    expect(
      await file(join(project, ".capshelf", "local.lock.json")).json(),
    ).toEqual(lockBefore);

    const update = await run(["update", "skills/hello", "--local", "--json"]);
    expect(update.exitCode).toBe(0);
    const updateJson = JSON.parse(update.stdout.toString());
    expect(updateJson.items[0].action).toBe("updated");
    expect(
      await file(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe("hello v2\n");
    expect(
      await file(join(project, ".agents", "skills", "hello", "NEW.md")).text(),
    ).toBe("new\n");
    const lockAfter = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    const newEntry = lockAfter.items["data/skills/hello"];
    expect(newEntry.sha).not.toBe(oldEntry.sha);
    expect(newEntry.sourceCommit).not.toBe(oldEntry.sourceCommit);
    // Local-scope operations never leak into committed project policy.
    const projectManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(projectManifest.skills).toEqual([]);
    const projectLock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(projectLock.items["data/skills/hello"]).toBeUndefined();
    expect(
      (await run(["status", "skills/hello", "--local", "--strict"])).exitCode,
    ).toBe(0);

    // Unchanged apply converges without a verification failure.
    const apply = await run(["apply", "skills/hello", "--local", "--json"]);
    expect(apply.exitCode).toBe(0);
    const applyJson = JSON.parse(apply.stdout.toString());
    expect(applyJson.items[0].action).toBe("already-current");

    // Revert restores locked bytes and exits 0.
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "local edit\n",
    );
    const revert = await run(["revert", "skills/hello", "--local", "--json"]);
    expect(revert.exitCode).toBe(0);
    expect(JSON.parse(revert.stdout.toString()).action).toBe("reconciled");
    expect(
      await file(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe("hello v2\n");
    expect(
      (await run(["status", "skills/hello", "--local", "--strict"])).exitCode,
    ).toBe(0);
  });

  test("keep-local --local refuses an unchanged local-scope skill", async () => {
    const project = await tempRepo("capshelf-local-keeplocal-project-");
    const dataRepo = await tempRepo("capshelf-local-keeplocal-data-");
    const run = runInProcess(project);

    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "hello");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "--local", "skills/hello"])).exitCode).toBe(0);

    // Freshly added: no divergence, even though the install path is
    // git-excluded and hashes as empty under git-visible conventions.
    const lockBefore = await readFile(
      join(project, ".capshelf", "local.lock.json"),
      "utf-8",
    );
    const kept = await run(["keep-local", "skills/hello", "--local"]);
    expect(kept.exitCode).toBe(3);
    expect(kept.stderr.toString()).toContain("no local divergence");
    expect(
      await readFile(join(project, ".capshelf", "local.lock.json"), "utf-8"),
    ).toBe(lockBefore);
    const entry = JSON.parse(lockBefore).items["data/skills/hello"];
    expect(entry.local).toBeUndefined();
    expect(entry.localReason).toBeUndefined();

    // Genuine drift is still accepted, proving the refusal above checks
    // content rather than rejecting local scope outright.
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "edited\n",
    );
    const keptAfterEdit = await run(["keep-local", "skills/hello", "--local"]);
    expect(keptAfterEdit.exitCode).toBe(0);
    const lockAfter = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(lockAfter.items["data/skills/hello"].local).toBe(true);
  });

  test("share adopts a new skill into local scope by default", async () => {
    const project = await tempRepo("capshelf-share-local-project-");
    const dataRepo = await tempRepo("capshelf-share-local-data-");
    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "draft"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "draft", "SKILL.md"),
      "draft\n",
    );

    const share = await run(["share", "skills/draft"]);
    expect(share.exitCode).toBe(0);

    expect(
      await file(join(dataRepo, "skills", "draft", "SKILL.md")).text(),
    ).toBe("draft\n");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["draft"],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/draft"].source).toBe("data");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/draft/");
  });

  test("share to local copies ignored skill files from the filesystem", async () => {
    const project = await tempRepo("capshelf-share-ignored-project-");
    const dataRepo = await tempRepo("capshelf-share-ignored-data-");
    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    await writeFile(join(project, ".gitignore"), ".agents/skills/ignored/\n");
    await commitAll(project, "ignore local skill path");
    await mkdir(join(project, ".agents", "skills", "ignored"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "ignored", "SKILL.md"),
      "ignored content\n",
    );

    const share = await run(["share", "skills/ignored"]);
    expect(share.exitCode).toBe(0);
    expect(
      await file(join(dataRepo, "skills", "ignored", "SKILL.md")).text(),
    ).toBe("ignored content\n");

    const status = await run(["status", "--local", "skills/ignored", "--json"]);
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].state).toBe("ok");
  });

  test("share normalizes real claude skills in non-git projects without generated files", async () => {
    const project = await tempDir("capshelf-share-claude-non-git-project-");
    const dataRepo = await tempRepo("capshelf-share-claude-non-git-data-");
    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const skillDir = join(project, ".claude", "skills", "from-claude");
    await mkdir(join(skillDir, "scripts", ".venv"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "from claude\n");
    await writeFile(join(skillDir, "scripts", ".gitignore"), ".venv/\n");
    await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n");
    await writeFile(join(skillDir, "scripts", ".venv", "pyvenv.cfg"), "venv\n");

    const share = await run(["share", "skills/from-claude", "--to", "project"]);
    expect(share.exitCode).toBe(0);

    expect(
      await file(join(dataRepo, "skills", "from-claude", "SKILL.md")).text(),
    ).toBe("from claude\n");
    expect(
      await file(
        join(dataRepo, "skills", "from-claude", "scripts", "run.sh"),
      ).text(),
    ).toBe("#!/bin/sh\n");
    expect(
      await file(
        join(dataRepo, "skills", "from-claude", "scripts", ".venv"),
      ).exists(),
    ).toBe(false);
    expect(
      await file(
        join(project, ".agents", "skills", "from-claude", "SKILL.md"),
      ).text(),
    ).toBe("from claude\n");
  });

  test("share adopts a new skill into project scope", async () => {
    const project = await tempRepo("capshelf-share-project-project-");
    const dataRepo = await tempRepo("capshelf-share-project-data-");
    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "policy"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "policy", "SKILL.md"),
      "policy\n",
    );

    const share = await run(["share", "skills/policy", "--to", "project"]);
    expect(share.exitCode).toBe(0);

    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["policy"]);
    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/skills/policy"].source).toBe("data");
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".agents/skills/policy/");
  });

  test("share to local rejects a project-git-tracked skill path", async () => {
    const project = await tempRepo("capshelf-share-tracked-project-");
    const dataRepo = await tempRepo("capshelf-share-tracked-data-");
    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "tracked"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "tracked", "SKILL.md"),
      "tracked\n",
    );
    await $`git -C ${project} add .agents/skills/tracked/SKILL.md`.quiet();
    await $`git -C ${project} commit -qm "track local skill"`.quiet();

    const share = await run(["share", "skills/tracked"]);
    expect(share.exitCode).toBe(3);
    expect(share.stderr.toString()).toContain(
      "local install path is already tracked by git",
    );
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".agents/skills/tracked/");
    expect(await file(join(dataRepo, "skills", "tracked")).exists()).toBe(
      false,
    );
  });

  test("move changes tracked skill scope in both directions", async () => {
    const project = await tempRepo("capshelf-move-project-");
    const dataRepo = await tempRepo("capshelf-move-data-");

    await mkdir(join(dataRepo, "skills", "toggle"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "toggle", "SKILL.md"), "toggle\n");
    await commitAll(dataRepo, "toggle skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "--local", "skills/toggle"]);
    expect(add.exitCode).toBe(0);

    const toProject = await run(["move", "skills/toggle", "--to", "project"]);
    expect(toProject.exitCode).toBe(0);
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
    let manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["toggle"]);
    let localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/toggle"]).toBeUndefined();

    const toLocal = await run(["move", "skills/toggle", "--to", "local"]);
    expect(toLocal.exitCode).toBe(0);
    manifest = await file(join(project, ".capshelf", "capshelf.json")).json();
    expect(manifest.skills).toEqual([]);
    localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/toggle"].source).toBe("data");
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual(["toggle"]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/toggle/");
  });

  test("move to local works in non-git projects without git excludes", async () => {
    const project = await tempDir("capshelf-move-non-git-project-");
    const dataRepo = await tempRepo("capshelf-move-non-git-data-");

    await mkdir(join(dataRepo, "skills", "toggle"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "toggle", "SKILL.md"), "toggle\n");
    await commitAll(dataRepo, "toggle skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "skills/toggle"]);
    expect(add.exitCode).toBe(0);

    const move = await run(["move", "skills/toggle", "--to", "local"]);
    expect(move.exitCode).toBe(0);
    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["toggle"],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
  });

  test("move recovers a partial local-to-project scope change", async () => {
    const project = await tempRepo("capshelf-move-partial-project-");
    const dataRepo = await tempRepo("capshelf-move-partial-data-");

    await mkdir(join(dataRepo, "skills", "partial"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "partial", "SKILL.md"),
      "partial\n",
    );
    await commitAll(dataRepo, "partial skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);
    const add = await run(["add", "--local", "skills/partial"]);
    expect(add.exitCode).toBe(0);

    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const localLock = await file(localLockPath).json();
    const projectLock = await file(projectLockPath).json();
    projectLock.items["data/skills/partial"] =
      localLock.items["data/skills/partial"];
    await writeFile(
      projectLockPath,
      `${JSON.stringify(projectLock, null, 2)}\n`,
    );
    const manifest = await file(manifestPath).json();
    manifest.skills.push("partial");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const recovered = await run(["move", "skills/partial", "--to", "project"]);
    expect(recovered.exitCode).toBe(0);

    const nextLocalLock = await file(localLockPath).json();
    expect(nextLocalLock.items["data/skills/partial"]).toBeUndefined();
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const nextManifest = await file(manifestPath).json();
    expect(nextManifest.skills).toEqual(["partial"]);
  });

  test("move recovers a partial project-to-local scope change after excludes", async () => {
    const project = await tempRepo("capshelf-move-to-local-partial-project-");
    const dataRepo = await tempRepo("capshelf-move-to-local-partial-data-");

    await mkdir(join(dataRepo, "skills", "partial-local"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "partial-local", "SKILL.md"),
      "partial local\n",
    );
    await commitAll(dataRepo, "partial local skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);
    const add = await run(["add", "skills/partial-local"]);
    expect(add.exitCode).toBe(0);

    const localConfigPath = join(project, ".capshelf", "local.json");
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const projectLock = await file(projectLockPath).json();
    const localLock = {
      version: 2,
      items: {
        "data/skills/partial-local":
          projectLock.items["data/skills/partial-local"],
      },
    };
    await writeFile(localLockPath, `${JSON.stringify(localLock, null, 2)}\n`);
    const localConfig = await file(localConfigPath).json();
    localConfig.skills.push("partial-local");
    await writeFile(
      localConfigPath,
      `${JSON.stringify(localConfig, null, 2)}\n`,
    );
    await writeFile(
      join(project, ".git", "info", "exclude"),
      ".agents/skills/partial-local/\n.claude/skills/partial-local\n",
    );

    const recovered = await run([
      "move",
      "skills/partial-local",
      "--to",
      "local",
    ]);
    expect(recovered.exitCode).toBe(0);

    const nextProjectLock = await file(projectLockPath).json();
    expect(nextProjectLock.items["data/skills/partial-local"]).toBeUndefined();
    const nextManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(nextManifest.skills).toEqual([]);
    const nextLocalLock = await file(localLockPath).json();
    expect(nextLocalLock.items["data/skills/partial-local"].source).toBe(
      "data",
    );
  });

  test("promote --local syncs a local-scope skill without changing project scope", async () => {
    const project = await tempRepo("capshelf-promote-local-project-");
    const dataRepo = await tempRepo("capshelf-promote-local-data-");

    await mkdir(join(dataRepo, "skills", "local-edit", "scripts"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "local-edit", "SKILL.md"),
      "before\n",
    );
    await writeFile(
      join(dataRepo, "skills", "local-edit", "scripts", ".gitignore"),
      ".venv/\n",
    );
    await commitAll(dataRepo, "local edit skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);
    const add = await run(["add", "--local", "skills/local-edit"]);
    expect(add.exitCode).toBe(0);

    const beforeLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    await writeFile(
      join(project, ".agents", "skills", "local-edit", "SKILL.md"),
      "after\n",
    );
    await writeFile(
      join(project, ".agents", "skills", "local-edit", "scripts", "new.py"),
      "print('new')\n",
    );
    await mkdir(
      join(project, ".agents", "skills", "local-edit", "scripts", ".venv"),
      { recursive: true },
    );
    await writeFile(
      join(
        project,
        ".agents",
        "skills",
        "local-edit",
        "scripts",
        ".venv",
        "pyvenv.cfg",
      ),
      "generated\n",
    );
    const promote = await run([
      "promote",
      "--local",
      "skills/local-edit",
      "-m",
      "promote local edit",
    ]);
    expect(promote.exitCode).toBe(0);
    expect(promote.stderr.toString()).not.toContain("deprecated");

    expect(
      await file(join(dataRepo, "skills", "local-edit", "SKILL.md")).text(),
    ).toBe("after\n");
    expect(
      await file(
        join(dataRepo, "skills", "local-edit", "scripts", "new.py"),
      ).text(),
    ).toBe("print('new')\n");
    expect(
      await file(
        join(
          dataRepo,
          "skills",
          "local-edit",
          "scripts",
          ".venv",
          "pyvenv.cfg",
        ),
      ).exists(),
    ).toBe(false);
    const afterLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(afterLock.items["data/skills/local-edit"].sha).not.toBe(
      beforeLock.items["data/skills/local-edit"].sha,
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
  });

  test("promote syncs a project-scope skill from a non-git project", async () => {
    const project = await tempDir("capshelf-promote-non-git-project-");
    const dataRepo = await tempRepo("capshelf-promote-non-git-data-");

    await mkdir(join(dataRepo, "skills", "keyword-research", "scripts"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "SKILL.md"),
      "before\n",
    );
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "scripts", ".gitignore"),
      ".venv/\n",
    );
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "scripts", "run.sh"),
      "#!/bin/sh\n",
    );
    await commitAll(dataRepo, "keyword research skill");

    const run = runInProcess(project);
    const init = await run(["init", "--data", dataRepo]);
    expect(init.exitCode).toBe(0);

    const add = await run(["add", "keyword-research"]);
    expect(add.exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "keyword-research");
    await writeFile(join(installed, "SKILL.md"), "after\n");
    await writeFile(join(installed, "scripts", "parse.py"), "print('new')\n");
    await mkdir(
      join(installed, "scripts", ".venv", "lib", "python3.14", "site-packages"),
      { recursive: true },
    );
    await writeFile(
      join(
        installed,
        "scripts",
        ".venv",
        "lib",
        "python3.14",
        "site-packages",
        "_virtualenv.py",
      ),
      "generated\n",
    );

    const promote = await run([
      "promote",
      "keyword-research",
      "-m",
      "promote keyword research",
    ]);

    expect(promote.exitCode).toBe(0);
    expect(
      await file(
        join(dataRepo, "skills", "keyword-research", "SKILL.md"),
      ).text(),
    ).toBe("after\n");
    expect(
      await file(
        join(dataRepo, "skills", "keyword-research", "scripts", "parse.py"),
      ).text(),
    ).toBe("print('new')\n");
    expect(
      await file(
        join(
          dataRepo,
          "skills",
          "keyword-research",
          "scripts",
          ".venv",
          "lib",
          "python3.14",
          "site-packages",
          "_virtualenv.py",
        ),
      ).exists(),
    ).toBe(false);
  });
});
