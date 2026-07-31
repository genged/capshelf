import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  claudePluginSkills,
  findClaudePlugin,
  isManagedClaudePlugin,
  loadClaudeMarketplace,
  loadClaudeMarketplaceAtHead,
  serializeClaudeMarketplace,
  type ClaudeMarketplace,
  type ClaudePlugin,
  validateClaudeMarketplace,
  validateClaudeMarketplaceDocument,
} from "../claude-marketplace";
import {
  buildCodexProjection,
  codexSourceFiles,
  findCodexDefinition,
  loadCodexState,
  loadCodexStateAtHead,
  type CodexPluginDefinition,
  type CodexState,
  validateCodexStateDocument,
} from "../codex-marketplace";
import { resolveDataRepo } from "../data-repo";
import { NotFoundError, PreconditionError, ResultExitError } from "../errors";
import {
  assertIsGitRepo,
  gitVisibleFilesUnderPath,
  gitText,
  headSha,
  isRepoClean,
  originRemoteUrl,
} from "../git";
import { globalOpts } from "../global-options";
import { loadManifest } from "../manifest";
import {
  CODEX_PROJECTION_ROOTS,
  commitMarketplaceMutation,
  diffFileSets,
  readFilesBelow,
  replaceOwnedFiles,
} from "../marketplace-files";
import { findProjectRoot } from "../paths";
import { assertNoSymlinkAncestors } from "../path-safety";
import {
  collectSelectedSkill,
  jsonFile,
  logicalContentHash,
  type ProjectionFile,
  validateMarketplaceName,
} from "../plugin-projection";
import {
  COWORK_MAX_BYTES,
  COWORK_MAX_FILES,
  publishClaudePackage,
  publishCodexPackage,
} from "../plugin-package";

type Target = "claude" | "codex";

interface CommonOptions {
  target?: string;
  json?: boolean;
  dryRun?: boolean;
  message?: string;
}

interface InitOptions extends CommonOptions {
  name: string;
  displayName?: string;
  owner: string;
  ownerEmail?: string;
  description?: string;
}

interface EditOptions extends CommonOptions {
  displayName?: string;
  owner?: string;
  ownerEmail?: string;
  description?: string;
  clearDisplayName?: boolean;
  clearOwnerEmail?: boolean;
  clearDescription?: boolean;
}

interface PluginOptions extends CommonOptions {
  displayName?: string;
  description?: string;
  category?: string;
  installation?: string;
  authentication?: string;
  skill: string[];
  clearDisplayName?: boolean;
  clearDescription?: boolean;
  clearCategory?: boolean;
}

interface PackOptions extends CommonOptions {
  output: string;
  fromHead?: boolean;
}

interface ValidateOptions extends CommonOptions {
  strict?: boolean;
  distribution?: boolean;
  coworkUrl?: string;
}

interface MutationContext {
  verb: string;
  plugin?: string;
  fields?: Record<string, unknown>;
}

interface MarketplaceIssue {
  code: string;
  message: string;
  target?: Target;
  [key: string]: unknown;
}

