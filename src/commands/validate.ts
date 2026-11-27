import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findSystemItem } from "../bundled";
import type { SystemItem } from "../bundled";
import { resolveDataRepo } from "../data-repo";
import {
  ExitCode,
  NotFoundError,
  PreconditionError,
  ResultExitError,
  firstErrorLine,
} from "../errors";
import { assertIsGitRepo, sourceVisibleFilesUnderPath } from "../git";
import { globalOpts } from "../global-options";
import { installedPath, parseLockKey } from "../installed";
import type { ItemSource } from "../installed";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import type { ItemRef } from "../item-ref";
import { loadLocalLock, loadLock } from "../lock";
import type { Lock } from "../lock";
import { loadManifest } from "../manifest";
import { listMasterItems, walkItemFiles } from "../master";
import type { MasterItem } from "../master";
import { findProjectRoot, projectRoot } from "../paths";
import { sanitizeDisplayText } from "../pick-core";
import { lintResult, lintSkill } from "../skill-lint";
import type { LintCheck, LintResult, SkillLintInput } from "../skill-lint";

interface ValidateOptions {
  json?: boolean;
  here?: boolean;
  strict?: boolean;
}

type Location = "data-repo" | "system" | "project" | "local";

interface ValidateTarget {
  source: ItemSource;
  name: string;
  location: Location;
  path: string | null;
  load: () => Promise<SkillLintInput>;
}

interface ItemReport {
  ref: string;
  source: ItemSource;
  location: Location;
  path: string | null;
  result: LintResult;
  checks: LintCheck[];
  error?: string;
}

const STATUS_MARK = { pass: "✓", warn: "⚠", fail: "✗", skip: "-" } as const;

export function registerValidate(program: Command): void {
  program
    .command("validate [item]")
    .description(
      "lint skills (read-only): frontmatter, name, description size, body length, links, and style heuristics",
    )
    .option("--here", "validate the skills installed in this project")
    .option("--strict", "exit 4 on warnings as well as on failures")
    .option("--json", "output JSON")
    .action(
      async (
        itemRef: string | undefined,
        opts: ValidateOptions,
        cmd: Command,
      ) => {
        const ref = itemRef === undefined ? null : parseItemRef(itemRef);
        if (ref?.kind !== undefined && ref.kind !== "skills") {
          throw new PreconditionError(
            `validate checks skills only; ${itemRef} is a ${ref.kind} item`,
          );
        }
        const targets = opts.here
          ? await installedTargets(ref, itemRef)
          : await shelfTargets(ref, itemRef, cmd);

        const reports: ItemReport[] = [];
        for (const target of targets) reports.push(await runTarget(target));

        const counts = { pass: 0, warn: 0, fail: 0 };
        for (const report of reports) counts[report.result] += 1;
        const failed =
          counts.fail > 0 || (opts.strict === true && counts.warn > 0);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                strict: opts.strict === true,
                summary: { items: reports.length, ...counts },
                items: reports,
              },
              null,
              2,
            ),
          );
        } else {
          printReports(reports, counts);
        }
        if (failed) throw new ResultExitError(ExitCode.CheckFailed);
      },
    );
}

async function runTarget(target: ValidateTarget): Promise<ItemReport> {
  const base = {
    ref: `skills/${target.name}`,
    source: target.source,
    location: target.location,
    path: target.path,
  };
  try {
    const checks = lintSkill(await target.load());
    return { ...base, result: lintResult(checks), checks };
  } catch (cause) {
    return {
      ...base,
      result: "fail",
      checks: [],
      error: firstErrorLine(cause),
    };
  }
}

