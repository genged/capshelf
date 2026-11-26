import { existsSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  itemRepoRelPath,
  PLUGIN_MANIFEST_REL,
} from "./master";
import type { CopyDirectoryItemKind, ItemKind } from "./master";
import type { Manifest } from "./manifest";
import { NotFoundError, PreconditionError } from "./errors";
import {
  claudeSkillPath,
  codexSkillPath,
  ensureInstallAliases,
  installedPath,
} from "./installed";
import { assertRepoClean, headSha } from "./git";
import {
  METADATA_SIDECAR,
  parseSidecar,
  printMetadataWarnings,
  readSidecarBytes,
  restoreSidecarBytes,
  writeSidecarProvenance,
} from "./metadata";
import { replaceDirFromFiles, replaceDirFromGitVisibleFiles } from "./sync";
import { findSkillsShSkill, skillsShConflictMessage } from "./external";
import { runtimeWarningsForItem } from "./runtime-warnings";
import { privateDotenvFiles } from "./dotfiles";
import {
  expectedAdoptionPath,
  type AdoptOptions,
  type ItemSnapshot,
  type PromoteResult,
} from "./promote-core";
import {
  adoptionSnapshot,
  namedFilesFromInstalledSnapshot,
} from "./item-snapshot";
import { assertCommittedTreeEqualsCandidate } from "./promote-proof";
import { compareCandidateToCommit, pinItemAtCommit } from "./pin";
import type { PinnedSource } from "./pin";
import { gitTreeSource } from "./item-source";
import { lstatOrNull } from "./fs-utils";
import { assertConfinedSync, dataRepoScope } from "./path-safety";
import {
  CODEX_PROJECTION_ROOTS,
  commitDataRepoMutation,
} from "./marketplace-files";
import {
  hasCodexMarketplace,
  refreshCodexProjection,
} from "./marketplace-integration";
import { removeInstalledTree } from "./mount-points";

export interface AdoptionSource {
  path: string;
  kind: "installed" | "claude-real";
}

