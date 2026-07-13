import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeBundleInstall,
  planBundleInstall,
  planFailures,
  preflightBundleChecks,
} from "../src/bundle-install";
import type { BundleScope } from "../src/bundle-install";
import type { Bundle } from "../src/bundles";
import { emptyLock } from "../src/lock";
import type { Lock } from "../src/lock";
import { emptyManifest } from "../src/manifest";
import type { ItemKind, MasterItem } from "../src/master";
import { emptyMetadata } from "../src/metadata";
import type { ItemMetadata } from "../src/metadata";
import type { ApplyFragmentOutputOptions } from "../src/fragments";

function bundleOf(refs: string[], name = "b"): Bundle {
  return {
    name,
    path: `/data/bundles/${name}.yml`,
    tags: [],
    members: refs.map((ref) => {
      const [kind, memberName] = ref.split("/") as [ItemKind, string];
      return { kind, name: memberName };
    }),
    warnings: [],
    unknownKinds: [],
    invalidIncludes: [],
  };
}

function masterOf(
  refs: string[],
): Pick<MasterItem, "kind" | "name" | "repoRelPath">[] {
  return refs.map((ref) => {
    const [kind, name] = ref.split("/") as [ItemKind, string];
    return { kind, name, repoRelPath: ref };
  });
}

function lockWith(...refs: string[]): Lock {
  const lock = emptyLock();
  for (const ref of refs) {
    lock.items[`data/${ref}`] = {
      source: "data",
      sha: "abcdefabcdef",
      sourceCommit: "deadbeef",
      appliedAt: "2026-06-01T00:00:00.000Z",
    };
  }
  return lock;
}

function metaWith(
  entries: Record<string, Partial<ItemMetadata>>,
): Map<string, ItemMetadata> {
  return new Map(
    Object.entries(entries).map(([ref, partial]) => [
      ref,
      { ...emptyMetadata(), ...partial },
    ]),
  );
}

function plan(opts: {
  bundle: Bundle;
  master: string[];
  projectLock?: Lock;
  localLock?: Lock;
  scope?: BundleScope;
  metadata?: Map<string, ItemMetadata>;
}) {
  return planBundleInstall({
    bundle: opts.bundle,
    masterItems: masterOf(opts.master),
    projectLock: opts.projectLock ?? emptyLock(),
    localLock: opts.localLock ?? emptyLock(),
    scope: opts.scope ?? "project",
    metadataByRef: opts.metadata ?? new Map(),
  });
}