export function registerMarketplace(program: Command): void {
  const marketplace = program
    .command("marketplace")
    .description("manage Claude and Codex plugin marketplace catalogs");

  withMutationOptions(
    marketplace
      .command("init")
      .requiredOption("--target <target>", "claude or codex")
      .requiredOption("--name <name>", "marketplace identifier")
      .requiredOption("--owner <name>", "owner name")
      .option("--owner-email <email>")
      .option("--display-name <name>")
      .option("--description <text>"),
  ).action(async (opts: InitOptions, cmd: Command) => {
    const dataRepo = await marketplaceDataRepo(cmd);
    const target = requireTarget(opts.target);
    validateMarketplaceName(opts.name, "marketplace name", target);
    if (!opts.owner.trim())
      throw new PreconditionError("--owner cannot be empty");
    if (target === "claude") {
      if (opts.displayName !== undefined) {
        throw new PreconditionError(
          "Claude marketplace init does not support --display-name",
        );
      }
      const state: ClaudeMarketplace = {
        name: opts.name,
        owner: {
          name: opts.owner,
          ...(opts.ownerEmail && { email: opts.ownerEmail }),
        },
        ...(opts.description && { description: opts.description }),
        plugins: [],
      };
      if (existsSync(`${dataRepo}/.claude-plugin/marketplace.json`)) {
        const current = await loadClaudeMarketplace(dataRepo);
        if (sameClaudeIdentity(current, state)) {
          printResult(opts, {
            verb: "marketplace-init",
            action: "already-initialized",
            target,
            dataRepo,
            dataRepoHasOrigin: (await originRemoteUrl(dataRepo)) !== null,
          });
          return;
        }
        throw new PreconditionError(
          "Claude marketplace is already initialized",
        );
      }
      await mutateClaude(
        dataRepo,
        state,
        opts,
        "Initialize Claude plugin marketplace",
        { verb: "marketplace-init" },
      );
    } else {
      if (opts.description !== undefined) {
        throw new PreconditionError(
          "Codex marketplace init does not support --description",
        );
      }
      const sourceExists = existsSync(
        `${dataRepo}/codex/plugin-definitions/marketplace.json`,
      );
      const state: CodexState = {
        marketplace: {
          name: opts.name,
          ...(opts.displayName && { displayName: opts.displayName }),
          owner: {
            name: opts.owner,
            ...(opts.ownerEmail && { email: opts.ownerEmail }),
          },
        },
        definitions: [],
      };
      if (sourceExists) {
        const current = await loadCodexState(dataRepo);
        if (sameCodexIdentity(current, state)) {
          printResult(opts, {
            verb: "marketplace-init",
            action: "already-initialized",
            target,
            dataRepo,
            dataRepoHasOrigin: (await originRemoteUrl(dataRepo)) !== null,
          });
          return;
        }
        throw new PreconditionError("Codex marketplace is already initialized");
      }
      if (
        existsSync(`${dataRepo}/codex/plugin-definitions`) ||
        existsSync(`${dataRepo}/.agents/plugins/marketplace.json`) ||
        existsSync(`${dataRepo}/codex/generated`)
      ) {
        throw new PreconditionError(
          "Codex marketplace source or generated destinations already exist",
        );
      }
      await mutateCodex(
        dataRepo,
        state,
        opts,
        "Initialize Codex plugin marketplace",
        { verb: "marketplace-init" },
      );
    }
  });

  withMutationOptions(
    marketplace
      .command("edit")
      .requiredOption("--target <target>", "claude or codex")
      .option("--display-name <name>")
      .option("--clear-display-name")
      .option("--owner <name>")
      .option("--owner-email <email>")
      .option("--clear-owner-email")
      .option("--description <text>")
      .option("--clear-description"),
  ).action(async (opts: EditOptions, cmd: Command) => {
    const dataRepo = await marketplaceDataRepo(cmd);
    const target = requireTarget(opts.target);
    assertEditPairs(opts);
    if (target === "claude") {
      const state = await loadClaudeMarketplace(dataRepo);
      if (opts.displayName !== undefined || opts.clearDisplayName) {
        throw new PreconditionError(
          "Claude marketplace does not support display name",
        );
      }
      applyOwnerEdits(state.owner, opts);
      applyOptional(
        state,
        "description",
        opts.description,
        opts.clearDescription,
      );
      await mutateClaude(
        dataRepo,
        state,
        opts,
        "Update Claude plugin marketplace metadata",
        { verb: "marketplace-edit" },
      );
    } else {
      const state = await loadCodexState(dataRepo);
      if (opts.description !== undefined || opts.clearDescription) {
        throw new PreconditionError(
          "Codex marketplace does not support description",
        );
      }
      applyOwnerEdits(state.marketplace.owner, opts);
      applyOptional(
        state.marketplace,
        "displayName",
        opts.displayName,
        opts.clearDisplayName,
      );
      await mutateCodex(
        dataRepo,
        state,
        opts,
        "Update Codex plugin marketplace metadata",
        { verb: "marketplace-edit" },
      );
    }
  });

  marketplace
    .command("ls")
    .option("--target <target>", "claude or codex")
    .option("--json")
    .action(async (opts: CommonOptions, cmd: Command) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      const targets = opts.target
        ? [requireTarget(opts.target)]
        : (["claude", "codex"] as Target[]);
      const rows = [];
      for (const target of targets) {
        const row = await listTarget(dataRepo, target);
        if (row) rows.push(row);
      }
      if (opts.json) {
        console.log(JSON.stringify({ dataRepo, targets: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log("(no marketplaces configured)");
      } else {
        for (const row of rows) {
          console.log(`${row.target} marketplace ${row.marketplace.name}`);
          for (const plugin of row.plugins) {
            console.log(
              `  ${plugin.name.padEnd(24)} ${plugin.managed ? "managed" : "external"}  ${plugin.skills.length} skills${plugin.displayName ? `  ${plugin.displayName}` : ""}${plugin.projection ? `  projection ${plugin.projection}` : ""}`,
            );
          }
        }
      }
    });

  marketplace
    .command("show <plugin>")
    .option("--target <target>", "claude or codex")
    .option("--json")
    .action(async (plugin: string, opts: CommonOptions, cmd: Command) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      const targets = opts.target
        ? [requireTarget(opts.target)]
        : (["claude", "codex"] as Target[]);
      const matches = [];
      for (const target of targets) {
        const row = await showTarget(dataRepo, target, plugin);
        if (row) matches.push(row);
      }
      if (matches.length === 0)
        throw new NotFoundError(`plugin "${plugin}" not found`);
      if (opts.json)
        console.log(JSON.stringify({ dataRepo, plugins: matches }, null, 2));
      else {
        for (const row of matches) {
          console.log(`${row.target} ${row.name}@${row.marketplace}`);
          console.log(`  mode: ${row.managed ? "managed" : "external"}`);
          if (row.displayName)
            console.log(`  display name: ${row.displayName}`);
          if (row.description) console.log(`  description: ${row.description}`);
          if (!row.managed)
            console.log(`  source: ${JSON.stringify(row.source)}`);
          if (row.projection) console.log(`  projection: ${row.projection}`);
          console.log("  skills:");
          for (const skill of row.skills) console.log(`    ${skill}`);
          printHandoff(row.target, dataRepo, row.name, row.marketplace);
        }
      }
    });

  marketplace
    .command("validate")
    .option("--target <target>", "claude or codex")
    .option("--distribution")
    .option("--cowork-url <url>")
    .option("--strict")
    .option("--json")
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      if (opts.target && opts.distribution) {
        throw new PreconditionError(
          "--target and --distribution are mutually exclusive",
        );
      }
      if (opts.coworkUrl !== undefined && !opts.distribution) {
        throw new PreconditionError("--cowork-url requires --distribution");
      }
      const report = await validateAll(dataRepo, opts);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(
          report.valid
            ? "marketplace validation passed"
            : "marketplace validation failed",
        );
        for (const warning of report.warnings)
          console.error(`⚠ ${warning.message}`);
        for (const error of report.errors) console.error(`✗ ${error.message}`);
        console.log("Official compatibility check:");
        console.log(`  cd ${dataRepo}`);
        console.log("  claude plugin validate .");
      }
      if (!report.valid || (opts.strict && report.warnings.length > 0)) {
        throw new ResultExitError(4);
      }
    });

  marketplace
    .command("sync")
    .requiredOption("--target <target>", "codex")
    .option("--dry-run")
    .option("--json")
    .action(async (opts: CommonOptions, cmd: Command) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      if (requireTarget(opts.target) !== "codex") {
        throw new PreconditionError(
          "marketplace sync supports only --target codex",
        );
      }
      const state = await loadCodexState(dataRepo);
      const expected = await buildCodexProjection(dataRepo, state);
      const current = await readFilesBelow(dataRepo, CODEX_PROJECTION_ROOTS);
      const changes = diffFileSets(current, expected);
      const changed = totalChanges(changes) > 0;
      if (changed && !opts.dryRun) {
        await replaceOwnedFiles(dataRepo, CODEX_PROJECTION_ROOTS, expected);
      }
      printResult(opts, {
        verb: "marketplace-sync",
        action: changed ? "updated" : "already-synced",
        target: "codex",
        dataRepo,
        dataRepoHasOrigin: (await originRemoteUrl(dataRepo)) !== null,
        projection: changed && opts.dryRun ? "drifted" : "current",
        ...changes,
        committed: false,
        dryRun: opts.dryRun ?? false,
        warnings: overlapWarnings(state.definitions),
      });
    });

  const plugin = marketplace
    .command("plugin")
    .description("manage marketplace plugins");

  withMutationOptions(
    plugin
      .command("create <plugin>")
      .requiredOption("--target <target>", "claude or codex")
      .option("--display-name <name>")
      .option("--description <text>")
      .option("--category <category>")
      .option("--installation <policy>")
      .option("--authentication <policy>")
      .requiredOption(
        "--skill <ref>",
        "selected skill (repeatable)",
        collectOption,
        [] as string[],
      ),
  ).action(async (name: string, opts: PluginOptions, cmd: Command) => {
    const dataRepo = await marketplaceDataRepo(cmd);
    const target = requireTarget(opts.target);
    validateMarketplaceName(name, "plugin name", target);
    const skills = uniqueSkills(opts.skill);
    if (skills.length === 0) {
      throw new PreconditionError("at least one --skill is required");
    }
    await Promise.all(
      skills.map((skill) => collectSelectedSkill(dataRepo, skill)),
    );
    if (target === "claude") {
      if (
        opts.category !== undefined ||
        opts.installation !== undefined ||
        opts.authentication !== undefined
      ) {
        throw new PreconditionError(
          "Claude plugin create does not support Codex category or policy fields",
        );
      }
      const state = await loadClaudeMarketplace(dataRepo);
      if (
        state.plugins.some((entry) => entry.name === name) ||
        name in (state.renames ?? {})
      ) {
        throw new PreconditionError(
          `Claude plugin name "${name}" is already used`,
        );
      }
      state.plugins.push({
        name,
        ...(opts.displayName && { displayName: opts.displayName }),
        ...(opts.description && { description: opts.description }),
        source: "./",
        strict: false,
        skills: skills.map((skill) => `./${skill}`),
      });
      await mutateClaude(dataRepo, state, opts, `Add ${name} Claude plugin`, {
        verb: "marketplace-plugin-create",
        plugin: name,
      });
    } else {
      const state = await loadCodexState(dataRepo);
      if (state.definitions.some((entry) => entry.name === name)) {
        throw new PreconditionError(`Codex plugin "${name}" already exists`);
      }
      state.definitions.push(buildCodexDefinition(name, skills, opts));
      await mutateCodex(dataRepo, state, opts, `Add ${name} Codex plugin`, {
        verb: "marketplace-plugin-create",
        plugin: name,
      });
    }
  });

  withMutationOptions(
    plugin
      .command("edit <plugin>")
      .requiredOption("--target <target>", "claude or codex")
      .option("--display-name <name>")
      .option("--clear-display-name")
      .option("--description <text>")
      .option("--clear-description")
      .option("--category <category>")
      .option("--clear-category")
      .option("--installation <policy>")
      .option("--authentication <policy>"),
  ).action(async (name: string, opts: PluginOptions, cmd: Command) => {
    const dataRepo = await marketplaceDataRepo(cmd);
    const target = requireTarget(opts.target);
    assertPluginEdits(opts);
    if (target === "claude") {
      const state = await loadClaudeMarketplace(dataRepo);
      const entry = managedClaude(state, name);
      if (
        opts.category !== undefined ||
        opts.clearCategory ||
        opts.installation !== undefined ||
        opts.authentication !== undefined
      ) {
        throw new PreconditionError(
          "Claude plugin does not support Codex policy fields",
        );
      }
      applyPluginEdits(entry, opts);
      await mutateClaude(
        dataRepo,
        state,
        opts,
        `Update ${name} Claude plugin metadata`,
        { verb: "marketplace-plugin-edit", plugin: name },
      );
    } else {
      const state = await loadCodexState(dataRepo);
      const definition = findCodexDefinition(state, name);
      applyPluginEdits(definition, opts);
      applyCodexPolicy(definition, opts);
      await mutateCodex(
        dataRepo,
        state,
        opts,
        `Update ${name} Codex plugin metadata`,
        { verb: "marketplace-plugin-edit", plugin: name },
      );
    }
  });

  for (const verb of ["add-skill", "remove-skill"] as const) {
    withMutationOptions(
      plugin
        .command(`${verb} <plugin> <skills...>`)
        .requiredOption("--target <target>", "claude or codex"),
    ).action(
      async (
        name: string,
        refs: string[],
        opts: CommonOptions,
        cmd: Command,
      ) => {
        const dataRepo = await marketplaceDataRepo(cmd);
        const target = requireTarget(opts.target);
        const refsNormalized = uniqueSkills(refs);
        await Promise.all(
          refsNormalized.map((skill) => collectSelectedSkill(dataRepo, skill)),
        );
        if (target === "claude") {
          const state = await loadClaudeMarketplace(dataRepo);
          const entry = managedClaude(state, name);
          const change = changeMembership(
            claudePluginSkills(entry),
            refsNormalized,
            verb,
          );
          entry.skills = change.next.map((skill) => `./${skill}`);
          await mutateClaude(
            dataRepo,
            state,
            opts,
            `${verb === "add-skill" ? "Add" : "Remove"} skills ${verb === "add-skill" ? "to" : "from"} ${name} Claude plugin`,
            {
              verb: `marketplace-plugin-${verb}`,
              plugin: name,
              fields: {
                [verb === "add-skill" ? "skillsAdded" : "skillsRemoved"]:
                  change.changed,
              },
            },
          );
        } else {
          const state = await loadCodexState(dataRepo);
          const definition = findCodexDefinition(state, name);
          const change = changeMembership(
            definition.skills,
            refsNormalized,
            verb,
          );
          definition.skills = change.next;
          await mutateCodex(
            dataRepo,
            state,
            opts,
            `${verb === "add-skill" ? "Add" : "Remove"} skills ${verb === "add-skill" ? "to" : "from"} ${name} Codex plugin`,
            {
              verb: `marketplace-plugin-${verb}`,
              plugin: name,
              fields: {
                [verb === "add-skill" ? "skillsAdded" : "skillsRemoved"]:
                  change.changed,
              },
            },
          );
        }
      },
    );
  }

  withMutationOptions(
    plugin
      .command("rename <old> <new>")
      .requiredOption("--target <target>", "claude or codex"),
  ).action(
    async (
      oldName: string,
      newName: string,
      opts: CommonOptions,
      cmd: Command,
    ) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      const target = requireTarget(opts.target);
      validateMarketplaceName(newName, "plugin name", target);
      if (target === "claude") {
        const state = await loadClaudeMarketplace(dataRepo);
        const entry = managedClaude(state, oldName);
        if (
          state.plugins.some((candidate) => candidate.name === newName) ||
          newName in (state.renames ?? {})
        ) {
          throw new PreconditionError(
            `Claude plugin "${newName}" already exists`,
          );
        }
        entry.name = newName;
        state.renames = { ...(state.renames ?? {}), [oldName]: newName };
        await mutateClaude(
          dataRepo,
          state,
          opts,
          `Rename ${oldName} Claude plugin to ${newName}`,
          {
            verb: "marketplace-plugin-rename",
            plugin: newName,
            fields: { oldName, newName },
          },
        );
      } else {
        const state = await loadCodexState(dataRepo);
        const definition = findCodexDefinition(state, oldName);
        if (state.definitions.some((candidate) => candidate.name === newName)) {
          throw new PreconditionError(
            `Codex plugin "${newName}" already exists`,
          );
        }
        definition.name = newName;
        await mutateCodex(
          dataRepo,
          state,
          opts,
          `Rename ${oldName} Codex plugin to ${newName}`,
          {
            verb: "marketplace-plugin-rename",
            plugin: newName,
            fields: { oldName, newName },
          },
        );
      }
    },
  );

  withMutationOptions(
    plugin
      .command("delete <plugin>")
      .requiredOption("--target <target>", "claude or codex"),
  ).action(async (name: string, opts: CommonOptions, cmd: Command) => {
    const dataRepo = await marketplaceDataRepo(cmd);
    const target = requireTarget(opts.target);
    if (target === "claude") {
      const state = await loadClaudeMarketplace(dataRepo);
      managedClaude(state, name);
      state.plugins = state.plugins.filter((entry) => entry.name !== name);
      state.renames = { ...(state.renames ?? {}), [name]: null };
      await mutateClaude(
        dataRepo,
        state,
        opts,
        `Retire ${name} Claude plugin`,
        { verb: "marketplace-plugin-delete", plugin: name },
      );
    } else {
      const state = await loadCodexState(dataRepo);
      findCodexDefinition(state, name);
      state.definitions = state.definitions.filter(
        (entry) => entry.name !== name,
      );
      await mutateCodex(dataRepo, state, opts, `Retire ${name} Codex plugin`, {
        verb: "marketplace-plugin-delete",
        plugin: name,
      });
    }
  });

  plugin
    .command("pack <plugin>")
    .requiredOption("--target <target>", "claude or codex")
    .requiredOption("--output <path>")
    .option("--from-head")
    .option("--dry-run")
    .option("--json")
    .action(async (name: string, opts: PackOptions, cmd: Command) => {
      const dataRepo = await marketplaceDataRepo(cmd);
      const target = requireTarget(opts.target);
      const output = resolve(opts.output);
      if (target === "claude") {
        const state = opts.fromHead
          ? await loadClaudeMarketplaceAtHead(dataRepo)
          : await loadClaudeMarketplace(dataRepo);
        const entry = managedClaude(state, name);
        const selected = await Promise.all(
          claudePluginSkills(entry).map((skill) =>
            collectSelectedSkill(dataRepo, skill, opts.fromHead),
          ),
        );
        const safeMetadata = Object.fromEntries(
          Object.entries(entry).filter(([key]) =>
            [
              "name",
              "displayName",
              "description",
              "author",
              "homepage",
              "repository",
              "license",
              "keywords",
              "category",
              "tags",
            ].includes(key),
          ),
        );
        const copied = selected.flatMap((skill) =>
          skill.files.map((file) => ({
            ...file,
            path: `skills/${skill.name}/${file.path}`,
          })),
        );
        const hash = logicalContentHash(safeMetadata, copied);
        const version = `0.0.0-capshelf.${hash.slice(0, 12)}`;
        const files = [
          jsonFile(".claude-plugin/plugin.json", { ...safeMetadata, version }),
          ...copied,
        ];
        const result = await publishClaudePackage(
          dataRepo,
          output,
          files,
          opts.dryRun,
        );
        printResult(opts, {
          verb: "marketplace-plugin-pack",
          action: result.action,
          marketplace: state.name,
          plugin: name,
          target,
          artifactType: "file",
          version,
          output,
          ...result.stats,
          contentSha256: hash,
          dirtyInputs: await dirtyPackInputs(
            dataRepo,
            "claude",
            claudePluginSkills(entry),
          ),
          fromHead: opts.fromHead ?? false,
          dryRun: opts.dryRun ?? false,
          warnings: [],
        });
      } else {
        const state = opts.fromHead
          ? await loadCodexStateAtHead(dataRepo)
          : await loadCodexState(dataRepo);
        const definition = findCodexDefinition(state, name);
        const files = await buildCodexProjection(dataRepo, state, {
          only: name,
          fromHead: opts.fromHead,
        });
        const manifest = JSON.parse(
          files
            .find((file) => file.path.endsWith("/.codex-plugin/plugin.json"))!
            .bytes.toString(),
        ) as { version: string };
        const manifestWithoutVersion = structuredClone(manifest) as Record<
          string,
          unknown
        >;
        delete manifestWithoutVersion.version;
        const pluginPrefix = `codex/generated/plugins/${name}/`;
        const pluginContentHash = logicalContentHash(
          manifestWithoutVersion,
          files
            .filter((file) => file.path.startsWith(`${pluginPrefix}skills/`))
            .map((file) => ({
              ...file,
              path: file.path.slice(pluginPrefix.length),
            })),
        );
        const result = await publishCodexPackage(
          dataRepo,
          output,
          files,
          opts.dryRun,
        );
        printResult(opts, {
          verb: "marketplace-plugin-pack",
          action: result.action,
          marketplace: `${state.marketplace.name}-${name}`,
          plugin: name,
          target,
          artifactType: "directory",
          version: manifest.version,
          output,
          ...result.stats,
          contentSha256: pluginContentHash,
          dirtyInputs: await dirtyPackInputs(
            dataRepo,
            "codex",
            definition.skills,
            name,
          ),
          fromHead: opts.fromHead ?? false,
          dryRun: opts.dryRun ?? false,
          warnings: [],
        });
      }
    });
}

