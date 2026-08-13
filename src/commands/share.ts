import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWriteFile, lstatOrNull } from "../fs-utils";
import { basename, dirname, join, relative } from "node:path";
import { homeRelative, projectRoot } from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { loadManifest, saveManifest, type Manifest } from "../manifest";
import { addManifestName } from "../manifest";
import {
  assertLockV4,
  createDataLockEntry,
  dataKey,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntryV4, Lock } from "../lock";
import { pinItemAtCommit } from "../pin";
import { assertCommittedTreeEqualsProject } from "../promote-proof";
import { isSystemItemName } from "../bundled";
import { isCopyDirectoryItemKind, itemRepoRelPath } from "../master";
import type { FragmentItemKind } from "../master";
import { assertRepoClean, commitInRepo, originRemoteUrl } from "../git";
import { PreconditionError } from "../errors";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import {
  addLocalConfigName,
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  removeLocalConfigName,
  removeLocalExcludes,
  saveLocalConfig,
} from "../local-config";
import { addToManifest } from "../promote-core";
import { adoptIntoDataRepo } from "../data-repo-adopt";
import { printPrivateDotenvWarnings } from "../dotfiles";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import {
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  fragmentOutputSpec,
  fragmentSourceCandidates,
  fragmentValuesForTarget,
  isFragmentKind,
  parseFragmentSourceText,
  sourceMatchesCliTarget,
  sourceTargetForCli,
  type FragmentSource,
  type FragmentValue,
} from "../fragments";
import {
  extractPickedFragment,
  mcpServerContainerKey,
  unmanagedRemainder,
} from "../fragment-pick";
import {
  isPlainConfigObject,
  mergeConfigObjects,
  type ConfigObject,
} from "../config-values";
import { captureCommittedItemNeeds } from "../metadata";
import {
  isSubagentTarget,
  subagentSourceCandidates,
  validateSubagentSource,
  type SubagentSource,
} from "../subagents";

type ShareScope = "project" | "local";

interface ShareOptions {
  to?: string;
  from?: string;
  pick?: string[];
  target?: string;
  message?: string;
  json?: boolean;
}