describe("planBundleInstall", () => {
  test("all-fresh plan: ITEM_KINDS order, file order within a kind", () => {
    const refs = [
      "mcp/github",
      "skills/a",
      "settings/permissions-go",
      "settings/permissions-base",
      "codex-config/defaults",
    ];
    const result = plan({ bundle: bundleOf(refs), master: refs });

    expect(result.members.map((m) => m.ref)).toEqual([
      "skills/a",
      // File order within a kind is preserved (fragment merge order).
      "settings/permissions-go",
      "settings/permissions-base",
      "mcp/github",
      "codex-config/defaults",
    ]);
    expect(result.members.every((m) => m.status === "install")).toBe(true);
    expect(planFailures(result)).toEqual([]);
  });

  test("already installed in target scope is skipped, not failed", () => {
    const refs = ["skills/a", "skills/b"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      projectLock: lockWith("skills/a"),
    });

    expect(result.members.map((m) => m.status)).toEqual([
      "already-installed",
      "install",
    ]);
    expect(planFailures(result)).toEqual([]);
  });

  test("member locked in the other scope is a cross-scope failure", () => {
    const refs = ["skills/a"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      localLock: lockWith("skills/a"),
    });

    expect(result.members[0]?.status).toBe("cross-scope");
    expect(result.members[0]?.reason).toContain(
      "capshelf move skills/a --to project",
    );
    expect(planFailures(result)).toHaveLength(1);
  });

  test("missing member fails; the remaining members stay plannable", () => {
    const result = plan({
      bundle: bundleOf(["skills/a", "skills/gone"]),
      master: ["skills/a"],
    });

    expect(result.members.map((m) => m.status)).toEqual(["install", "missing"]);
    expect(planFailures(result).map((m) => m.ref)).toEqual(["skills/gone"]);
  });

  test("system item names are refused", () => {
    const result = plan({
      bundle: bundleOf(["skills/capshelf"]),
      master: ["skills/capshelf"],
    });
    expect(result.members[0]?.status).toBe("refused");
    expect(result.members[0]?.reason).toContain("system item");
  });

  test("member-vs-installed conflicts refuse in both directions", () => {
    const refs = ["skills/quick-review"];
    // Forward: the member declares the conflict.
    const forward = plan({
      bundle: bundleOf(refs),
      master: [...refs, "skills/security-review"],
      projectLock: lockWith("skills/security-review"),
      metadata: metaWith({
        "skills/quick-review": {
          conflictsWith: ["skills/security-review"],
        },
      }),
    });
    expect(forward.members[0]?.status).toBe("refused");
    expect(forward.members[0]?.reason).toBe(
      "conflicts with installed skills/security-review",
    );
    expect(forward.members[0]?.detail).toEqual([
      "declared by: skills/quick-review/.capshelf.yml",
    ]);

    // Reverse: the installed item declares the conflict.
    const reverse = plan({
      bundle: bundleOf(refs),
      master: [...refs, "skills/security-review"],
      projectLock: lockWith("skills/security-review"),
      metadata: metaWith({
        "skills/security-review": {
          conflictsWith: ["skills/quick-review"],
        },
      }),
    });
    expect(reverse.members[0]?.status).toBe("refused");
    expect(reverse.members[0]?.reason).toBe(
      "conflicts with installed skills/security-review",
    );
    expect(reverse.members[0]?.detail).toEqual([
      "declared by: skills/security-review/.capshelf.yml",
    ]);
  });

  test("member-vs-member conflicts are an authoring bug and refuse", () => {
    const refs = ["skills/a", "skills/b"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      metadata: metaWith({
        "skills/a": { conflictsWith: ["skills/b"] },
      }),
    });
    expect(result.members[0]?.reason).toBe(
      "conflicts with bundle member skills/b",
    );
    // Symmetric: the declared-against sibling refuses too.
    expect(result.members[1]?.reason).toBe(
      "conflicts with bundle member skills/a",
    );
    expect(planFailures(result)).toHaveLength(2);
  });

  test("requires satisfied by a sibling member or installed item do not warn", () => {
    const refs = ["skills/a", "settings/base"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      projectLock: lockWith("mcp/github"),
      metadata: metaWith({
        "skills/a": {
          requires: ["settings/base", "mcp/github", "mcp/sentry"],
        },
      }),
    });
    expect(result.missingRequiresByMember.get("skills/a")).toEqual([
      "mcp/sentry",
    ]);
    expect(planFailures(result)).toEqual([]);
  });

  test("--local with fragment members aggregates ALL violators", () => {
    const refs = [
      "skills/a",
      "settings/base",
      "settings/go",
      "mcp/github",
      "codex-config/defaults",
    ];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      scope: "local",
    });

    // One aggregated list naming every fragment member — never a
    // per-member assertLocalScopeSupported first-violator throw.
    expect(result.localFragmentMembers).toEqual([
      "settings/base",
      "settings/go",
      "mcp/github",
      "codex-config/defaults",
    ]);
    expect(planFailures(result)).toHaveLength(4);
    expect(result.members[0]?.status).toBe("install");
  });

  test("--local rejects a Pi extension as a project-only member", () => {
    const refs = ["skills/a", "pi-extensions/guard"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      scope: "local",
    });

    expect(result.localUnsupportedMembers).toEqual(["pi-extensions/guard"]);
    expect(result.localFragmentMembers).toEqual([]);
    expect(planFailures(result).map((member) => member.ref)).toEqual([
      "pi-extensions/guard",
    ]);
    expect(result.members[0]?.status).toBe("install");
  });

  test("a skills-only bundle plans clean under --local", () => {
    const refs = ["skills/a", "skills/b"];
    const result = plan({
      bundle: bundleOf(refs),
      master: refs,
      scope: "local",
    });
    expect(planFailures(result)).toEqual([]);
    expect(result.localFragmentMembers).toEqual([]);
    expect(result.localUnsupportedMembers).toEqual([]);
  });
});