function withMutationOptions(command: Command): Command {
  return command
    .option("--dry-run")
    .option("-m, --message <message>")
    .option("--json");
}

async function marketplaceDataRepo(cmd: Command): Promise<string> {
  const project = findProjectRoot();
  const manifest = project ? await loadManifest(project) : null;
  const dataRepo = await resolveDataRepo({
    override: globalOpts(cmd).data,
    manifest,
    project: project ?? undefined,
  });
  await assertIsGitRepo(dataRepo);
  return dataRepo;
}

function requireTarget(target: string | undefined): Target {
  if (target !== "claude" && target !== "codex") {
    throw new PreconditionError('--target must be "claude" or "codex"');
  }
  return target;
}

async function mutateClaude(
  dataRepo: string,
  state: ClaudeMarketplace,
  opts: CommonOptions,
  defaultMessage: string,
  context: MutationContext,
): Promise<void> {
  state = validateClaudeMarketplaceDocument(state);
  const warnings = await validateClaudeMarketplace(dataRepo, state);
  const files = [
    {
      path: ".claude-plugin/marketplace.json",
      bytes: Buffer.from(serializeClaudeMarketplace(state)),
      executable: false,
    },
  ];
  await finishMutation(
    dataRepo,
    "claude",
    [".claude-plugin/marketplace.json"],
    files,
    opts,
    opts.message ?? defaultMessage,
    state.name,
    context,
    warnings,
  );
}

