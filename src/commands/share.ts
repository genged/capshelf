import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import { addManifestName } from "../manifest";
import {
  dataKey,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntry, Lock } from "../lock";
import { isSystemItemName } from "../bundled";
import { assertIsGitRepo, assertRepoClean, commitInRepo } from "../git";
import { globalOpts } from "../cli";
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
  fragmentSourceCandidates,
  isFragmentKind,
  parseFragmentSourceText,
  shaOfFragmentItem,
  sourceMatchesCliTarget,
  sourceTargetForCli,
} from "../fragments";

type ShareScope = "project" | "local";

interface ShareOptions {
  to?: string;
  from?: string;
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
      "resulting scope: local or project (default: local)",
    )
    .option("--from <path>", "source file for fragment items")
    .option(
      "--target <target>",
      "fragment target for mcp items: claude or codex",
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
      const scope = parseShareScope(opts.to);
      if (isFragmentKind(kind)) {
        await shareFragment(kind, name, scope, opts, cmd);
        return;
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const projectLock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const localConfig = await loadLocalConfig(project);
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

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
          throw new Error(
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
  if (!opts.from) {
    throw new PreconditionError(
      `share ${kind}/${name} requires --from <path>; generated outputs cannot be converted back to one fragment safely`,
    );
  }
  const cliTarget = sourceTargetForCli(opts.target);
  if (kind === "mcp" && cliTarget === null) {
    throw new PreconditionError(
      "share mcp fragments requires --target claude or --target codex",
    );
  }
  if (kind !== "mcp" && cliTarget !== null) {
    throw new PreconditionError("--target is only valid for mcp fragments");
  }

  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  const oldManifest = structuredClone(manifest);
  const oldLock = structuredClone(projectLock);
  const dataRepo = await resolveDataRepo({
    override: globalOpts(cmd).data,
    manifest,
    project,
  });
  await assertIsGitRepo(dataRepo);
  await assertRepoClean(dataRepo);

  const source = fragmentSourceCandidates(kind, name).find((candidate) =>
    sourceMatchesCliTarget(candidate, cliTarget),
  );
  if (!source) {
    throw new PreconditionError(
      `no canonical source target for ${kind}/${name}`,
    );
  }
  const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
  if (existsSync(canonicalPath)) {
    throw new PreconditionError(
      `fragment source already exists: ${source.relPath}`,
    );
  }
  const raw = await readFile(opts.from, "utf-8");
  parseFragmentSourceText(source, raw);
  await mkdir(dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, raw);
  const sourceCommit = await commitInRepo(
    dataRepo,
    [source.relPath],
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
}

function parseShareScope(value: string | undefined): ShareScope {
  if (value === undefined) return "local";
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