export function registerShare(program: Command): void {
  program
    .command("share <item>")
    .description("adopt an on-disk item into the data repo and track it here")
    .option(
      "--to <scope>",
      "resulting scope: local or project (default: local for skills, project for Pi extensions, subagents, and fragments)",
    )
    .option("--from <path>", "source file for fragment or subagent items")
    .option(
      "--pick <path>",
      "extract an unmanaged value from the generated output instead of --from; repeatable (fragment items; mcp picks accept bare server names and default to the item name)",
      collectPick,
    )
    .option(
      "--target <target>",
      "runtime target for mcp or subagent items: claude or codex",
    )
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .addHelpText(
      "after",
      "\nRecovery: if the data-repo commit succeeds but local metadata is interrupted, rerun add <item> or add --local <item>.",
    )
    .action(async (itemRef: string, opts: ShareOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(
          `"${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
        );
      }

      const kind = ref.kind ?? "skills";
      const name = ref.name;
      const scope = parseShareScope(
        opts.to,
        kind === "skills" ? "local" : "project",
      );
      if (isFragmentKind(kind)) {
        await shareFragment(kind, name, scope, opts, cmd);
        return;
      }
      if (kind === "subagents") {
        await shareSubagent(name, scope, opts, cmd);
        return;
      }
      if (!isCopyDirectoryItemKind(kind)) {
        throw new Error(`no share strategy for ${kind}/${name}`);
      }
      if (opts.pick !== undefined) {
        throw new PreconditionError(
          "--pick is only valid for fragment items (settings, mcp, codex-config)",
        );
      }

      if (scope === "local") {
        assertLocalScopeSupported(kind, name, "share");
      }

      const { project, manifest, projectLock, localLock } =
        await loadProjectContext({ cmd });
      const localConfig = await loadLocalConfig(project);
      const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);

      const repoRelPath = itemRepoRelPath(kind, name);
      if (existsSync(join(dataRepo, repoRelPath))) {
        throw new PreconditionError(
          `data repo already has ${repoRelPath}; use promote to push edits, or move to change scope`,
        );
      }

      const key = dataKey(kind, name);
      const projectKey = lockKeyForRef(projectLock, { kind, name }, "data");
      const localKey = lockKeyForRef(localLock, { kind, name }, "data");
      if (projectKey) {
        throw new PreconditionError(
          `already tracked in project scope: ${kind}/${name}`,
        );
      }
      if (scope === "local") {
        if (!localConfig) {
          throw new PreconditionError(
            "no local manifest exists; run capshelf init or capshelf set-data first",
          );
        }
        await assertLocalInstallPathsUntracked(project, kind, name);
      }

      const adopted = await adoptIntoDataRepo(project, dataRepo, kind, name, {
        installMode: manifest.installMode,
        message: opts.message,
        ...((scope === "local" || localKey) && {
          sourceScope: "local" as const,
        }),
      });

      const snapshot = await captureCommittedItemNeeds(dataRepo, {
        kind,
        name,
      });
      if (!adopted.pin) {
        throw new Error(`expected a verified pin for ${kind}/${name}`);
      }
      const entry = createDataLockEntry({ pin: adopted.pin, ...snapshot });
      const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
      const writableProjectLock = assertLockV4(projectLock, "capshelf share");
      const writableLocalLock = assertLockV4(localLock, "capshelf share");
      let localChanged = false;
      if (scope === "project") {
        addToManifest(manifest, kind, name);
        writableProjectLock.items[key] = preserveLabel(entry, localLock, key);
        if (localKey) {
          delete writableLocalLock.items[key];
          if (localConfig) {
            removeLocalConfigName(localConfig, kind, name);
          }
          await removeLocalExcludes(project, kind, name);
          localChanged = true;
        }
        await saveManifest(project, manifest);
        await saveLock(project, writableProjectLock);
        if (localChanged) {
          await saveLocalLock(project, writableLocalLock);
          if (localConfig) await saveLocalConfig(project, localConfig);
        }
      } else {
        if (!localConfig) throw new Error("expected local manifest");
        addLocalConfigName(localConfig, kind, name);
        writableLocalLock.items[key] = preserveLabel(entry, localLock, key);
        await ensureLocalExcludes(project, kind, name);
        await saveLocalConfig(project, localConfig);
        await saveLocalLock(project, writableLocalLock);
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              verb: "share",
              kind,
              name,
              scope,
              action: adopted.action,
              sha: adopted.sha,
              sourceCommit: adopted.sourceCommit,
              committed: adopted.committed,
              needs: snapshot.needs,
              ...(runtimeWarnings.length > 0 && {
                runtimeWarnings,
              }),
              ...(adopted.privateDotenvWarnings && {
                privateDotenvWarnings: adopted.privateDotenvWarnings,
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✓ shared ${scope}/data/${kind}/${name} @ ${adopted.sha}`);
      console.log(`  source commit: ${adopted.sourceCommit}`);
      printRuntimeWarnings(runtimeWarnings);
      printPrivateDotenvWarnings(adopted.privateDotenvWarnings);
      await printShareUpstreamGuidance(dataRepo);
    });
}

