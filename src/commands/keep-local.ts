import { Command } from "commander";
import { projectRoot } from "../paths";
import { loadLocalLock, loadLock, saveLocalLock, saveLock } from "../lock";
import { parseLockKey } from "../installed";
import { lockKeysForRef, parseItemRef } from "../item-ref";
import { isFragmentItemKind } from "../master";

interface KeepLocalOptions {
  reason?: string;
  unset?: boolean;
  json?: boolean;
  local?: boolean;
}

export function registerKeepLocal(program: Command): void {
  program
    .command("keep-local <item>")
    .description("mark a drifted data item as intentional project-local divergence")
    .option("--reason <text>", "reason for the local divergence")
    .option("--unset", "clear the keep-local marker")
    .option("--local", "mark a local-scope item")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: KeepLocalOptions) => {
      const project = projectRoot();
      const lock = opts.local ? await loadLocalLock(project) : await loadLock(project);
      const ref = parseItemRef(itemRef);
      const keys = lockKeysForRef(lock, ref);
      const dataKeys = keys.filter((key) => parseLockKey(key).source === "data");

      if (dataKeys.length > 1) {
        throw new Error(
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
          console.error(
            `✗ ${itemRef} is a system item — local divergence is not tracked for bundled items`,
          );
          process.exit(3);
        }
        console.error(`✗ not tracked in this project: ${itemRef}`);
        process.exit(2);
      }

      const key = dataKeys[0]!;
      const parsed = parseLockKey(key);
      if (isFragmentItemKind(parsed.kind)) {
        console.error(`✗ ${keepLocalRejectMessage(parsed.kind)}`);
        process.exit(3);
      }
      const entry = lock.items[key]!;
      if (entry.source !== "data") {
        throw new Error(`expected data lock entry for ${key}`);
      }

      if (opts.unset) {
        delete entry.local;
        delete entry.localReason;
      } else {
        entry.local = true;
        if (opts.reason !== undefined) entry.localReason = opts.reason;
      }

      if (opts.local) await saveLocalLock(project, lock);
      else await saveLock(project, lock);

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
        console.log(`✓ ${opts.local ? "local/" : ""}${parsed.kind}/${parsed.name} will be reconciled again`);
      } else {
        console.log(`✓ keeping local divergence for ${opts.local ? "local/" : ""}${parsed.kind}/${parsed.name}`);
      }
    });
}

function keepLocalRejectMessage(kind: Exclude<ReturnType<typeof parseLockKey>["kind"], "skills">): string {
  switch (kind) {
    case "settings":
      return "keep-local is not supported for settings fragments; keep project-local values in .claude/settings.json";
    case "mcp":
      return "keep-local is not supported for mcp fragments; keep project-local values in .mcp.json or .codex/config.toml";
    case "codex-config":
      return "keep-local is not supported for codex-config fragments; keep project-local values in .codex/config.toml";
  }
}