describe("preflightBundleChecks fragment collisions", () => {
  async function fragmentDataRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "capshelf-bundle-frag-"));
    await $`git -C ${repo} init -q`.quiet();
    await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
    await $`git -C ${repo} config user.name capshelf`.quiet();
    for (const name of ["base", "go"]) {
      await mkdir(join(repo, "settings", name), { recursive: true });
      await writeFile(
        join(repo, "settings", name, "settings.json"),
        `{ "env": { "FROM_${name.toUpperCase()}": "1" } }\n`,
      );
    }
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -qm baseline`.quiet();
    return repo;
  }

  test("dry-run gets a prospective nextLock with ALL fragment members and wraps the error", async () => {
    const dataRepo = await fragmentDataRepo();
    const project = await mkdtemp(join(tmpdir(), "capshelf-bundle-proj-"));
    const refs = ["settings/base", "settings/go"];
    const bundlePlan = plan({ bundle: bundleOf(refs), master: refs });
    const masterByRef = new Map<string, MasterItem>(
      refs.map((ref) => {
        const [kind, name] = ref.split("/") as [ItemKind, string];
        return [
          ref,
          { kind, name, repoRelPath: ref, path: join(dataRepo, ref) },
        ];
      }),
    );

    const calls: ApplyFragmentOutputOptions[] = [];
    await preflightBundleChecks(bundlePlan, {
      project,
      dataRepo,
      manifest: emptyManifest(),
      lock: emptyLock(),
      masterByRef,
      planFragmentOutputFn: async (opts) => {
        calls.push(opts);
        // The plain Error assertNoUnmanagedCollisions throws, naming the
        // SECOND member's source path.
        throw new Error(
          `cannot reconcile ${join(project, ".claude", "settings.json")}: settings/go/settings.json would overwrite unmanaged local value at env.FROM_GO (string vs string).`,
        );
      },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.dryRun).toBe(true);
    expect(call.target).toBe("claude-settings");
    // The prospective nextLock contains ALL non-skipped fragment members —
    // not just the members preceding the one under check.
    expect(Object.keys(call.nextLock.items).sort()).toEqual([
      "data/settings/base",
      "data/settings/go",
    ]);
    expect(call.nextManifest?.settings).toEqual(["base", "go"]);
    // Untouched current state flows in as old manifest/lock.
    expect(call.oldLock.items).toEqual({});
    expect(call.manifest.settings).toEqual([]);

    // The error was wrapped and attributed to the offending member only.
    const failures = planFailures(bundlePlan);
    expect(failures.map((m) => m.ref)).toEqual(["settings/go"]);
    expect(failures[0]?.reason).toContain("unmanaged local value");
    expect(
      bundlePlan.members.find((m) => m.ref === "settings/base")?.status,
    ).toBe("install");
  });

  test("clean fragments preflight without failures", async () => {
    const dataRepo = await fragmentDataRepo();
    const project = await mkdtemp(join(tmpdir(), "capshelf-bundle-proj-"));
    const refs = ["settings/base", "settings/go"];
    const bundlePlan = plan({ bundle: bundleOf(refs), master: refs });
    const masterByRef = new Map<string, MasterItem>(
      refs.map((ref) => {
        const [kind, name] = ref.split("/") as [ItemKind, string];
        return [
          ref,
          { kind, name, repoRelPath: ref, path: join(dataRepo, ref) },
        ];
      }),
    );

    await preflightBundleChecks(bundlePlan, {
      project,
      dataRepo,
      manifest: emptyManifest(),
      lock: emptyLock(),
      masterByRef,
    });
    expect(planFailures(bundlePlan)).toEqual([]);
  });
});

describe("executeBundleInstall", () => {
  test("is the skip gate: never invokes the installer for installed members", async () => {
    const refs = ["skills/a", "skills/b"];
    const bundlePlan = plan({
      bundle: bundleOf(refs),
      master: refs,
      projectLock: lockWith("skills/a"),
    });

    const installed: string[] = [];
    const results = await executeBundleInstall(bundlePlan, {
      projectLock: lockWith("skills/a"),
      localLock: emptyLock(),
      scope: "project",
      installItem: async (member) => {
        installed.push(member.ref);
        return { ref: member.ref };
      },
    });

    expect(installed).toEqual(["skills/b"]);
    expect([...results.keys()]).toEqual(["skills/b"]);
    expect(bundlePlan.members.find((m) => m.ref === "skills/a")?.status).toBe(
      "already-installed",
    );
  });

  test("refuses to run with unresolved failures in the plan", async () => {
    const bundlePlan = plan({
      bundle: bundleOf(["skills/gone"]),
      master: [],
    });
    await expect(
      executeBundleInstall(bundlePlan, {
        projectLock: emptyLock(),
        localLock: emptyLock(),
        scope: "project",
        installItem: async () => ({}),
      }),
    ).rejects.toThrow(/unresolved member/);
  });
});
