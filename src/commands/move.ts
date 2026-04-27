import { Command } from "commander";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import {
  dataKey,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { Lock } from "../lock";
import { ensureInstallAliases, parseLockKey } from "../installed";
import { isSystemItemName } from "../bundled";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../cli";
import { lockKeysForRef, parseItemRef } from "../item-ref";
import type { ItemKind } from "../master";
import {
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  removeLocalExcludes,
  saveLocalConfig,
} from "../local-config";
import { moveScope } from "./promote";
import type { MoveScopeResult, Scope } from "./promote";

interface MoveOptions {
  to?: string;
  json?: boolean;
}

export function registerMove(program: Command): void {
  program
    .command("move <item>")
    .description("change the scope of an already-tracked data item")
    .requiredOption("--to <scope>", "destination scope: local or project")
    .option("--json", "output JSON")
    .addHelpText(
      "after",
      "\nRecovery: if a previous move left both scopes with the same lock entry, rerun this command with the intended --to scope.",
    )
    .action(async (itemRef: string, opts: MoveOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        console.error(
          `✗ "${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
        );
        process.exit(3);
      }
      const to = parseMoveScope(opts.to);

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const projectLock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const localConfig = await loadLocalConfig(project);
      const resolved = resolveMoveItem(ref, projectLock, localLock);
      if (!resolved) {
        if (ref.kind === "settings") {
          assertLocalScopeSupported(ref.kind, ref.name, "move");
        }
        if (ref.kind === "mcp" && to === "local") {
          assertLocalScopeSupported(ref.kind, ref.name, "move");
        }
        console.error("✗ not tracked in this project");
        process.exit(2);
      }
      if (resolved.kind === "settings") {
        assertLocalScopeSupported(resolved.kind, resolved.name, "move");
      }
      if (resolved.kind === "mcp" && to === "local") {
        assertLocalScopeSupported(resolved.kind, resolved.name, "move");
      }
      const alreadyCurrent = alreadyInDestinationScope(
        resolved.kind,
        resolved.name,
        to,
        projectLock,
        localLock,
      );
      if (alreadyCurrent) {
        printMoveResult(alreadyCurrent, opts.json === true);
        return;
      }

      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      const result = await moveScope(
        project,
        dataRepo,
        resolved.kind,
        resolved.name,
        to,
        {
          manifest,
          projectLock,
          localLock,
          localConfig,
        },
      );

      if (!result.alreadyCurrent) {
        if (result.to === "project") {
          await saveLock(project, projectLock);
          await saveManifest(project, manifest);
          await removeLocalExcludes(project, result.name);
          await ensureInstallAliases(
            project,
            result.kind,
            result.name,
            manifest.installMode,
          );
          await saveLocalLock(project, localLock);
          if (localConfig) await saveLocalConfig(project, localConfig);
        } else {
          await saveLocalLock(project, localLock);
          if (localConfig) await saveLocalConfig(project, localConfig);
          await ensureLocalExcludes(project, result.name);
          await ensureInstallAliases(
            project,
            result.kind,
            result.name,
            manifest.installMode,
          );
          await saveLock(project, projectLock);
          await saveManifest(project, manifest);
        }
      }

      if (opts.json) {
        printMoveResult(result, true);
      } else {
        printMoveResult(result, false);
      }
    });
}

function parseMoveScope(value: string | undefined): Scope {
  if (value === "local" || value === "project") return value;
  console.error(`✗ invalid scope "${value ?? ""}" (expected local or project)`);
  process.exit(3);
}

function resolveMoveItem(
  ref: ReturnType<typeof parseItemRef>,
  projectLock: Lock,
  localLock: Lock,
): { kind: ItemKind; name: string } | null {
  const keys = [
    ...dataKeysForRef(projectLock, ref),
    ...dataKeysForRef(localLock, ref),
  ];
  if (keys.length === 0) return null;

  const resolved = new Map<string, { kind: ItemKind; name: string }>();
  for (const key of keys) {
    const parsed = parseLockKey(key);
    resolved.set(`${parsed.kind}/${parsed.name}`, {
      kind: parsed.kind,
      name: parsed.name,
    });
  }
  if (resolved.size > 1) {
    throw new Error(
      `ambiguous item "${ref.name}": found ${[...resolved.keys()].join(", ")}; use kind/name`,
    );
  }
  return [...resolved.values()][0] ?? null;
}

function dataKeysForRef(lock: Lock, ref: ReturnType<typeof parseItemRef>): string[] {
  return lockKeysForRef(lock, ref).filter((key) => {
    const parsed = parseLockKey(key);
    return parsed.source === "data";
  });
}

function alreadyInDestinationScope(
  kind: ItemKind,
  name: string,
  to: Scope,
  projectLock: Lock,
  localLock: Lock,
): MoveScopeResult | null {
  const key = dataKey(kind, name);
  const projectEntry = projectLock.items[key];
  const localEntry = localLock.items[key];
  if (to === "project" && projectEntry && !localEntry) {
    if (projectEntry.source !== "data") {
      throw new Error(`expected data lock entry for ${key}`);
    }
    return {
      kind,
      name,
      from: "project",
      to,
      sha: projectEntry.sha,
      sourceCommit: projectEntry.sourceCommit,
      alreadyCurrent: true,
    };
  }
  if (to === "local" && localEntry && !projectEntry) {
    if (localEntry.source !== "data") {
      throw new Error(`expected data lock entry for ${key}`);
    }
    return {
      kind,
      name,
      from: "local",
      to,
      sha: localEntry.sha,
      sourceCommit: localEntry.sourceCommit,
      alreadyCurrent: true,
    };
  }
  return null;
}

function printMoveResult(result: MoveScopeResult, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          verb: "move",
          kind: result.kind,
          name: result.name,
          from: result.from,
          to: result.to,
          sha: result.sha,
          sourceCommit: result.sourceCommit,
          ...(result.alreadyCurrent && { action: "already-current" }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (result.alreadyCurrent) {
    console.log(`already in ${result.to} scope`);
    return;
  }
  console.log(
    `✓ moved data/${result.kind}/${result.name} from ${result.from} to ${result.to}`,
  );
  console.log(`  source commit: ${result.sourceCommit}`);
}