async function shelfTargets(
  ref: ItemRef | null,
  itemRef: string | undefined,
  cmd: Command,
): Promise<ValidateTarget[]> {
  if (ref !== null) {
    const system = findSystemItem(ref.name);
    if (system !== null && system.kind === "skills") {
      return [systemTarget(system)];
    }
  }
  const project = findProjectRoot();
  const manifest = project ? await loadManifest(project) : null;
  const dataRepo = await resolveDataRepo({
    override: globalOpts(cmd).data,
    manifest,
    project: project ?? undefined,
  });
  await assertIsGitRepo(dataRepo);
  if (ref === null) {
    const items = await listMasterItems(dataRepo, "skills");
    return items
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => dataTarget(dataRepo, item));
  }
  const item = await findMasterItemByRef(dataRepo, ref);
  if (item === null) throw new NotFoundError(`not found: ${itemRef}`);
  if (item.kind !== "skills") {
    throw new PreconditionError(
      `validate checks skills only; ${itemRef} is a ${item.kind} item`,
    );
  }
  return [dataTarget(dataRepo, item)];
}

async function installedTargets(
  ref: ItemRef | null,
  itemRef: string | undefined,
): Promise<ValidateTarget[]> {
  const project = projectRoot();
  const scopes: Array<{ lock: Lock; location: Location }> = [
    { lock: await loadLock(project), location: "project" },
    { lock: await loadLocalLock(project), location: "local" },
  ];
  const targets: ValidateTarget[] = [];
  for (const { lock, location } of scopes) {
    for (const key of Object.keys(lock.items).sort()) {
      const parsed = parseLockKey(key);
      if (parsed.kind !== "skills") continue;
      if (ref !== null && parsed.name !== ref.name) continue;
      const path = installedPath(project, "skills", parsed.name);
      targets.push({
        source: parsed.source,
        name: parsed.name,
        location,
        path,
        load: () => directoryInput(parsed.name, path, walkItemFiles),
      });
    }
  }
  if (ref !== null && targets.length === 0) {
    throw new NotFoundError(`not installed in this project: ${itemRef}`);
  }
  return targets;
}

function dataTarget(dataRepo: string, item: MasterItem): ValidateTarget {
  return {
    source: "data",
    name: item.name,
    location: "data-repo",
    path: item.path,
    load: () =>
      directoryInput(item.name, item.path, () =>
        sourceVisibleFilesUnderPath(dataRepo, item.repoRelPath),
      ),
  };
}

function systemTarget(item: SystemItem): ValidateTarget {
  return {
    source: "system",
    name: item.name,
    location: "system",
    path: null,
    load: async () => ({
      name: item.name,
      files: item.files.map((file) => file.relPath),
      skillMd:
        item.files.find((file) => file.relPath === "SKILL.md")?.content ?? null,
    }),
  };
}

async function directoryInput(
  name: string,
  path: string,
  listFiles: (path: string) => Promise<string[]>,
): Promise<SkillLintInput> {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const files = await listFiles(path);
  const skillMd = files.includes("SKILL.md")
    ? await readFile(join(path, "SKILL.md"), "utf-8")
    : null;
  return { name, files, skillMd };
}

function printReports(
  reports: readonly ItemReport[],
  counts: Record<LintResult, number>,
): void {
  if (reports.length === 0) {
    console.log("(no skills)");
    return;
  }
  const width = Math.max(
    0,
    ...reports.flatMap((r) => r.checks.map((c) => c.id.length)),
  );
  for (const report of reports) {
    const where =
      report.location === "data-repo" ? "data repo" : report.location;
    console.log(
      `${sanitizeDisplayText(report.ref)} (${where})  ${report.result}`,
    );
    if (report.error !== undefined) {
      console.log(`  ✗ ${sanitizeDisplayText(report.error)}`);
    }
    for (const check of report.checks) {
      console.log(
        `  ${STATUS_MARK[check.status]} ${check.id.padEnd(width)}  ${sanitizeDisplayText(check.message)}`,
      );
      for (const detail of check.details ?? []) {
        console.log(`      ${sanitizeDisplayText(detail)}`);
      }
    }
  }
  const noun = reports.length === 1 ? "skill" : "skills";
  console.log(
    `${reports.length} ${noun}: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`,
  );
}