async function shareSubagent(
  name: string,
  scope: ShareScope,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (scope !== "project") {
    assertLocalScopeSupported("subagents", name, "share");
  }
  if (opts.pick !== undefined) {
    throw new PreconditionError("--pick is not supported for subagents");
  }
  if (opts.from && !opts.target) {
    throw new PreconditionError(
      `share subagents/${name} --from requires --target claude or --target codex`,
    );
  }
  if (opts.target !== undefined && !isSubagentTarget(opts.target)) {
    throw new PreconditionError(
      `invalid target "${opts.target}"; must be claude or codex`,
    );
  }

  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd });
  const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);
  await assertRepoClean(dataRepo);
  const key = dataKey("subagents", name);
  if (projectLock.items[key] || localLock.items[key]) {
    throw new PreconditionError(
      `already tracked in this project: subagents/${name}`,
    );
  }

  const allCandidates = subagentSourceCandidates(project, name);
  for (const candidate of allCandidates) {
    if (existsSync(join(dataRepo, ...candidate.relPath.split("/")))) {
      throw new PreconditionError(
        `data repo already has ${candidate.relPath}; use promote to push edits`,
      );
    }
  }
  const candidates = allCandidates.filter(
    (candidate) =>
      opts.target === undefined || candidate.target === opts.target,
  );
  const pending: Array<{ source: SubagentSource; raw: string }> = [];
  if (opts.from) {
    pending.push({
      source: candidates[0]!,
      raw: await readFile(opts.from, "utf-8"),
    });
  } else {
    for (const source of candidates) {
      const stat = lstatOrNull(source.outputPath);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PreconditionError(
          `cannot share subagents/${name} — runtime target is not a regular file: ${source.outputPath}`,
        );
      }
      pending.push({
        source,
        raw: await readFile(source.outputPath, "utf-8"),
      });
    }
  }
  if (pending.length === 0) {
    throw new PreconditionError(
      `share subagents/${name} found no unmanaged target outputs\n  expected ${candidates.map((source) => relative(project, source.outputPath)).join(" or ")}`,
    );
  }
  for (const { source, raw } of pending) {
    for (const warning of validateSubagentSource(source.target, name, raw)
      .warnings) {
      console.error(`⚠ ${warning}`);
    }
  }
  for (const { source, raw } of pending) {
    const path = join(dataRepo, ...source.relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, raw);
  }
  const sourceCommit = await commitInRepo(
    dataRepo,
    pending.map(({ source }) => source.relPath),
    opts.message ?? `capshelf: subagents/${name}`,
  );
  // PIN-11: the candidate was generated from the project's own files, so what
  // the commit holds must equal what was read. `pending` is `A`.
  const pin = await assertCommittedTreeEqualsProject({
    dataRepo,
    kind: "subagents",
    name,
    commit: sourceCommit,
    projectFiles: pending.map(({ source, raw }) => ({
      path: basename(source.relPath),
      content: Buffer.from(raw, "utf-8"),
      mode: "100644" as const,
    })),
  });
  const sha = pin.sourcePinDigest;
  const snapshot = await captureCommittedItemNeeds(dataRepo, {
    kind: "subagents",
    name,
  });
  addManifestName(manifest, "subagents", name);
  const writableProjectLock = assertLockV4(projectLock, "capshelf share");
  writableProjectLock.items[key] = createDataLockEntry({ pin, ...snapshot });
  await saveManifest(project, manifest);
  await saveLock(project, writableProjectLock);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind: "subagents",
          name,
          scope: "project",
          action: "created",
          sha,
          sourceCommit,
          committed: true,
          sources: pending.map(({ source }) => ({
            target: source.target,
            sourcePath: source.relPath,
            outputPath: source.outputPath,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`✓ shared project/data/subagents/${name} @ ${sha}`);
  console.log(`  source commit: ${sourceCommit}`);
  for (const { source } of pending) console.log(`  ${source.relPath}`);
  await printShareUpstreamGuidance(dataRepo);
}

async function shareFragment(
  kind: FragmentItemKind,
  name: string,
  scope: ShareScope,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (scope !== "project") {
    assertLocalScopeSupported(kind, name, "share");
  }
  const explicitPicks = opts.pick ?? [];
  if (opts.from && explicitPicks.length > 0) {
    throw new PreconditionError(
      `share ${kind}/${name} accepts either --from or --pick, not both`,
    );
  }
  if (!opts.from && explicitPicks.length === 0 && kind !== "mcp") {
    throw new PreconditionError(
      `share ${kind}/${name} requires --from <path> or --pick <path>; managed values in generated outputs cannot be converted back to one fragment safely`,
    );
  }
  // For mcp items the item name doubles as the default server pick.
  const picks =
    !opts.from && explicitPicks.length === 0 ? [name] : explicitPicks;
  const cliTarget = sourceTargetForCli(opts.target);
  if (kind !== "mcp" && cliTarget !== null) {
    throw new PreconditionError("--target is only valid for mcp fragments");
  }
  if (kind === "mcp" && cliTarget === null && opts.from) {
    throw new PreconditionError(
      `share mcp/${name} --from requires --target claude or --target codex`,
    );
  }

  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  const oldManifest = structuredClone(manifest);
  const oldLock = structuredClone(projectLock);
  const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);
  await assertRepoClean(dataRepo);

  const candidates = fragmentSourceCandidates(kind, name).filter((candidate) =>
    sourceMatchesCliTarget(candidate, cliTarget),
  );
  const [firstCandidate] = candidates;
  if (!firstCandidate) {
    throw new PreconditionError(
      `no canonical source target for ${kind}/${name}`,
    );
  }
  const pending = opts.from
    ? [{ source: firstCandidate, raw: await readFile(opts.from, "utf-8") }]
    : await extractPickedSources({
        project,
        dataRepo,
        manifest,
        lock: projectLock,
        name,
        candidates,
        picks,
        autoTarget: kind === "mcp" && cliTarget === null,
      });

  // Validate every source before writing any, so a bad target leaves the
  // data repo untouched.
  for (const { source, raw } of pending) {
    const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
    if (existsSync(canonicalPath)) {
      throw new PreconditionError(
        `fragment source already exists: ${source.relPath}`,
      );
    }
    parseFragmentSourceText(source, raw);
  }
  for (const { source, raw } of pending) {
    const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
    await mkdir(dirname(canonicalPath), { recursive: true });
    await atomicWriteFile(canonicalPath, raw);
  }
  const sourceCommit = await commitInRepo(
    dataRepo,
    pending.map(({ source }) => source.relPath),
    opts.message ?? `capshelf: ${kind}/${name}`,
  );
  // Fragments have no project snapshot: `share --from` writes the user's own
  // file into the data repo and commits it in place, so PIN-11's `A == B` has
  // no `A` to compare. The pin still comes from the committed tree.
  const pin = await pinItemAtCommit(dataRepo, kind, name, sourceCommit);
  const sha = pin.sourcePinDigest;

  addManifestName(manifest, kind, name);
  const writableProjectLock = assertLockV4(projectLock, "capshelf share");
  writableProjectLock.items[dataKey(kind, name)] = createDataLockEntry({
    pin,
    ...(await captureCommittedItemNeeds(dataRepo, { kind, name })),
  });

  const sources = await currentFragmentSourcesForItem(dataRepo, kind, name);
  const outputResults: Awaited<ReturnType<typeof applyFragmentOutput>>[] = [];
  for (const target of [
    ...new Set(sources.map((fragmentSource) => fragmentSource.target)),
  ]) {
    outputResults.push(
      await applyFragmentOutput({
        project,
        dataRepo,
        manifest,
        oldManifest,
        nextManifest: manifest,
        oldLock,
        nextLock: projectLock,
        target,
      }),
    );
  }

  await saveManifest(project, manifest);
  await saveLock(project, writableProjectLock);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind,
          name,
          scope: "project",
          action: "created",
          sha,
          sourceCommit,
          committed: true,
          ...(picks.length > 0 && { picks }),
          sources: sources.map((fragmentSource) => ({
            target: fragmentSource.sourceTarget ?? fragmentSource.target,
            sourcePath: fragmentSource.relPath,
            outputPath: fragmentOutputPath(project, fragmentSource.target),
            outputAction:
              outputResults.find(
                (result) => result.target === fragmentSource.target,
              )?.action ?? "already-current",
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`✓ shared project/data/${kind}/${name} @ ${sha}`);
  console.log(`  source commit: ${sourceCommit}`);
  for (const fragmentSource of sources) {
    console.log(`  ${fragmentSource.relPath}`);
  }
  await printShareUpstreamGuidance(dataRepo);
}

async function printShareUpstreamGuidance(dataRepo: string): Promise<void> {
  const origin = await originRemoteUrl(dataRepo);
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

function collectPick(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

interface PendingFragmentSource {
  source: FragmentSource;
  raw: string;
}

interface PickExtractionOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  name: string;
  candidates: FragmentSource[];
  picks: string[];
  autoTarget: boolean;
}

async function extractPickedSources(
  opts: PickExtractionOptions,
): Promise<PendingFragmentSource[]> {
  if (!opts.autoTarget) {
    const source = opts.candidates[0] as FragmentSource;
    const remainder = await loadOutputRemainder(opts, source);
    if (remainder === null) {
      throw new PreconditionError(
        `--pick requires ${outputLabelFor(opts.project, source)} to exist; nothing to extract from`,
      );
    }
    return [{ source, raw: extractFromRemainder(remainder, opts.picks) }];
  }

  // mcp with no --target: share from every output that contains the picks.
  const pending: PendingFragmentSource[] = [];
  const failures: string[] = [];
  for (const source of opts.candidates) {
    const remainder = await loadOutputRemainder(opts, source);
    if (remainder === null) {
      failures.push(`${outputLabelFor(opts.project, source)} does not exist`);
      continue;
    }
    try {
      pending.push({
        source,
        raw: extractFromRemainder(remainder, opts.picks),
      });
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw err;
      const names = unmanagedServerNames(remainder);
      failures.push(
        names.length > 0
          ? `${err.message} (unmanaged servers: ${names.join(", ")})`
          : err.message,
      );
    }
  }
  if (pending.length === 0) {
    throw new PreconditionError(
      [
        `share mcp/${opts.name} found no unmanaged server to extract`,
        ...failures.map((failure) => `  ${failure}`),
      ].join("\n"),
    );
  }
  return pending;
}

interface OutputRemainder {
  source: FragmentSource;
  spec: ReturnType<typeof fragmentOutputSpec>;
  outputLabel: string;
  current: ConfigObject;
  managed: ConfigObject;
  managedFragments: FragmentValue[];
}

async function loadOutputRemainder(
  opts: Pick<
    PickExtractionOptions,
    "project" | "dataRepo" | "manifest" | "lock"
  >,
  source: FragmentSource,
): Promise<OutputRemainder | null> {
  const spec = fragmentOutputSpec(source.target);
  const outputPath = spec.outputPath(opts.project);
  const outputLabel = relative(opts.project, outputPath);
  if (!existsSync(outputPath)) return null;
  const current = spec.parse(await readFile(outputPath, "utf-8"), outputLabel);
  const managedFragments = await fragmentValuesForTarget({
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    lock: opts.lock,
    target: source.target,
  });
  const managed = spec.normalizeOutput(
    mergeConfigObjects(managedFragments.map((fragment) => fragment.value)),
  );
  return { source, spec, outputLabel, current, managed, managedFragments };
}

function extractFromRemainder(
  remainder: OutputRemainder,
  picks: string[],
): string {
  return remainder.spec.stringify(
    extractPickedFragment({
      source: remainder.source,
      picks,
      current: remainder.current,
      managed: remainder.managed,
      managedFragments: remainder.managedFragments,
      outputLabel: remainder.outputLabel,
    }),
  );
}

function unmanagedServerNames(remainder: OutputRemainder): string[] {
  const base = unmanagedRemainder(remainder.current, remainder.managed);
  const servers = base[mcpServerContainerKey(remainder.source)];
  return isPlainConfigObject(servers) ? Object.keys(servers) : [];
}

function outputLabelFor(project: string, source: FragmentSource): string {
  return relative(
    project,
    fragmentOutputSpec(source.target).outputPath(project),
  );
}

function parseShareScope(
  value: string | undefined,
  fallback: ShareScope,
): ShareScope {
  if (value === undefined) return fallback;
  if (value === "local" || value === "project") return value;
  throw new PreconditionError(
    `invalid scope "${value}" (expected local or project)`,
  );
}

function preserveLabel(
  entry: DataLockEntryV4,
  localLock: Lock,
  key: string,
): DataLockEntryV4 {
  const existing = localLock.items[key];
  if (existing?.source !== "data" || existing.label === undefined) {
    return entry;
  }
  return { ...entry, label: existing.label };
}
