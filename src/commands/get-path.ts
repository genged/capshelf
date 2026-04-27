import { Command } from "commander";
import { projectRoot } from "../paths";
import { loadLock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import { lockKeyForRef, parseItemRef } from "../item-ref";

interface GetPathOptions {
  json?: boolean;
}

export function registerGetPath(program: Command): void {
  program
    .command("get-path <item>")
    .description("print the installed path for a locked item so it can be edited")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: GetPathOptions) => {
      const ref = parseItemRef(itemRef);
      const project = projectRoot();
      const lock = await loadLock(project);
      const key = lockKeyForRef(lock, ref);
      if (!key) {
        console.error(`✗ not tracked in this project: ${itemRef}`);
        process.exit(2);
      }

      const parsed = parseLockKey(key);
      const path = installedPath(project, parsed.kind, parsed.name);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: parsed.source,
              kind: parsed.kind,
              name: parsed.name,
              path,
              lock: lock.items[key],
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(path);
    });
}