export async function adoptIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  opts: AdoptOptions,
): Promise<PromoteResult> {
  if (isFragmentItemKind(kind)) {
    throw new PreconditionError(
      `share for ${kind}/${name} requires --from <path> --to project`,
    );
  }
  if (isCopyTargetFileItemKind(kind)) {
    throw new PreconditionError(
      `share is not implemented for copy-target-file item ${kind}/${name}`,
    );
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no adoption strategy for ${kind}/${name}`);
  }
  // `--adopt` takes ownership from skills.sh so it bypasses this refusal; any
  // other path would give a skill two owners. Checks `kind === "skills"`
  // because skills.sh never installs plugins.
  if (kind === "skills" && opts.allowPreviousOwner !== true) {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not adopting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const adoption = findAdoptionSource(project, kind, name, opts.installMode);
  if (!adoption) {
    throw new NotFoundError(
      `local item does not exist: ${expectedAdoptionPath(project, kind, name, opts.installMode)}`,
    );
  }

  const repoRelPath = itemRepoRelPath(kind, name);
  const dataPath = join(dataRepo, repoRelPath);
  // Recorded rather than refused under `--adopt`, because deciding whether
  // existing upstream content is identical needs the project snapshot taken
  // later.
  const upstreamExists = existsSync(dataPath);
  if (upstreamExists && opts.allowExistingUpstream !== true) {
    throw new PreconditionError(
      `data repo item already exists: ${repoRelPath}`,
    );
  }

  if (installsAtSkillTarget(kind)) {
    assertCanNormalizeAdoptedSkill(project, name, adoption, opts.installMode);
  }
  const adoptionRelPath = relative(project, adoption.path);
  const snapshot = await adoptionSnapshot(
    project,
    adoption.path,
    adoptionRelPath,
    opts.sourceScope ?? "project",
  );
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  const upstreamSidecar = await readSidecarBytes(dataPath);
  const projectionRoots =
    kind === "skills" && hasCodexMarketplace(dataRepo)
      ? [...CODEX_PROJECTION_ROOTS]
      : [];
  const mutateSource = async (): Promise<string[]> => {
    if (snapshot.source === "filesystem") {
      await replaceDirFromFiles(
        adoption.path,
        snapshot.files,
        dataPath,
        dataRepoScope(dataRepo),
      );
    } else {
      await replaceDirFromGitVisibleFiles(
        project,
        adoptionRelPath,
        adoption.path,
        dataPath,
        dataRepoScope(dataRepo),
      );
    }
    const restored = await restoreSidecarBytes(
      dataPath,
      upstreamSidecar,
      dataRepoScope(dataRepo),
    );
    if (!restored) await warnAboutAdoptedSidecar(dataPath, kind, name);
    // Written inside the mutation so provenance lands in the same commit, not
    // as an uncommitted change. The sidecar is excluded from the pin, so
    // identity is unchanged and the commit proof still compares the same two
    // trees.
    if (opts.provenance) {
      await writeSidecarProvenance(
        dataPath,
        opts.provenance,
        dataRepoScope(dataRepo),
      );
    }
    if (kind === "skills") await refreshCodexProjection(dataRepo);
    // Rewritten provenance makes the sidecar new content to publish, not a file
    // kept in place.
    return restored && !opts.provenance
      ? [`${repoRelPath}/${METADATA_SIDECAR}`]
      : [];
  };
  // Captured from the project before the copy. The bytes are held so Git ids
  // can be computed after the commit, using the object-name width of the
  // committed tree.
  const projectSnapshot = await namedFilesFromInstalledSnapshot(snapshot);
  // Runs before any data-repo write; the commit proof refuses trees differing
  // from `projectSnapshot`, so checking it binds the commit.
  await opts.checkCandidate?.({
    files: projectSnapshot,
    snapshot,
    path: adoption.path,
  });

  // The data repo may already hold the item from an interrupted run or another
  // project; identical content is not an error, commits nothing, and the caller
  // still releases the previous owner.
  if (upstreamExists) {
    await assertRepoClean(dataRepo);
    const existingPin = await pinItemAtCommit(
      gitTreeSource({ repo: dataRepo, kind, name, commit: "HEAD" }),
      kind,
      name,
    );
    const mismatches = compareCandidateToCommit(
      projectSnapshot,
      existingPin.entries,
    );
    if (mismatches.length > 0) {
      throw new PreconditionError(
        `data repo already has ${repoRelPath} with different content`,
        {
          hint:
            "Capshelf kept the previous owner; ownership was kept\n" +
            `  make ${repoRelPath} match the installed skill or rename the canonical item, then retry --adopt`,
        },
      );
    }
    if (installsAtSkillTarget(kind)) {
      await normalizeAdoptedSkill(
        project,
        kind,
        name,
        adoption,
        opts.installMode,
        snapshot,
      );
    }
    const identicalWarnings = runtimeWarningsForItem(project, kind, name);
    return {
      source: "data",
      kind,
      name,
      action: "already-upstream",
      sha: existingPin.sourcePinDigest,
      sourceCommit: existingPin.sourceCommit,
      pin: existingPin,
      committed: false,
      ...(identicalWarnings.length > 0 && {
        runtimeWarnings: identicalWarnings,
      }),
      ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
    };
  }

  const expectedHead = await headSha(dataRepo).catch(() => null);
  let pin: PinnedSource | undefined;
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead,
    ownedRoots: [repoRelPath, ...projectionRoots],
    message: opts.message ?? `capshelf: ${kind}/${name}`,
    mutate: mutateSource,
    verify: async (commit) => {
      pin = await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind,
        name,
        commit,
        candidateFiles: projectSnapshot,
      });
    },
  });
  if (!pin) throw new Error(`expected a verified pin for ${kind}/${name}`);

  if (installsAtSkillTarget(kind)) {
    await normalizeAdoptedSkill(
      project,
      kind,
      name,
      adoption,
      opts.installMode,
      snapshot,
    );
  }
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "created",
    sha: pin.sourcePinDigest,
    sourceCommit,
    pin,
    committed: true,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

/**
 * The sidecar is never materialized, so committing one silently would surprise
 * data-repo owners; a malformed one warns and adoption continues.
 */
async function warnAboutAdoptedSidecar(
  dataPath: string,
  kind: CopyDirectoryItemKind,
  name: string,
): Promise<void> {
  const bytes = await readSidecarBytes(dataPath);
  if (bytes === null) return;
  console.error(
    `⚠ project copy contains ${METADATA_SIDECAR} — committed to data repo`,
  );
  printMetadataWarnings(
    parseSidecar(bytes.toString("utf-8"), `${kind}/${name}`, name),
  );
}

function assertCanNormalizeAdoptedSkill(
  project: string,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
): void {
  if (mode !== "codex-compatible") return;
  if (adoption.kind === "claude-real") return;

  const managedPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new PreconditionError(
      `compatibility path already exists but is not a symlink: ${claudePath}`,
    );
  }

  const target = resolve(dirname(claudePath), readlinkSync(claudePath));
  if (resolve(target) !== resolve(managedPath)) {
    throw new PreconditionError(
      `compatibility symlink points somewhere else: ${claudePath} -> ${target}\n` +
        `  expected it to point at: ${managedPath}`,
    );
  }
}

/**
 * Exported so the share picker's scanned rows point at exactly the directory
 * the named command adopts.
 */
export function findAdoptionSource(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  mode: Manifest["installMode"],
): AdoptionSource | null {
  if (kind === "pi-extensions") {
    return existingItemDir(
      project,
      installedPath(project, kind, name, mode),
      "installed",
      kind,
    );
  }

  if (mode === "claude-only") {
    const path = claudeSkillPath(project, name);
    return existingItemDir(project, path, "installed", kind);
  }

  const codexPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const codex = existingItemDir(project, codexPath, "installed", kind);
  const claudeStat = lstatOrNull(claudePath);

  if (codex && claudeStat && !claudeStat.isSymbolicLink()) {
    throw new PreconditionError(
      `ambiguous local paths for ${kind}/${name}: ${codexPath} and ${claudePath}\n` +
        "  remove one path or make .claude/skills point at .agents/skills before adopting",
    );
  }
  if (codex) return codex;

  if (claudeStat?.isSymbolicLink()) {
    return existingItemDir(
      project,
      installedPath(project, kind, name, mode),
      "installed",
      kind,
    );
  }
  if (claudeStat)
    return existingItemDir(project, claudePath, "claude-real", kind);
  return null;
}

function existingItemDir(
  project: string,
  path: string,
  sourceKind: AdoptionSource["kind"],
  kind: CopyDirectoryItemKind,
): AdoptionSource | null {
  // A symlink leaving the project must not publish what lies outside it.
  assertConfinedSync(project, path);
  const stat = lstatOrNull(path);
  if (!stat) return null;
  if (!stat.isDirectory()) {
    throw new PreconditionError(
      `local ${kind} path is not a directory: ${path}`,
    );
  }
  if (kind === "skills" && !existsSync(join(path, "SKILL.md"))) {
    throw new PreconditionError(`local skill is missing SKILL.md: ${path}`);
  }
  if (
    kind === "plugins" &&
    !existsSync(join(path, ...PLUGIN_MANIFEST_REL.split("/")))
  ) {
    throw new PreconditionError(
      `local plugin is missing ${PLUGIN_MANIFEST_REL}: ${path}`,
    );
  }
  if (kind === "pi-extensions" && !existsSync(join(path, "index.ts"))) {
    throw new PreconditionError(
      `local pi extension is missing index.ts: ${path}`,
    );
  }
  return { path, kind: sourceKind };
}

async function normalizeAdoptedSkill(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
  snapshot: ItemSnapshot,
): Promise<void> {
  if (mode !== "codex-compatible") return;

  if (adoption.kind === "claude-real") {
    const managedPath = codexSkillPath(project, name);
    if (snapshot.source === "filesystem") {
      await replaceDirFromFiles(adoption.path, snapshot.files, managedPath, {
        root: project,
      });
    } else {
      const adoptionRelPath = relative(project, adoption.path);
      await replaceDirFromGitVisibleFiles(
        project,
        adoptionRelPath,
        adoption.path,
        managedPath,
        { root: project },
      );
    }
    // A mounted volume in the adopted folder stays where it is.
    await removeInstalledTree(adoption.path, { root: project });
  }
  await ensureInstallAliases(project, kind, name, mode);
}
