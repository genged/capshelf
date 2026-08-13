import type { Command } from "commander";
import { projectRoot } from "../paths";
import {
  assertLockV4,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import { parseLockKey } from "../installed";
import { shaOfInstalledForScope } from "../item-snapshot";
import { installedTreeIdentity } from "../install-identity";
import { entryIdentity } from "../lock";
import { loadManifest } from "../manifest";
import { resolveProjectDataRepo } from "../command-context";
import { lockKeysForRef, parseItemRef } from "../item-ref";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
} from "../master";
import type { FragmentItemKind } from "../master";
import { NotFoundError, PreconditionError } from "../errors";

interface KeepLocalOptions {
  reason?: string;
  unset?: boolean;
  json?: boolean;
  local?: boolean;
}

export function registerKeepLocal(program: Command): void {
  program
    .command("keep-local <item>")
    .description(
      "mark a drifted data item as intentional project-local divergence",
    )
    .option("--reason <text>", "reason for the local divergence")
    .option("--unset", "clear the keep-local marker")
    .option("--local", "mark a local-scope item")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: KeepLocalOptions, cmd: Command) => {
      const project = projectRoot();
      const lock = opts.local
        ? await loadLocalLock(project)
        : await loadLock(project);
      const ref = parseItemRef(itemRef);
      const keys = lockKeysForRef(lock, ref);
      const dataKeys = keys.filter(
        (key) => parseLockKey(key).source === "data",
      );

      if (dataKeys.length > 1) {
        throw new PreconditionError(
          `ambiguous item "${ref.name}": found ${dataKeys
            .map((key) => {
              const parsed = parseLockKey(key);
              return `${parsed.kind}/${parsed.name}`;
            })
            .join(", ")}; use kind/name`,
        );
      }
      if (dataKeys.length === 0) {
        if (keys.some((key) => parseLockKey(key).source === "system")) {
          throw new PreconditionError(
            `${itemRef} is a system item — local divergence is not tracked for bundled items`,
          );
        }
        throw new NotFoundError(`not tracked in this project: ${itemRef}`);
      }

      const key = dataKeys[0]!;
      const parsed = parseLockKey(key);
      if (isFragmentItemKind(parsed.kind)) {
        throw new PreconditionError(keepLocalRejectMessage(parsed.kind));
      }
      if (isCopyTargetFileItemKind(parsed.kind)) {
        throw new PreconditionError(
          `keep-local is not supported for subagents/${parsed.name}; subagents are project scope only`,
        );
      }
      if (!isCopyDirectoryItemKind(parsed.kind)) {
        throw new Error(
          `no keep-local strategy for ${parsed.kind}/${parsed.name}`,
        );
      }
      const entry = lock.items[key]!;
      if (entry.source !== "data") {
        throw new Error(`expected data lock entry for ${key}`);
      }

      // keep-local accepts *existing* drift as intentional. Marking a
      // non-drifted item silently flips it to "≠ kept local" and suppresses
      // future update signals for no reason — refuse instead of doing that.
      if (!opts.unset && entry.local !== true) {
        // PIN-5: filesystem work over the pinned path set, in the entry's own
        // identity model, so a `--local` item — which project Git is told to
        // ignore — is compared against real bytes rather than an empty set.
        const dataRepo = await resolveProjectDataRepo(
          project,
          await loadManifest(project),
          cmd,
        );
        const installedSha =
          entry.sourcePinDigest !== undefined
            ? await installedTreeIdentity(
                project,
                dataRepo,
                parsed.kind,
                parsed.name,
                entry.sourceCommit,
              )
            : await shaOfInstalledForScope(
                project,
                parsed.kind,
                parsed.name,
                opts.local ? "local" : "project",
              );
        if (installedSha === entryIdentity(entry)) {
          throw new PreconditionError(
            `${parsed.kind}/${parsed.name} has no local divergence — its installed content matches the lock, so there is nothing to keep.\n` +
              "  keep-local marks existing drift as intentional; edit the files first, or use --unset to clear a marker.",
          );
        }
      }

      if (opts.unset) {
        delete entry.local;
        delete entry.localReason;
      } else {
        entry.local = true;
        if (opts.reason !== undefined) entry.localReason = opts.reason;
      }

      const writableLock = assertLockV4(lock, "capshelf keep-local");
      if (opts.local) await saveLocalLock(project, writableLock);
      else await saveLock(project, writableLock);

      const result = {
        source: "data",
        scope: opts.local ? "local" : "project",
        kind: parsed.kind,
        name: parsed.name,
        local: entry.local === true,
        localReason: entry.localReason ?? null,
      };

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (opts.unset) {
        console.log(
          `✓ ${opts.local ? "local/" : ""}${parsed.kind}/${parsed.name} will be reconciled again`,
        );
      } else {
        console.log(
          `✓ keeping local divergence for ${opts.local ? "local/" : ""}${parsed.kind}/${parsed.name}`,
        );
      }
    });
}

function keepLocalRejectMessage(kind: FragmentItemKind): string {
  switch (kind) {
    case "settings":
      return "keep-local is not supported for settings fragments; keep project-local values in .claude/settings.json";
    case "mcp":
      return "keep-local is not supported for mcp fragments; keep project-local values in .mcp.json or .codex/config.toml";
    case "codex-config":
      return "keep-local is not supported for codex-config fragments; keep project-local values in .codex/config.toml";
  }
}