async function mutateCodex(
  dataRepo: string,
  state: CodexState,
  opts: CommonOptions,
  defaultMessage: string,
  context: MutationContext,
): Promise<void> {
  state = validateCodexStateDocument(state);
  for (const definition of state.definitions) {
    for (const skill of definition.skills)
      await collectSelectedSkill(dataRepo, skill);
  }
  const files = [
    ...codexSourceFiles(state),
    ...(await buildCodexProjection(dataRepo, state)),
  ];
  await finishMutation(
    dataRepo,
    "codex",
    ["codex/plugin-definitions", ...CODEX_PROJECTION_ROOTS],
    files,
    opts,
    opts.message ?? defaultMessage,
    state.marketplace.name,
    context,
    overlapWarnings(state.definitions),
  );
}

async function finishMutation(
  dataRepo: string,
  target: Target,
  ownedRoots: string[],
  files: ProjectionFile[],
  opts: CommonOptions,
  message: string,
  marketplace: string,
  context: MutationContext,
  warnings: string[],
): Promise<void> {
  const current = await readFilesBelow(dataRepo, ownedRoots);
  const changes = diffFileSets(current, files);
  const changed = totalChanges(changes) > 0;
  const dirty = !(await isRepoClean(dataRepo));
  const dataRepoHasOrigin = (await originRemoteUrl(dataRepo)) !== null;
  if (!changed) {
    printResult(opts, {
      verb: context.verb,
      action: "unchanged",
      target,
      marketplace,
      ...(context.plugin && { plugin: context.plugin }),
      ...context.fields,
      dataRepo,
      dataRepoHasOrigin,
      committed: false,
      dryRun: opts.dryRun ?? false,
      dirty,
      warnings,
    });
    return;
  }
  if (opts.dryRun) {
    printResult(opts, {
      verb: context.verb,
      action: "planned",
      target,
      marketplace,
      ...(context.plugin && { plugin: context.plugin }),
      ...context.fields,
      dataRepo,
      dataRepoHasOrigin,
      committed: false,
      dryRun: true,
      dirty,
      changedPaths: [
        ...changes.created,
        ...changes.updated,
        ...changes.deleted,
      ],
      warnings,
    });
    return;
  }
  const expectedHead = await headSha(dataRepo);
  const sourceCommit = await commitMarketplaceMutation({
    dataRepo,
    expectedHead,
    message,
    ownedRoots,
    files,
  });
  printResult(opts, {
    verb: context.verb,
    action: "updated",
    target,
    marketplace,
    ...(context.plugin && { plugin: context.plugin }),
    ...context.fields,
    dataRepo,
    dataRepoHasOrigin,
    committed: true,
    sourceCommit,
    dryRun: false,
    projection: target === "codex" ? "current" : undefined,
    changedPaths: [...changes.created, ...changes.updated, ...changes.deleted],
    warnings,
  });
  if (!opts.json) printHandoff(target, dataRepo, context.plugin, marketplace);
}

