import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homeRelative, projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  dataKey,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { Lock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import type { ItemKind } from "../master";
import { NotFoundError, PreconditionError } from "../errors";
import {
  assertIsGitRepo,
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitInRepo,
  lastTouchingContentCommit,
  originRemoteUrl,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { globalOpts } from "../global-options";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { assertLocalScopeSupported } from "../local-config";
import { readSidecarBytes, restoreSidecarBytes } from "../metadata";
import { replaceDirFromFiles, replaceDirFromGitVisibleFiles } from "../sync";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import { printPrivateDotenvWarnings, privateDotenvFiles } from "../dotfiles";
import {
  allCanonicalFragmentRelPaths,
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  isFragmentKind,
  parseFragmentSourceText,
  shaOfFragmentItem,
  shaOfFragmentItemAtCommit,
  touchedFragmentTargetsForItem,
} from "../fragments";
import { upstreamFactsForItem } from "../upstream-facts";
import {
  addToManifest,
  dataEntryOrThrow,
  refDisplay,
  type PromoteResult,
  type Scope,
} from "../promote-core";
import { installedSnapshot } from "../item-snapshot";

interface PromoteOptions {
  message?: string;
  json?: boolean;
  local?: boolean;
  staleOk?: boolean;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
  staleOk?: boolean;
}

export function registerPromote(program: Command): void {
  program
    .command("promote <item>")
    .description(
      "push edits for an already-tracked data item into the data repo and bump the lock",
    )
    .option("--local", "promote a local-scope item")
    .option(
      "--stale-ok",
      "intentionally overwrite data-repo content newer than this project's lock",
    )
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: PromoteOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(
          `"${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
        );
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      let result: PromoteResult;
      let saveProject = false;
      let saveLocal = false;
      if (opts.local) {
        result = await promoteLocalTracked(
          project,
          dataRepo,
          localLock,
          ref,
          opts,
        );
        saveLocal = true;
      } else {
        result = await promoteProjectTracked(
          project,
          dataRepo,
          manifest,
          lock,
          localLock,
          ref,
          opts,
        );
        saveProject = true;
      }

      if (saveProject) {
        await saveManifest(project, manifest);
        await saveLock(project, lock);
      }
      if (saveLocal) {
        await saveLocalLock(project, localLock);
      }

      const origin = await originRemoteUrl(dataRepo);
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ...result, dataRepo, dataRepoHasOrigin: origin !== null },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `✓ ${result.action} data/${result.kind}/${result.name} @ ${result.sha}`,
      );
      console.log(`  source commit: ${result.sourceCommit}`);
      printRuntimeWarnings(result.runtimeWarnings);
      printPrivateDotenvWarnings(result.privateDotenvWarnings);
      if (result.committed) {
        console.log("");
        console.log("committed to local data repo:");
        console.log(`  ${homeRelative(dataRepo)}`);
        if (origin !== null) {
          console.log("");
          console.log("to share upstream:");
          console.log(`  cd ${homeRelative(dataRepo)}`);
          console.log("  git push");
        }
      }
    });
}

async function promoteProjectTracked(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  projectLock: Lock,
  localLock: Lock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(projectLock, ref, "data");
  if (!key) {
    const localKey = lockKeyForRef(localLock, ref, "data");
    if (localKey) {
      const parsed = parseLockKey(localKey);
      const display = `${parsed.kind}/${parsed.name}`;
      throw new NotFoundError(
        `not tracked in project scope: ${display}\n` +
          `  found in local scope; run: capshelf promote ${display} --local`,
      );
    }
    return await rejectUntrackedPromote(project, projectLock, ref);
  }

  const parsed = parseLockKey(key);
  if (isFragmentKind(parsed.kind)) {
    const result = await promoteFragmentSource(
      project,
      dataRepo,
      manifest,
      projectLock,
      parsed.kind,
      parsed.name,
      opts,
    );
    addToManifest(manifest, parsed.kind, parsed.name);
    return result;
  }

  const result = await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    projectLock,
    opts,
  );
  addToManifest(manifest, parsed.kind, parsed.name);
  return result;
}

async function promoteLocalTracked(
  project: string,
  dataRepo: string,
  localLock: Lock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(localLock, ref, "data");
  if (!key) {
    if (ref.kind === undefined || ref.kind === "skills") {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
        );
      }
    }
    throw new NotFoundError(`not tracked in local scope: ${refDisplay(ref)}`);
  }

  const parsed = parseLockKey(key);
  assertLocalScopeSupported(parsed.kind, parsed.name, "promote");
  return await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    localLock,
    { ...opts, scope: "local" },
  );
}

async function rejectUntrackedPromote(
  project: string,
  lock: Lock,
  ref: ReturnType<typeof parseItemRef>,
): Promise<never> {
  if (ref.kind === undefined || ref.kind === "skills") {
    const external = await findSkillsShSkill(project, ref.name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }
  const systemKey = lockKeyForRef(lock, ref, "system");
  if (systemKey) {
    throw new PreconditionError(
      `${ref.name} is a system item — submit a PR to the capshelf repo instead`,
    );
  }
  const display = refDisplay(ref);
  const adoptHint =
    ref.kind === undefined || ref.kind === "skills"
      ? `\n  to adopt a local-only skill into the data repo, run: capshelf share ${display} --to project`
      : "";
  throw new NotFoundError(
    `not tracked in this project: ${display}${adoptHint}`,
  );
}

export async function promoteFragmentSource(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  kind: Exclude<ItemKind, "skills">,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);
  const canonicalPaths = allCanonicalFragmentRelPaths(kind, name);
  // Throws a PreconditionError when the data repo has no canonical source
  // files (the only expected empty case); letting it surface means genuine
  // git/fs failures propagate instead of being masked as "no source files."
  const existingSources = await currentFragmentSourcesForItem(
    dataRepo,
    kind,
    name,
  );

  await assertRepoCleanOutsidePaths(dataRepo, canonicalPaths);
  let dirty = false;
  const commitPaths: string[] = [];
  for (const relPath of canonicalPaths) {
    const pathDirty =
      (await statusPorcelain(dataRepo, relPath)).trim().length > 0;
    if (pathDirty || existsSync(join(dataRepo, ...relPath.split("/")))) {
      commitPaths.push(relPath);
    }
    dirty = dirty || pathDirty;
  }
  const currentSha = await shaOfFragmentItem(dataRepo, kind, name);
  if (!dirty) {
    if (currentSha === entry.sha) {
      return {
        source: "data",
        kind,
        name,
        action: "already-current",
        sha: currentSha,
        sourceCommit: entry.sourceCommit,
        committed: false,
      };
    }
    // Unchanged and not bypassable by --stale-ok: in this branch there is
    // nothing local to promote, the only correct action is update.
    throw new PreconditionError(
      `${kind}/${name} has committed source changes not in this project lock; run capshelf update ${kind}/${name}`,
    );
  }

  // Stale gate for the dirty-commit path: compare the canonical sources as
  // committed at HEAD (ignoring the dirty worktree edits about to be
  // committed) against the lock. A difference means upstream advanced past
  // the lock; committing would silently fold that advance into a lock bump
  // the user never reviewed.
  const headCommittedSha = await shaOfFragmentItemAtCommit(
    dataRepo,
    kind,
    name,
    "HEAD",
  );
  let staleOverride = false;
  if (headCommittedSha !== entry.sha) {
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sha,
        sourceCommit: entry.sourceCommit,
        upstreamSha: headCommittedSha,
        logPathspec: canonicalPaths.join(" "),
      });
    }
    staleOverride = true;
  }

  for (const source of existingSources) {
    parseFragmentSourceText(
      source,
      await readFile(join(dataRepo, ...source.relPath.split("/")), "utf-8"),
    );
  }

  const oldLock = structuredClone(lock);
  const sourceCommit = await commitInRepo(
    dataRepo,
    commitPaths,
    opts.message ?? `capshelf: ${kind}/${name}`,
  );
  const sha = await shaOfFragmentItem(dataRepo, kind, name);
  const nextEntry = {
    source: "data" as const,
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
    ...(entry.label !== undefined && { label: entry.label }),
  };
  lock.items[key] = nextEntry;

  for (const target of await touchedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
  )) {
    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock: lock,
      target,
    });
  }

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: true,
    ...(staleOverride && { staleOverride: true as const }),
  };
}

export async function syncTrackedIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  lock: Lock,
  opts: SyncOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);

  if (isFragmentKind(kind)) {
    throw new PreconditionError(
      `promote for ${kind}/${name} must use project-scope fragment source files`,
    );
  }

  if (kind === "skills") {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const repoRelPath = `${kind}/${name}`;
  if (!existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo does not have ${repoRelPath}; run "capshelf share ${kind}/${name}" instead`,
    );
  }

  const snapshot = await installedSnapshot(
    project,
    kind,
    name,
    opts.scope ?? "project",
  );
  if (!snapshot) {
    throw new Error(
      `installed files are missing: ${installedPath(project, kind, name)}`,
    );
  }
  const { localPath, sha } = snapshot;
  if (sha === entry.sha) {
    // Guard-free no-op by design: local content matches the lock, there is
    // nothing to write. If upstream has advanced past the lock here, that is
    // update_available territory and surfacing it is status's job.
    const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
    return {
      source: "data",
      kind,
      name,
      action: "already-current",
      sha,
      sourceCommit: entry.sourceCommit,
      committed: false,
      ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    };
  }

  // Stale guard: protects data-repo writes. Runs before anything is written
  // or committed, covering both the dirty-commit path and the
  // not-dirty-but-changed repin path below. Shares the upstream-facts
  // computation with status so the state machine and this gate can never
  // disagree.
  const upstream = await upstreamFactsForItem(dataRepo, kind, name);
  if (upstream.upstreamDirty) {
    // Not bypassable by --stale-ok: uncommitted upstream edits have no
    // commit provenance; promoting over them would either destroy them or
    // fold unknown content into the promote commit.
    throw new PreconditionError(
      `not promoting ${kind}/${name} — the data repo copy has uncommitted changes.\n\n` +
        "  inspect them first:\n" +
        `    git -C ${homeRelative(dataRepo)} status --short -- ${repoRelPath}\n` +
        "  then commit or discard them in the data repo and retry.",
    );
  }
  let staleOverride = false;
  if (upstream.upstreamSha !== null && upstream.upstreamSha !== entry.sha) {
    if (upstream.upstreamSha === sha) {
      // Convergence short-circuit: the project's edited content is
      // byte-identical to what upstream already has (e.g. a teammate
      // promoted the same fix first). Metadata-only lock repin; commit
      // nothing, touch nothing in the data repo.
      const sourceCommit = await lastTouchingContentCommit(
        dataRepo,
        repoRelPath,
      );
      lock.items[key] = {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
        ...(entry.label !== undefined && { label: entry.label }),
      };
      const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
      return {
        source: "data",
        kind,
        name,
        action: "already-upstream",
        sha,
        sourceCommit,
        committed: false,
        ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
      };
    }
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sha,
        sourceCommit: entry.sourceCommit,
        upstreamSha: upstream.upstreamSha,
        logPathspec: repoRelPath,
      });
    }
    staleOverride = true;
  }

  await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
  const localRelPath = relative(project, localPath);
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  // The directory replace removes the data-repo .capshelf.yml wholesale, but
  // projects never receive the sidecar: cache it and restore it afterwards
  // unless the project copy supplied its own (the project's wins).
  const dataDir = join(dataRepo, repoRelPath);
  const upstreamSidecar = await readSidecarBytes(dataDir);
  if (snapshot.source === "filesystem") {
    await replaceDirFromFiles(localPath, snapshot.files, dataDir);
  } else {
    await replaceDirFromGitVisibleFiles(
      project,
      localRelPath,
      localPath,
      dataDir,
    );
  }
  await restoreSidecarBytes(dataDir, upstreamSidecar);

  const dirty =
    (await statusPorcelain(dataRepo, repoRelPath)).trim().length > 0;
  const sourceCommit = dirty
    ? await commitInRepo(
        dataRepo,
        [repoRelPath],
        opts.message ?? `capshelf: ${kind}/${name}`,
      )
    : // The not-dirty re-pin must stay sidecar-blind: re-pinning after a
      // metadata-only upstream commit keeps the old sourceCommit. The dirty
      // branch usually commits content, but with a stale lock sha plus a
      // sidecar-only difference the promote commit can be sidecar-only; the
      // recorded sourceCommit then names that commit, which is harmless —
      // `git show` at it still yields the locked content.
      await lastTouchingContentCommit(dataRepo, repoRelPath);

  lock.items[key] = {
    source: "data",
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
    ...(entry.label !== undefined && { label: entry.label }),
  };
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: dirty,
    ...(staleOverride && { staleOverride: true as const }),
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

function stalePromoteError(input: {
  dataRepo: string;
  kind: ItemKind;
  name: string;
  lockedSha: string;
  sourceCommit: string;
  upstreamSha: string;
  logPathspec: string;
}): PreconditionError {
  const item = `${input.kind}/${input.name}`;
  const shortCommit = input.sourceCommit.slice(0, 7);
  const repo = homeRelative(input.dataRepo);
  return new PreconditionError(
    `${item} changed in the data repo since this project last updated; promoting would overwrite the newer upstream version.\n\n` +
      `  locked:   ${input.lockedSha}  (sourceCommit ${shortCommit})\n` +
      `  upstream: ${input.upstreamSha}  (data repo HEAD)\n\n` +
      "  inspect before deciding:\n" +
      `    capshelf status ${item} --diff\n` +
      `    git -C ${repo} log --oneline ${shortCommit}..HEAD -- ${input.logPathspec}\n\n` +
      "  to take the upstream version and redo your edit on top of it\n" +
      "  (your current edits stay recoverable in this project's own git diff):\n" +
      `    capshelf update ${item}\n\n` +
      "  to overwrite upstream with this project's version on purpose:\n" +
      `    capshelf promote ${item} --stale-ok -m "..."`,
  );
}
