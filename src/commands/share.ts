import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWriteFile } from "../fs-utils";
import { dirname, join, relative } from "node:path";
import { homeRelative, projectRoot } from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { loadManifest, saveManifest, type Manifest } from "../manifest";
import { addManifestName } from "../manifest";
import { dataKey, loadLock, saveLocalLock, saveLock } from "../lock";
import type { DataLockEntry, Lock } from "../lock";
import { isSystemItemName } from "../bundled";
import { assertRepoClean, commitInRepo, originRemoteUrl } from "../git";
import { PreconditionError } from "../errors";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import {
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  removeLocalExcludes,
  saveLocalConfig,
} from "../local-config";
import { addToManifest } from "../promote-core";
import { adoptIntoDataRepo } from "../data-repo-adopt";
import { printPrivateDotenvWarnings } from "../dotfiles";
import { printRuntimeWarnings } from "../runtime-warnings";
import {
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  fragmentOutputSpec,
  fragmentSourceCandidates,
  fragmentValuesForTarget,
  isFragmentKind,
  parseFragmentSourceText,
  shaOfFragmentItem,
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
      "resulting scope: local or project (default: local for skills, project for fragments)",
    )
    .option("--from <path>", "source file for fragment items")
    .option(
      "--pick <path>",
      "extract an unmanaged value from the generated output instead of --from; repeatable (fragment items; mcp picks accept bare server names and default to the item name)",
      collectPick,
    )
    .option(
      "--target <target>",
      "fragment target for mcp items: claude or codex (default: every output containing the pick)",
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
        isFragmentKind(kind) ? "project" : "local",
      );
      if (isFragmentKind(kind)) {
        await shareFragment(kind, name, scope, opts, cmd);
        return;
      }
      if (opts.pick !== undefined) {
        throw new PreconditionError(
          "--pick is only valid for fragment items (settings, mcp, codex-config)",
        );
      }

      const { project, manifest, projectLock, localLock } =
        await loadProjectContext({ cmd });
      const localConfig = await loadLocalConfig(project);
      const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);

      const repoRelPath = `${kind}/${name}`;
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
        await assertLocalInstallPathsUntracked(project, name);
      }

      const adopted = await adoptIntoDataRepo(project, dataRepo, kind, name, {
        installMode: manifest.installMode,
        message: opts.message,
        ...((scope === "local" || localKey) && {
          sourceScope: "local" as const,
        }),
      });

      const entry = {
        source: "data" as const,
        sha: adopted.sha,
        sourceCommit: adopted.sourceCommit,
        appliedAt: new Date().toISOString(),
      };
      let localChanged = false;
      if (scope === "project") {
        addToManifest(manifest, kind, name);
        projectLock.items[key] = preserveLabel(entry, localLock, key);
        if (localKey) {
          delete localLock.items[key];
          if (localConfig) {
            localConfig.skills = localConfig.skills.filter((x) => x !== name);
          }
          await removeLocalExcludes(project, name);
          localChanged = true;
        }
        await saveManifest(project, manifest);
        await saveLock(project, projectLock);
        if (localChanged) {
          await saveLocalLock(project, localLock);
          if (localConfig) await saveLocalConfig(project, localConfig);
        }
      } else {
        if (!localConfig) throw new Error("expected local manifest");
        if (!localConfig.skills.includes(name)) localConfig.skills.push(name);
        localLock.items[key] = preserveLabel(entry, localLock, key);
        await ensureLocalExcludes(project, name);
        await saveLocalConfig(project, localConfig);
        await saveLocalLock(project, localLock);
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
              ...(adopted.runtimeWarnings && {
                runtimeWarnings: adopted.runtimeWarnings,
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
      printRuntimeWarnings(adopted.runtimeWarnings);
      printPrivateDotenvWarnings(adopted.privateDotenvWarnings);
      await printShareUpstreamGuidance(dataRepo);
    });
}

async function shareFragment(
  kind: Exclude<ReturnType<typeof parseItemRef>["kind"], undefined | "skills">,
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
  const sha = await shaOfFragmentItem(dataRepo, kind, name);

  addManifestName(manifest, kind, name);
  projectLock.items[dataKey(kind, name)] = {
    source: "data",
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
  };

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
  await saveLock(project, projectLock);

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
  entry: DataLockEntry,
  localLock: Lock,
  key: string,
): DataLockEntry {
  const existing = localLock.items[key];
  if (existing?.source !== "data" || existing.label === undefined) {
    return entry;
  }
  return { ...entry, label: existing.label };
}