function printResult(
  opts: { json?: boolean },
  result: Record<string, unknown>,
): void {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${String(result.action)} ${String(result.target ?? "")}`.trim());
  if (result.dataRepo) console.log(`  data repo: ${String(result.dataRepo)}`);
  if (result.output) console.log(`  output: ${String(result.output)}`);
  const warnings = result.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) console.error(`⚠ ${String(warning)}`);
  }
}

function printHandoff(
  target: Target,
  dataRepo: string,
  plugin?: string,
  marketplace?: string,
): void {
  if (target === "codex") {
    console.log("  runtime handoff:");
    console.log(`    codex plugin marketplace add ${dataRepo}`);
    if (plugin && marketplace)
      console.log(`    codex plugin add ${plugin}@${marketplace}`);
  } else {
    console.log(
      "  runtime handoff: upload a packed .plugin in Cowork, or register this marketplace in Claude Code",
    );
  }
}

async function listTarget(
  dataRepo: string,
  target: Target,
): Promise<{
  target: Target;
  sourcePath: string;
  nativeMarketplacePath?: string;
  projection?: string;
  marketplace: { name: string };
  plugins: Array<{
    name: string;
    displayName?: string;
    managed: boolean;
    skills: string[];
    projection?: string;
    generatedPath?: string;
    warnings: string[];
  }>;
} | null> {
  try {
    if (target === "claude") {
      const state = await loadClaudeMarketplace(dataRepo);
      return {
        target,
        sourcePath: resolve(dataRepo, ".claude-plugin/marketplace.json"),
        marketplace: { name: state.name },
        plugins: state.plugins.map((plugin) => ({
          name: plugin.name,
          ...(typeof plugin.displayName === "string" && {
            displayName: plugin.displayName,
          }),
          managed: isManagedClaudePlugin(plugin),
          skills: claudePluginSkills(plugin),
          warnings: isManagedClaudePlugin(plugin)
            ? []
            : ["external Claude entry; mutations are unavailable"],
        })),
      };
    }
    const state = await loadCodexState(dataRepo);
    const projection = await codexProjectionState(dataRepo, state);
    return {
      target,
      sourcePath: resolve(
        dataRepo,
        "codex/plugin-definitions/marketplace.json",
      ),
      nativeMarketplacePath: resolve(
        dataRepo,
        ".agents/plugins/marketplace.json",
      ),
      projection,
      marketplace: { name: state.marketplace.name },
      plugins: state.definitions.map((definition) => ({
        name: definition.name,
        ...(definition.displayName && {
          displayName: definition.displayName,
        }),
        managed: true,
        skills: definition.skills,
        projection,
        generatedPath: `codex/generated/plugins/${definition.name}`,
        warnings: [],
      })),
    };
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

async function showTarget(
  dataRepo: string,
  target: Target,
  name: string,
): Promise<{
  target: Target;
  marketplace: string;
  name: string;
  displayName?: string;
  description?: string;
  managed: boolean;
  skills: string[];
  projection?: string;
  generatedPath?: string;
  source?: unknown;
  warnings: string[];
} | null> {
  try {
    if (target === "claude") {
      const state = await loadClaudeMarketplace(dataRepo);
      const plugin = state.plugins.find((entry) => entry.name === name);
      if (!plugin) return null;
      return {
        target,
        marketplace: state.name,
        name,
        ...(typeof plugin.displayName === "string" && {
          displayName: plugin.displayName,
        }),
        ...(typeof plugin.description === "string" && {
          description: plugin.description,
        }),
        managed: isManagedClaudePlugin(plugin),
        skills: claudePluginSkills(plugin),
        source: plugin.source,
        warnings: isManagedClaudePlugin(plugin)
          ? []
          : ["external Claude entry; mutations are unavailable"],
      };
    }
    const state = await loadCodexState(dataRepo);
    const definition = state.definitions.find((entry) => entry.name === name);
    if (!definition) return null;
    return {
      target,
      marketplace: state.marketplace.name,
      name,
      ...(definition.displayName && {
        displayName: definition.displayName,
      }),
      ...(definition.description && {
        description: definition.description,
      }),
      managed: true,
      skills: definition.skills,
      projection: await codexProjectionState(dataRepo, state),
      generatedPath: `codex/generated/plugins/${definition.name}`,
      warnings: [],
    };
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

async function codexProjectionState(
  dataRepo: string,
  state: CodexState,
): Promise<string> {
  const expected = await buildCodexProjection(dataRepo, state);
  const current = await readFilesBelow(dataRepo, CODEX_PROJECTION_ROOTS);
  return totalChanges(diffFileSets(current, expected)) === 0
    ? "current"
    : "drifted";
}

async function validateAll(
  dataRepo: string,
  opts: ValidateOptions,
): Promise<{
  valid: boolean;
  strict: boolean;
  target: Target | null;
  dataRepo: string;
  targets: Record<Target, Record<string, unknown>>;
  coworkMarketplaceUrl: string | null;
  distributionReady: boolean;
  distributionSupport: "documented" | "user_asserted" | null;
  errors: MarketplaceIssue[];
  warnings: MarketplaceIssue[];
}> {
  const target = opts.target ? requireTarget(opts.target) : null;
  const errors: MarketplaceIssue[] = [];
  const warnings: MarketplaceIssue[] = [];
  const targetReports: Record<Target, Record<string, unknown>> = {
    claude: {
      configured: false,
      valid: true,
      sourcePath: resolve(dataRepo, ".claude-plugin/marketplace.json"),
      limits: {
        maxFiles: COWORK_MAX_FILES,
        maxUncompressedBytes: COWORK_MAX_BYTES,
      },
    },
    codex: {
      configured: false,
      valid: true,
      projection: "not-configured",
      sourcePath: resolve(
        dataRepo,
        "codex/plugin-definitions/marketplace.json",
      ),
      nativeMarketplacePath: resolve(
        dataRepo,
        ".agents/plugins/marketplace.json",
      ),
    },
  };
  if (!(await isRepoClean(dataRepo))) {
    warnings.push({
      code: "dirty_data_repo",
      message: "data repo has uncommitted marketplace inputs",
    });
  }
  const targets = target ? [target] : (["claude", "codex"] as Target[]);
  for (const current of targets) {
    try {
      if (current === "claude") {
        const state = await loadClaudeMarketplace(dataRepo);
        targetReports.claude.configured = true;
        warnings.push(
          ...(await validateClaudeMarketplace(dataRepo, state)).map((warning) =>
            validationWarning("claude", warning),
          ),
        );
        if (state.plugins.length === 0) {
          warnings.push({
            code: "empty_marketplace",
            target: "claude",
            message: "Claude marketplace has no plugins",
          });
        }
        const repository = await gitVisibleStats(dataRepo, ".");
        const plugins = [];
        for (const plugin of state.plugins.filter(isManagedClaudePlugin)) {
          const selected = await Promise.all(
            claudePluginSkills(plugin).map((skill) =>
              collectSelectedSkill(dataRepo, skill),
            ),
          );
          plugins.push({
            name: plugin.name,
            files: selected.reduce(
              (count, skill) => count + skill.files.length,
              0,
            ),
            bytes: selected.reduce(
              (bytes, skill) =>
                bytes +
                skill.files.reduce(
                  (skillBytes, file) => skillBytes + file.bytes.length,
                  0,
                ),
              0,
            ),
          });
        }
        Object.assign(targetReports.claude, {
          repositoryFiles: repository.files,
          repositoryBytes: repository.bytes,
          plugins,
        });
      } else {
        const state = await loadCodexState(dataRepo);
        targetReports.codex.configured = true;
        warnings.push(
          ...overlapWarnings(state.definitions).map((warning) =>
            validationWarning("codex", warning),
          ),
        );
        if (state.definitions.length === 0) {
          warnings.push({
            code: "empty_marketplace",
            target: "codex",
            message: "Codex marketplace has no plugins",
          });
        }
        const expected = await buildCodexProjection(dataRepo, state);
        const generated = await readFilesBelow(
          dataRepo,
          CODEX_PROJECTION_ROOTS,
        );
        const projection =
          totalChanges(diffFileSets(generated, expected)) === 0
            ? "current"
            : "drifted";
        targetReports.codex.projection = projection;
        const selected = await Promise.all(
          [
            ...new Set(
              state.definitions.flatMap((definition) => definition.skills),
            ),
          ].map((skill) => collectSelectedSkill(dataRepo, skill)),
        );
        Object.assign(targetReports.codex, {
          canonicalFiles: selected.reduce(
            (count, skill) => count + skill.files.length,
            0,
          ),
          canonicalBytes: selected.reduce(
            (bytes, skill) =>
              bytes +
              skill.files.reduce(
                (skillBytes, file) => skillBytes + file.bytes.length,
                0,
              ),
            0,
          ),
          generatedFiles: generated.length,
          generatedBytes: generated.reduce(
            (bytes, file) => bytes + file.bytes.length,
            0,
          ),
          projectionDuplicateBytes: expected
            .filter(
              (file) =>
                file.path.includes("/skills/") &&
                file.path.startsWith("codex/generated/plugins/"),
            )
            .reduce((bytes, file) => bytes + file.bytes.length, 0),
        });
        if (projection !== "current") {
          errors.push({
            code: "projection_drift",
            target: "codex",
            message:
              "Codex projection is drifted; run capshelf marketplace sync --target codex",
          });
        }
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        if (target === current || (opts.distribution && current === "claude")) {
          targetReports[current].valid = false;
          errors.push({
            code: "marketplace_not_configured",
            target: current,
            message: `${current} marketplace is not configured`,
          });
        }
        continue;
      }
      targetReports[current].valid = false;
      errors.push({
        code: "target_invalid",
        target: current,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const distribution = await distributionStatus(dataRepo, opts.coworkUrl);
  if (
    opts.distribution &&
    distribution.support === "user_asserted" &&
    distribution.url !== null
  ) {
    warnings.push({
      code: "distribution_support_user_asserted",
      target: "claude",
      url: distribution.url,
      message:
        "Cowork support for this marketplace URL is user-asserted and not classified by Capshelf",
    });
  }
  if (opts.distribution && targetReports.claude.configured !== true) {
    targetReports.claude.valid = false;
    if (
      !errors.some(
        (error) =>
          error.code === "marketplace_not_configured" &&
          error.target === "claude",
      )
    ) {
      errors.push({
        code: "distribution_requires_claude",
        target: "claude",
        message:
          "Claude marketplace must be configured for distribution validation",
      });
    }
  }
  if (opts.distribution && distribution.error) {
    errors.push({
      code: "invalid_distribution_url",
      target: "claude",
      message: distribution.error,
    });
  }
  if (opts.distribution && !distribution.ready && !distribution.error) {
    errors.push({
      code: "distribution_not_ready",
      target: "claude",
      message: "Claude distribution requires a supported HTTPS marketplace URL",
    });
  }
  return {
    valid: errors.length === 0,
    strict: opts.strict ?? false,
    target,
    dataRepo,
    targets: targetReports,
    coworkMarketplaceUrl: distribution.url,
    distributionReady: distribution.ready,
    distributionSupport: distribution.support,
    errors,
    warnings,
  };
}

async function distributionStatus(
  dataRepo: string,
  override: string | undefined,
): Promise<{
  ready: boolean;
  support: "documented" | "user_asserted" | null;
  url: string | null;
  error?: string;
}> {
  if (override !== undefined) {
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      return {
        ready: false,
        support: null,
        url: null,
        error: "--cowork-url must be a valid HTTPS URL",
      };
    }
    if (url.protocol !== "https:") {
      return {
        ready: false,
        support: null,
        url: null,
        error: "--cowork-url must use HTTPS",
      };
    }
    return { ready: true, support: "user_asserted", url: override };
  }
  const origin = (await originRemoteUrl(dataRepo))?.trim() || null;
  if (!origin) return { ready: false, support: null, url: null };
  try {
    const url = new URL(origin);
    const documented = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
    return {
      ready: url.protocol === "https:" && documented.has(url.hostname),
      support:
        url.protocol === "https:" && documented.has(url.hostname)
          ? "documented"
          : null,
      url:
        url.protocol === "https:" && documented.has(url.hostname)
          ? origin
          : null,
    };
  } catch {
    return { ready: false, support: null, url: null };
  }
}

function validationWarning(target: Target, message: string): MarketplaceIssue {
  const overlap =
    /^(skills\/[^ ]+) belongs to multiple (?:Claude|Codex) plugins: (.+)$/.exec(
      message,
    );
  if (overlap) {
    return {
      code: "skill_in_multiple_plugins",
      target,
      skill: overlap[1]!,
      plugins: overlap[2]!.split(", ").sort(),
      message,
    };
  }
  const external = /^external Claude plugin "([^"]+)"/.exec(message);
  if (external) {
    return {
      code: "external_plugin",
      target,
      plugin: external[1]!,
      message,
    };
  }
  return { code: "target_warning", target, message };
}

async function gitVisibleStats(
  dataRepo: string,
  relRoot: string,
): Promise<{ files: number; bytes: number }> {
  const paths = await gitVisibleFilesUnderPath(dataRepo, relRoot);
  let bytes = 0;
  for (const path of paths) {
    const fullPath = relRoot === "." ? path : `${relRoot}/${path}`;
    const parts = fullPath.split("/");
    const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    await assertNoSymlinkAncestors(dataRepo, parent);
    const absolute = join(dataRepo, ...fullPath.split("/"));
    const info = await lstat(absolute);
    bytes += info.isSymbolicLink()
      ? info.size
      : (await readFile(absolute)).length;
  }
  return { files: paths.length, bytes };
}

function managedClaude(state: ClaudeMarketplace, name: string): ClaudePlugin {
  const entry = findClaudePlugin(state, name);
  if (!isManagedClaudePlugin(entry)) {
    throw new PreconditionError(
      `Claude plugin "${name}" is external and cannot be mutated`,
    );
  }
  return entry;
}

function uniqueSkills(refs: string[]): string[] {
  return [
    ...new Set(
      refs.map((ref) => {
        const normalized = ref.startsWith("skills/") ? ref : `skills/${ref}`;
        return normalized;
      }),
    ),
  ].sort();
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function buildCodexDefinition(
  name: string,
  skills: string[],
  opts: PluginOptions,
): CodexPluginDefinition {
  const definition: CodexPluginDefinition = {
    name,
    ...(opts.displayName && { displayName: opts.displayName }),
    ...(opts.description && { description: opts.description }),
    ...(opts.category && { category: opts.category }),
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    skills,
  };
  applyCodexPolicy(definition, opts);
  return definition;
}

function applyCodexPolicy(
  definition: CodexPluginDefinition,
  opts: PluginOptions,
): void {
  if (opts.installation) {
    if (
      !["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
        opts.installation,
      )
    ) {
      throw new PreconditionError("invalid Codex installation policy");
    }
    definition.policy.installation = opts.installation as
      | "NOT_AVAILABLE"
      | "AVAILABLE"
      | "INSTALLED_BY_DEFAULT";
  }
  if (opts.authentication) {
    if (!["ON_INSTALL", "ON_USE"].includes(opts.authentication)) {
      throw new PreconditionError("invalid Codex authentication policy");
    }
    definition.policy.authentication = opts.authentication as
      | "ON_INSTALL"
      | "ON_USE";
  }
}

function changeMembership(
  current: string[],
  refs: string[],
  verb: "add-skill" | "remove-skill",
): { next: string[]; changed: string[] } {
  const changed =
    verb === "add-skill"
      ? refs.filter((skill) => !current.includes(skill))
      : refs.filter((skill) => current.includes(skill));
  const next =
    verb === "add-skill"
      ? [...new Set([...current, ...refs])].sort()
      : current.filter((skill) => !refs.includes(skill)).sort();
  if (next.length === 0) {
    throw new PreconditionError(
      "cannot remove the final skill; delete the plugin instead",
    );
  }
  return { next, changed };
}

function applyPluginEdits(
  entry: Record<string, unknown>,
  opts: PluginOptions,
): void {
  applyOptional(entry, "displayName", opts.displayName, opts.clearDisplayName);
  applyOptional(entry, "description", opts.description, opts.clearDescription);
  applyOptional(entry, "category", opts.category, opts.clearCategory);
}

function applyOwnerEdits(
  owner: Record<string, unknown>,
  opts: EditOptions,
): void {
  if (opts.owner !== undefined) {
    if (!opts.owner.trim())
      throw new PreconditionError("--owner cannot be empty");
    owner.name = opts.owner;
  }
  applyOptional(owner, "email", opts.ownerEmail, opts.clearOwnerEmail);
}

function applyOptional(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
  clear: boolean | undefined,
): void {
  if (value !== undefined && clear) {
    throw new PreconditionError(`cannot set and clear ${key}`);
  }
  if (value !== undefined) target[key] = value;
  if (clear) delete target[key];
}

function assertEditPairs(opts: EditOptions): void {
  if (
    opts.displayName === undefined &&
    opts.owner === undefined &&
    opts.ownerEmail === undefined &&
    opts.description === undefined &&
    !opts.clearDisplayName &&
    !opts.clearOwnerEmail &&
    !opts.clearDescription
  ) {
    throw new PreconditionError("at least one edit is required");
  }
}

function assertPluginEdits(opts: PluginOptions): void {
  if (
    opts.displayName === undefined &&
    opts.description === undefined &&
    opts.category === undefined &&
    opts.installation === undefined &&
    opts.authentication === undefined &&
    !opts.clearDisplayName &&
    !opts.clearDescription &&
    !opts.clearCategory
  ) {
    throw new PreconditionError("at least one plugin edit is required");
  }
}

function overlapWarnings(definitions: CodexPluginDefinition[]): string[] {
  const owners = new Map<string, string[]>();
  for (const definition of definitions) {
    for (const skill of definition.skills) {
      const list = owners.get(skill) ?? [];
      list.push(definition.name);
      owners.set(skill, list);
    }
  }
  return [...owners.entries()]
    .filter(([, plugins]) => plugins.length > 1)
    .map(
      ([skill, plugins]) =>
        `${skill} belongs to multiple Codex plugins: ${plugins.join(", ")}`,
    );
}

function totalChanges(changes: {
  created: string[];
  updated: string[];
  deleted: string[];
}): number {
  return (
    changes.created.length + changes.updated.length + changes.deleted.length
  );
}

async function dirtyPackInputs(
  dataRepo: string,
  target: Target,
  skills: string[],
  plugin?: string,
): Promise<string[]> {
  const sourcePaths =
    target === "claude"
      ? [".claude-plugin/marketplace.json"]
      : [
          "codex/plugin-definitions/marketplace.json",
          `codex/plugin-definitions/${plugin}.json`,
        ];
  const output = await gitText(dataRepo, [
    "--literal-pathspecs",
    "status",
    "--porcelain",
    "--",
    ...sourcePaths,
    ...skills,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.lastIndexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .sort();
}

function sameClaudeIdentity(
  current: ClaudeMarketplace,
  requested: ClaudeMarketplace,
): boolean {
  return (
    current.name === requested.name &&
    current.owner.name === requested.owner.name &&
    current.owner.email === requested.owner.email &&
    current.description === requested.description
  );
}

function sameCodexIdentity(
  current: CodexState,
  requested: CodexState,
): boolean {
  return (
    current.marketplace.name === requested.marketplace.name &&
    current.marketplace.displayName === requested.marketplace.displayName &&
    current.marketplace.owner.name === requested.marketplace.owner.name &&
    current.marketplace.owner.email === requested.marketplace.owner.email
  );
}
