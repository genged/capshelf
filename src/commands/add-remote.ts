/**
 * The install is local scope and gitignored, so a teammate cloning the project
 * gets neither files nor the row; the success output says so.
 */
import type { Command } from "commander";
import { relative } from "node:path";
import type { ConfigObject, ConfigValue } from "../config-values";
import { isConfigObject, isConfigString } from "../config-values";
import { PreconditionError } from "../errors";
import {
  UnsupportedGitEntryError,
  catFileBlobs,
  fetchOrigin,
  literalPathspec,
  lsTreeEntriesForPathspecs,
} from "../git";
import { confirmationContext } from "../destructive-change";
import type { DestructiveConfirmationContext } from "../destructive-change";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { findInstallConflict, installedPath } from "../installed";
import {
  isAddressableItemName,
  parseItemRef,
  lockKeyForRef,
} from "../item-ref";
import { loadLocalLock, loadLock } from "../lock";
import { ensureLocalExcludes } from "../local-config";
import { PRODUCT_NAME } from "../identity";
import { PLUGIN_MANIFEST_REL } from "../master";
import {
  assertNoDestinationCollisions,
  pinItemAtCommit,
  shortIdentity,
} from "../pin";
import type { PinnedSource } from "../pin";
import { projectRoot } from "../paths";
import { pickItems } from "../pick";
import type { PickRow } from "../pick-core";
import {
  pluginConsentReason,
  pluginRunsField,
  renderPluginConsent,
} from "../plugin-consent";
import { isRegularFile, pluginPath } from "../plugin-discovery";
import type { DiscoveredPlugin, SkippedEntry } from "../plugin-discovery";
import {
  itemPluginRunsAtCommit,
  pluginRunsAtCommit,
  runsHaveEntries,
} from "../plugin-runs";
import type { PluginRuns } from "../plugin-runs";
import type { SkillPluginFacts } from "../plugin-facts";
import {
  defaultCachedBranch,
  ensureRemoteCache,
  resolveCachedRef,
} from "../remote-cache";
import {
  candidateAtSubpath,
  discoverRemoteSkills,
  findLicense,
  pickerOffer,
  pluginAtSubpath,
  remoteTreeSource,
  summarizeCandidate,
} from "../remote-discovery";
import type {
  LicenseFinding,
  OfferedPlugin,
  PickerOffer,
  RemoteDiscovery,
  RemoteSkillCandidate,
} from "../remote-discovery";
import { installRemoteItem, reconcileRemoteItem } from "../remote-item";
import {
  factsWarnOnInstall,
  formatBytes,
  hasSkills,
  plural,
  pluginPickDetail,
  renderCandidateList,
  renderPluginFacts,
  safe,
  unitCount,
  usesLabel,
} from "../remote-list-render";
import { parseRemoteSkillUrl } from "../remote-url";
import type { BrowserRefCandidate, RemoteSkillUrl } from "../remote-url";
import {
  loadRemotesLock,
  remoteKey,
  remoteKeysForRef,
  saveRemotesLock,
} from "../remotes-lock";
import type {
  RemoteItemKind,
  RemoteLockEntry,
  RemotesLock,
} from "../remotes-lock";
import { isSafeItemName } from "../assert";
import { isSystemItemName } from "../bundled";
import { shellCommand } from "../shell-quote";
import { assertSkillTargetFree } from "../skill-target";

export interface RemoteAddOptions {
  json?: boolean;
  local?: boolean;
  target?: string;
  yes?: boolean;
  as?: string;
  ref?: string;
  path?: string;
  list?: boolean;
}

type Selected =
  | {
      kind: "skills";
      name: string;
      subpath: string;
      candidate: RemoteSkillCandidate;
    }
  | {
      kind: "plugins";
      name: string;
      subpath: string;
      manifest: ConfigObject;
    };

type Unit =
  | { kind: "plugins"; offered: OfferedPlugin }
  | { kind: "skills"; candidate: RemoteSkillCandidate };

interface Installed {
  kind: RemoteItemKind;
  name: string;
  subpath: string;
  path: string;
  sha: string;
  action: "created" | "already-current";
  files: number;
  license: string | null;
  plugin?: SkillPluginFacts;
  runs?: PluginRuns;
}

export async function addRemoteSkill(
  input: string,
  opts: RemoteAddOptions,
  _cmd: Command,
): Promise<void> {
  if (opts.target) {
    throw new PreconditionError(
      "add --target is not supported; a remote skill installs one directory",
    );
  }
  // Deliberately not `loadAddContext`: a remote skill needs no data repo.
  const project = projectRoot();
  const parsed = parseRemoteSkillUrl(input);

  const cache = await ensureRemoteCache(
    parsed.cloneUrl,
    parsed.upstream,
    process.env,
  );
  // `ensureClone` never fetches after the first clone, so fetch here to avoid
  // consenting to a stale commit; a failed fetch only warns so a warm cache
  // still works offline.
  if (!cache.cloned) {
    const fetched = await fetchOrigin(cache.path, { prune: true });
    if (!fetched.ok) {
      console.error(
        `⚠ could not fetch ${parsed.upstream}; pinning from the cache this machine already holds`,
      );
      console.error(`  ${fetched.stderr.toString().trim()}`);
    }
  }
  // A browser URL has no delimiter between branch and path, so the longest ref
  // that exists in the clone wins; otherwise `feature/login` would silently
  // resolve to `feature`.
  const browser =
    opts.ref === undefined
      ? await firstResolvableCandidate(cache.path, parsed.refCandidates)
      : null;
  const ref =
    opts.ref ??
    browser?.ref ??
    parsed.ref ??
    (await defaultCachedBranch(cache.path));
  if (ref === null) {
    throw new PreconditionError(
      `${parsed.upstream} published no default branch`,
      { hint: "name one: --ref <branch-or-tag>" },
    );
  }
  const commit = await resolveCachedRef(cache.path, ref);
  if (commit === null) {
    throw new PreconditionError(`${parsed.upstream} has no ref named ${ref}`, {
      hint: `list the repository's skills: ${PRODUCT_NAME} add ${input} --list`,
    });
  }

  const explicitSubpath = opts.path ?? browser?.subpath ?? parsed.subpath;
  const hasExplicitSubpath =
    explicitSubpath !== null && explicitSubpath !== undefined;
  // Check plugin scope first to avoid treating a plugin root as one skill,
  // except when the root is itself a skill and has no Claude manifest.
  const pluginScope = hasExplicitSubpath
    ? await pluginAtSubpath(
        cache.path,
        commit,
        explicitSubpath,
        parsed.repoName,
      )
    : null;
  const pluginRootIsAlsoASkill =
    hasExplicitSubpath &&
    (pluginScope?.plugin.skillDirs.includes(explicitSubpath) ?? false);
  // Read only for an install at a plugin root, never for `--list`, since the
  // item name comes from `.claude-plugin/plugin.json`.
  const claudeManifest =
    pluginScope !== null && hasExplicitSubpath && opts.list !== true
      ? await readClaudePluginManifest(cache.path, commit, explicitSubpath)
      : null;
  // With a Claude manifest the whole plugin wins even if it names its root as a
  // skill, so its hooks reach the consent prompt.
  if (
    pluginScope !== null &&
    hasExplicitSubpath &&
    opts.list !== true &&
    (claudeManifest !== null || !pluginRootIsAlsoASkill)
  ) {
    for (const warning of pluginScope.warnings) {
      console.error(`⚠ ${safe(`${warning.path} ${warning.message}`)}`);
    }
    if (claudeManifest === null) throw pluginRootRefusal(input, pluginScope);
    const name = pluginItemName(explicitSubpath, claudeManifest);
    refusePluginRename(name, opts);
    const remotes = await loadRemotesLock(project);
    const outcome = await installWholePlugin({
      project,
      parsed,
      cachePath: cache.path,
      ref,
      commit,
      subpath: explicitSubpath,
      name,
      manifest: claudeManifest,
      remotes,
      opts,
    });
    if (outcome === null) return;
    if (outcome.action === "created") await saveRemotesLock(project, remotes);
    printInstalled(parsed, ref, commit, [outcome], opts);
    return;
  }
  const discovery: RemoteDiscovery =
    pluginScope !== null && (opts.list === true || !pluginRootIsAlsoASkill)
      ? {
          candidates: pluginScope.candidates,
          plugins: [pluginScope.plugin],
          skipped: [],
          warnings: pluginScope.warnings,
          wholePlugins: pluginScope.whole === null ? [] : [pluginScope.whole],
        }
      : !hasExplicitSubpath
        ? await discoverRemoteSkills(cache.path, commit, parsed.repoName)
        : {
            candidates: [
              await candidateAtSubpath(
                cache.path,
                commit,
                explicitSubpath,
                parsed.repoName,
              ),
            ],
            plugins: [],
            skipped: [],
            warnings: pluginScope?.warnings ?? [],
          };
  // Warnings quote repository-controlled text, so sanitize them.
  for (const warning of discovery.warnings) {
    console.error(`⚠ ${safe(`${warning.path} ${warning.message}`)}`);
  }

  // `--list` returns before the cardinality check: too many candidates is no
  // reason to refuse to list them.
  if (opts.list === true) {
    await printCandidateList(
      input,
      parsed,
      ref,
      commit,
      discovery,
      pluginScope !== null ? { plugin: pluginScope.plugin } : "repository",
      opts,
    );
    return;
  }

  const offer = pickerOffer(
    hasExplicitSubpath ? { ...discovery, wholePlugins: [] } : discovery,
  );
  if (offer.plugins.length === 0 && offer.skills.length === 0) {
    throw new PreconditionError(
      `no skill found in ${parsed.upstream} at ${ref}`,
      {
        hint: "capshelf looks for SKILL.md at the repository root and under skills/, .claude/skills/, and .agents/skills/ and in plugins named by .claude-plugin/marketplace.json or .agents/plugins/marketplace.json",
      },
    );
  }

  const chosen = await chooseUnits(offer, parsed);
  if (chosen.length === 0) return;
  if (chosen.length > 1 && opts.as !== undefined) {
    throw new PreconditionError(
      `add --as names one item, and ${chosen.length} were selected`,
      { hint: "install them one at a time with --path <subpath> --as <name>" },
    );
  }

  // All name checks run before the first install so a refusal leaves no trace.
  const selected: Selected[] = [];
  for (const unit of chosen) {
    if (unit.kind === "plugins") {
      const subpath = unit.offered.plugin.source;
      const manifest = await readClaudePluginManifest(
        cache.path,
        commit,
        subpath,
      );
      if (manifest === null) {
        throw new PreconditionError(
          `${safe(pluginPath(subpath, PLUGIN_MANIFEST_REL))} is not a regular file at ${commit}`,
        );
      }
      const name = pluginItemName(subpath, manifest);
      refusePluginRename(name, opts);
      selected.push({ kind: "plugins", name, subpath, manifest });
      continue;
    }
    const { candidate } = unit;
    const name = opts.as ?? candidate.defaultName;
    if (!isSafeItemName(name)) {
      throw new PreconditionError(
        `${candidate.subpath} would install under an unusable item name: ${name}`,
        { hint: "choose one with --as <name>" },
      );
    }
    if (isSystemItemName(name)) {
      throw new PreconditionError(
        `"${name}" is a system item — managed by the CLI, not installable from a repository`,
      );
    }
    selected.push({
      kind: "skills",
      name,
      subpath: candidate.subpath,
      candidate,
    });
  }
  assertNoNameCollision(input, selected);

  const remotes = await loadRemotesLock(project);
  const results: Installed[] = [];
  for (const unit of selected) {
    const outcome =
      unit.kind === "plugins"
        ? await installWholePlugin({
            project,
            parsed,
            cachePath: cache.path,
            ref,
            commit,
            subpath: unit.subpath,
            name: unit.name,
            manifest: unit.manifest,
            remotes,
            opts,
          })
        : await installOne({
            project,
            cachePath: cache.path,
            kind: "skills",
            commit,
            ref,
            upstream: parsed.upstream,
            candidate: unit.candidate,
            name: unit.name,
            remotes,
            opts,
          });
    // Save the lock after each install, not after the loop: a later refusal
    // would otherwise leave installed files with no row, which the next `add`
    // refuses as unmanaged.
    if (outcome !== null && outcome.action === "created") {
      await saveRemotesLock(project, remotes);
    }
    if (outcome === null) {
      if (results.length > 0)
        printInstalled(parsed, ref, commit, results, opts);
      return;
    }
    results.push(outcome);
  }
  printInstalled(parsed, ref, commit, results, opts);
}

/**
 * `reportError` adds one two-space indent before the hint's first character
 * only, so the first line omits it and later lines spell their own.
 */
function multilineHint(lines: readonly string[]): string {
  const [first, ...rest] = lines;
  return [(first ?? "").replace(/^ {2}/, ""), ...rest].join("\n");
}

const WHOLE_PLUGIN_NEEDS_MANIFEST = `capshelf installs a whole plugin only when it holds ${PLUGIN_MANIFEST_REL}`;

function pluginRootRefusal(
  url: string,
  scope: {
    plugin: DiscoveredPlugin;
    candidates: RemoteSkillCandidate[];
  },
): PreconditionError {
  const source = safe(scope.plugin.source);
  if (scope.candidates.length === 0) {
    return new PreconditionError(`${source} is a plugin with no skills`, {
      hint: WHOLE_PLUGIN_NEEDS_MANIFEST,
    });
  }
  const skillLines = scope.candidates.map((candidate) =>
    `    ${safe(candidate.subpath)}   ${usesLabel(candidate.plugin)}`.trimEnd(),
  );
  const installCommand = safe(
    shellCommand([
      PRODUCT_NAME,
      "add",
      url,
      "--path",
      scope.candidates[0]!.subpath,
    ]),
  );
  return new PreconditionError(
    `${source} is a plugin, not a skill. It holds ${scope.candidates.length} ${plural(scope.candidates.length, "skill")}:`,
    {
      hint: multilineHint([
        ...skillLines,
        `  install the skill: ${installCommand}`,
        `  ${WHOLE_PLUGIN_NEEDS_MANIFEST}`,
      ]),
    },
  );
}

async function readClaudePluginManifest(
  repo: string,
  commit: string,
  subpath: string,
): Promise<ConfigObject | null> {
  const manifestPath = pluginPath(subpath, PLUGIN_MANIFEST_REL);
  const entries = await lsTreeEntriesForPathspecs(repo, commit, [
    literalPathspec(manifestPath),
  ]);
  const entry = entries.find(
    (candidate) => candidate.path === manifestPath && isRegularFile(candidate),
  );
  if (entry === undefined) return null;
  const bytes = (await catFileBlobs(repo, [entry.object])).get(entry.object);
  let parsed: ConfigValue = null;
  try {
    parsed = JSON.parse(bytes?.toString("utf8") ?? "");
  } catch {
    // Not JSON: refused below with the object case.
  }
  if (!isConfigObject(parsed)) {
    throw new PreconditionError(
      `${safe(manifestPath)} is not a JSON object, so capshelf cannot read the plugin name`,
    );
  }
  return parsed;
}

async function installWholePlugin(input: {
  project: string;
  parsed: RemoteSkillUrl;
  cachePath: string;
  ref: string;
  commit: string;
  subpath: string;
  name: string;
  manifest: ConfigObject;
  remotes: RemotesLock;
  opts: RemoteAddOptions;
}): Promise<Installed | null> {
  const { project, parsed, cachePath, ref, commit, subpath, name, manifest } =
    input;
  const { remotes, opts } = input;
  const kind: RemoteItemKind = "plugins";
  const upstream = parsed.upstream;

  const pin = await pinPlugin(cachePath, commit, subpath, name);
  const current = await currentRow({
    project,
    kind,
    name,
    remotes,
    upstream,
    ref,
    subpath,
    pin,
  });
  const runs = await pluginRunsAtCommit(cachePath, pin.entries);
  if (current !== null) {
    return {
      kind,
      name,
      subpath,
      path: installedPath(project, kind, name),
      sha: current.sourcePinDigest,
      action: "already-current",
      files: pin.entries.length,
      license: null,
      runs,
    };
  }

  await assertNameAvailable({
    project,
    kind,
    name,
    remotes,
    upstream,
    subpath,
    addCommand: shellCommand([
      PRODUCT_NAME,
      "add",
      upstream,
      "--path",
      subpath,
    ]),
  });

  const [summary, license] = await Promise.all([
    summarizeCandidate(cachePath, commit, subpath),
    findLicense(cachePath, commit, subpath),
  ]);
  const approved = await confirmPluginInstall({
    name,
    runs,
    opts,
    block: renderPluginConsent(
      {
        repo: upstream,
        ref,
        commit,
        path: subpath,
        name,
        version: isConfigString(manifest.version) ? manifest.version : null,
        install: `${relative(project, installedPath(project, kind, name))}  (local scope, gitignored)`,
        files: summary.files,
        runs,
        license: describeLicense(license, "plugin"),
        description: isConfigString(manifest.description)
          ? manifest.description
          : null,
      },
      consentWidth(),
    ),
  });
  if (!approved) return null;

  const destination = installedPath(project, kind, name);
  await assertNoDestinationCollisions(
    `${kind}/${name}`,
    destination,
    pin.entries.map((entry) => entry.path),
  );
  const result = await installRemoteItem({
    project,
    cachePath,
    kind,
    name,
    upstream,
    ref,
    subpath,
    pin,
  });
  await ensureLocalExcludes(project, kind, name);
  remotes.items[remoteKey(kind, name)] = result.entry;
  return {
    kind,
    name,
    subpath,
    path: result.path,
    sha: result.entry.sourcePinDigest,
    action: result.action,
    files: result.files,
    license: license.label,
    runs,
  };
}

function refusePluginRename(name: string, opts: RemoteAddOptions): void {
  if (opts.as === undefined) return;
  throw new PreconditionError(
    `cannot rename a plugin: Claude Code names it from plugin.json ("${name}")`,
    {
      hint: `agents are called as ${name}:<agent>, whatever the directory name is`,
    },
  );
}

function pluginItemName(subpath: string, manifest: ConfigObject): string {
  const name = manifest.name;
  const manifestPath = safe(pluginPath(subpath, PLUGIN_MANIFEST_REL));
  if (!isConfigString(name)) {
    throw new PreconditionError(`${manifestPath} has no "name" string`, {
      hint: "Claude Code names a plugin from that field, and capshelf uses the same name",
    });
  }
  if (!isAddressableItemName("plugins", name)) {
    throw new PreconditionError(
      `${safe(subpath)} would install under an unusable item name: ${safe(name)}`,
      {
        hint: `the name comes from ${manifestPath}, and capshelf does not rename a plugin`,
      },
    );
  }
  if (isSystemItemName(name)) {
    throw new PreconditionError(
      `"${name}" is a system item — managed by the CLI, not installable from a repository`,
    );
  }
  return name;
}

async function pinPlugin(
  cachePath: string,
  commit: string,
  subpath: string,
  name: string,
): Promise<PinnedSource> {
  try {
    return await pinItemAtCommit(
      remoteTreeSource(cachePath, commit, subpath),
      "plugins",
      name,
    );
  } catch (error) {
    if (!(error instanceof UnsupportedGitEntryError)) throw error;
    throw new PreconditionError(safe(error.message), {
      hint: "this plugin cannot be installed by capshelf",
      cause: error,
    });
  }
}

function consentWidth(): number {
  return process.stderr.isTTY === true ? (process.stderr.columns ?? 80) : 80;
}

/**
 * With `--yes` the plugin's runs are printed to stderr rather than stdout, so
 * `--json` consumers never see them mixed into the result; with `--json` or no
 * terminal it refuses instead of asking.
 */
async function confirmPluginInstall(input: {
  name: string;
  runs: PluginRuns;
  block: string[];
  opts: RemoteAddOptions;
}): Promise<boolean> {
  const { name, runs, opts } = input;
  if (opts.yes === true) {
    if (runsHaveEntries(runs)) {
      for (const line of pluginRunsField(runs)) console.error(line);
    }
    return true;
  }
  const context = confirmationContext();
  if (opts.json === true || !context.stdinIsTTY || !context.stderrIsTTY) {
    throw new PreconditionError(
      `not installing plugins/${name} without consent — ${pluginConsentReason(runs)}`,
      {
        hint: multilineHint([
          ...pluginRunsField(runs),
          "  review it first, then authorize with --yes",
        ]),
      },
    );
  }
  const answer = await context.prompt(
    `${input.block.join("\n")}\nInstall it? [y/N] `,
  );
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  context.stderr.write("Add cancelled; nothing was installed.\n");
  return false;
}

/**
 * Runs before any project write so a refusal leaves no trace; the hint's
 * `<subpath>` and `<name>` are literal placeholders because a group can hold
 * more than two entries.
 */
function assertNoNameCollision(
  url: string,
  selected: readonly Selected[],
): void {
  const byName = new Map<string, Selected[]>();
  for (const entry of selected) {
    const group = byName.get(entry.name);
    if (group === undefined) byName.set(entry.name, [entry]);
    else group.push(entry);
  }
  // List every colliding name, not just the first, so the user is not sent back
  // for the next.
  const collisionLines = [...byName.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([name, group]) => {
      const subpaths = group.map((entry) => safe(entry.subpath)).join(", ");
      const noun = group.every((entry) => entry.kind === "skills")
        ? "skills"
        : "items";
      return `${group.length} selected ${noun} would install as "${safe(name)}": ${subpaths}`;
    });
  if (collisionLines.length === 0) return;
  const prefix = shellCommand([PRODUCT_NAME, "add", url]);
  throw new PreconditionError(collisionLines[0]!, {
    hint: multilineHint([
      ...collisionLines.slice(1),
      `  install them one at a time: ${safe(prefix)} --path <subpath> --as <name>`,
    ]),
  });
}

async function installOne(input: {
  project: string;
  cachePath: string;
  kind: RemoteItemKind;
  commit: string;
  ref: string;
  upstream: string;
  candidate: RemoteSkillCandidate;
  name: string;
  remotes: RemotesLock;
  opts: RemoteAddOptions;
}): Promise<Installed | null> {
  const {
    project,
    cachePath,
    kind,
    commit,
    ref,
    upstream,
    candidate,
    name,
    remotes,
  } = input;
  const pin = await pinItemAtCommit(
    remoteTreeSource(cachePath, commit, candidate.subpath),
    kind,
    name,
  );
  // Claude Code loads a skill whose tree holds a plugin manifest as a plugin
  // and runs its hooks, so the prompt shows what it runs.
  const runs = await itemPluginRunsAtCommit(cachePath, kind, pin.entries);

  // Must run before the ownership checks: `findInstallConflict` has no
  // exemption for the row's own output, so a repeat `add <same-url>` would
  // refuse instead of reporting a no-op.
  const current = await currentRow({
    project,
    kind,
    name,
    remotes,
    upstream,
    ref,
    subpath: candidate.subpath,
    pin,
  });
  if (current !== null) {
    return {
      kind,
      name,
      subpath: candidate.subpath,
      path: installedPath(project, kind, name),
      sha: current.sourcePinDigest,
      action: "already-current",
      files: pin.entries.length,
      license: null,
      plugin: candidate.plugin,
    };
  }

  await assertNameAvailable({
    project,
    kind,
    name,
    remotes,
    upstream,
    subpath: candidate.subpath,
    addCommand: shellCommand([
      PRODUCT_NAME,
      "add",
      upstream,
      "--path",
      candidate.subpath,
    ]),
  });

  const [summary, license] = await Promise.all([
    summarizeCandidate(cachePath, commit, candidate.subpath),
    findLicense(cachePath, commit, candidate.subpath),
  ]);
  const approved = await confirmInstall({
    project,
    upstream,
    ref,
    commit,
    candidate,
    kind,
    name,
    summary,
    license,
    runs,
    opts: input.opts,
  });
  if (!approved) return null;

  const destination = installedPath(project, kind, name);
  await assertNoDestinationCollisions(
    `${kind}/${name}`,
    destination,
    pin.entries.map((entry) => entry.path),
  );

  const result = await installRemoteItem({
    project,
    cachePath,
    kind,
    name,
    upstream,
    ref,
    subpath: candidate.subpath,
    pin,
  });
  await ensureLocalExcludes(project, kind, name);
  remotes.items[remoteKey(kind, name)] = result.entry;
  return {
    kind,
    name,
    subpath: candidate.subpath,
    path: result.path,
    sha: result.entry.sourcePinDigest,
    action: result.action,
    files: result.files,
    license: license.label,
    plugin: candidate.plugin,
  };
}

async function currentRow(input: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  remotes: RemotesLock;
  upstream: string;
  ref: string;
  subpath: string;
  pin: PinnedSource;
}): Promise<RemoteLockEntry | null> {
  const { project, kind, name, upstream } = input;
  const existing = input.remotes.items[remoteKey(kind, name)];
  if (
    existing === undefined ||
    existing.upstream !== upstream ||
    existing.ref !== input.ref ||
    existing.subpath !== input.subpath ||
    existing.sourcePinDigest !== input.pin.sourcePinDigest
  ) {
    return null;
  }
  // A matching record says nothing about the files, so measure the install;
  // reporting `already current` over a deleted or edited path would make the
  // repair a silent no-op.
  const measured = await reconcileRemoteItem({
    project,
    kind,
    name,
    entry: existing,
    dryRun: true,
  });
  if (measured.action !== "already-current") {
    throw new PreconditionError(
      `${kind}/${name} is already pulled from ${upstream} at this commit, but the installed files do not match it`,
      {
        hint: `restore them: ${PRODUCT_NAME} apply ${kind}/${name}`,
      },
    );
  }
  return existing;
}

/**
 * Same-kind checks run first because they name the command that frees the name;
 * `findInstallConflict` stays last to still refuse an unmanaged folder.
 */
async function assertNameAvailable(input: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  remotes: RemotesLock;
  upstream: string;
  subpath: string;
  addCommand: string;
}): Promise<void> {
  const { project, kind, name, remotes, upstream } = input;
  const ref = parseItemRef(`${kind}/${name}`);
  const projectLock = await loadLock(project);
  if (lockKeyForRef(projectLock, ref, "data")) {
    throw new PreconditionError(
      `${kind}/${name} is already tracked in project scope (.capshelf/capshelf.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${kind}/${name}`,
      },
    );
  }
  const localLock = await loadLocalLock(project);
  if (lockKeyForRef(localLock, ref, "data")) {
    throw new PreconditionError(
      `${kind}/${name} is already tracked in local scope (.capshelf/local.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${kind}/${name} --local`,
      },
    );
  }
  const held = remoteKeysForRef(remotes, ref).map((key) => remotes.items[key]!);
  // The same row is not a name collision: the upstream moved past the pin,
  // which `update` handles. A plugin row is the same only for the same
  // directory, since two directories can share a manifest name.
  const sameRow = held.some(
    (entry) =>
      entry.upstream === upstream &&
      (kind === "skills" || entry.subpath === input.subpath),
  );
  if (sameRow) {
    throw new PreconditionError(
      `${kind}/${name} is already pulled from ${upstream}, at a different commit (.capshelf/remotes.lock.json)`,
      {
        hint: `move the pin instead: ${PRODUCT_NAME} update ${kind}/${name}`,
      },
    );
  }
  if (held.length > 0) {
    // SAFETY: the condition on the line above makes `held` non-empty.
    const other = held[0]!;
    const where =
      other.upstream === upstream
        ? `from ${upstream} at ${safe(other.subpath)}`
        : "from a different repository";
    throw new PreconditionError(
      `${kind}/${name} is already pulled ${where} (.capshelf/remotes.lock.json)`,
      {
        hint:
          kind === "plugins"
            ? `remove it first: ${PRODUCT_NAME} rm ${kind}/${name}`
            : `remove it first: ${PRODUCT_NAME} rm ${kind}/${name}, or install under another name with --as`,
      },
    );
  }
  const external = await findSkillsShSkill(project, name);
  if (external) {
    throw new PreconditionError(
      `not installing ${kind}/${name} — ${skillsShConflictMessage(external)}`,
    );
  }
  await assertSkillTargetFree(
    project,
    kind,
    name,
    { project: projectLock, local: localLock, remotes },
    null,
    { addCommand: safe(input.addCommand) },
  );
  const conflict = findInstallConflict(project, kind, name);
  if (conflict) {
    throw new PreconditionError(
      `not installing ${kind}/${name} — the install path already exists and capshelf does not manage it`,
      { hint: `existing path: ${conflict}` },
    );
  }
}

/**
 * Candidates are ordered longest ref first so `feature/login` wins over
 * `feature` when both exist.
 */
async function firstResolvableCandidate(
  cachePath: string,
  candidates: readonly BrowserRefCandidate[],
): Promise<BrowserRefCandidate | null> {
  for (const candidate of candidates) {
    if ((await resolveCachedRef(cachePath, candidate.ref)) !== null) {
      return candidate;
    }
  }
  return null;
}

function pickDetail(candidate: RemoteSkillCandidate): string {
  if (candidate.plugin === undefined) return candidate.subpath;
  const uses = usesLabel(candidate.plugin);
  const source = candidate.plugin.plugin.source;
  return uses === "" ? source : `${source} · ${uses}`;
}

/**
 * The leading "/" keeps plugin row ids from ever equaling a skill subpath,
 * which `isSafeItemRoot` guarantees never starts with "/".
 */
function pluginRowId(source: string): string {
  return `/${source}`;
}

function unitRow(unit: Unit): PickRow {
  if (unit.kind === "plugins") {
    const { plugin, whole } = unit.offered;
    // The name is repository text not validated until install, so sanitize it
    // here; the picker sanitizes only detail and description.
    const name = safe(plugin.name);
    return {
      ref: `plugins/${name}`,
      id: pluginRowId(plugin.source),
      kind: "plugins",
      name,
      ...(whole.description !== null && { description: whole.description }),
      tags: [],
      installed: false,
      detail: pluginPickDetail(plugin, whole.agents),
    };
  }
  const { candidate } = unit;
  return {
    ref: `skills/${candidate.defaultName}`,
    id: candidate.subpath,
    kind: "skills",
    name: candidate.defaultName,
    ...(candidate.description !== null && {
      description: candidate.description,
    }),
    tags: [],
    installed: false,
    detail: pickDetail(candidate),
  };
}

async function chooseUnits(
  offer: PickerOffer,
  parsed: RemoteSkillUrl,
): Promise<Unit[]> {
  const units: Unit[] = [
    ...offer.plugins.map((offered): Unit => ({ kind: "plugins", offered })),
    ...offer.skills.map((candidate): Unit => ({ kind: "skills", candidate })),
  ];
  if (units.length === 1) return units;
  const hasPlugins = offer.plugins.length > 0;
  const what = !hasPlugins
    ? "skills"
    : offer.skills.length > 0
      ? "plugins and skills"
      : "plugins";
  const picked = await pickItems({
    rows: units.map(unitRow),
    message: `Select ${what} to install from ${parsed.upstream}`,
    ...(hasPlugins && { kindOrder: ["plugins", "skills"] }),
  });
  if (picked.kind === "cancelled") return [];
  if (picked.kind === "unavailable") {
    throw new PreconditionError(
      `${unitCount(offer)} found in ${parsed.upstream}; name one with --path`,
      {
        hint: `list them: ${PRODUCT_NAME} add ${parsed.cloneUrl} --list`,
      },
    );
  }
  const byId = new Map(
    units.map((unit) => [
      unit.kind === "plugins"
        ? pluginRowId(unit.offered.plugin.source)
        : unit.candidate.subpath,
      unit,
    ]),
  );
  return picked.refs.flatMap((id) => {
    const unit = byId.get(id);
    return unit ? [unit] : [];
  });
}

async function confirmInstall(input: {
  project: string;
  upstream: string;
  ref: string;
  commit: string;
  candidate: RemoteSkillCandidate;
  kind: RemoteItemKind;
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
  runs: PluginRuns | null;
  opts: RemoteAddOptions;
}): Promise<boolean> {
  const { runs } = input;
  if (input.opts.yes === true) {
    // `--yes` skips the prompt, so print to stderr, never stdout, to keep
    // `--json` parseable.
    const facts = input.candidate.plugin;
    if (factsWarnOnInstall(facts)) {
      for (const line of renderPluginFacts(facts!)) console.error(line);
    }
    if (runs !== null && runsHaveEntries(runs)) {
      for (const line of pluginRunsField(runs)) console.error(line);
    }
    return true;
  }
  const context = confirmationContext();
  const block = renderConsent(input);
  if (input.opts.json === true || !context.stdinIsTTY || !context.stderrIsTTY) {
    const review = `review it first, then authorize with --yes. See what it holds: ${PRODUCT_NAME} add <url> --list`;
    throw new PreconditionError(
      runs === null
        ? `not installing ${input.kind}/${input.name} without consent — capshelf does not review this content, and your agent runs it with your permissions`
        : `not installing ${input.kind}/${input.name} without consent — ${pluginConsentReason(runs)}`,
      {
        hint:
          runs === null
            ? review
            : multilineHint([...pluginRunsField(runs), `  ${review}`]),
      },
    );
  }
  const answer = await context.prompt(`${block}\nInstall it? [y/N] `);
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  context.stderr.write("Add cancelled; nothing was installed.\n");
  return false;
}

function renderConsent(input: {
  project: string;
  upstream: string;
  ref: string;
  commit: string;
  candidate: RemoteSkillCandidate;
  kind: RemoteItemKind;
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
  runs: PluginRuns | null;
}): string {
  const installPath = relative(
    input.project,
    installedPath(input.project, input.kind, input.name),
  );
  const width = Math.max(
    ...input.summary.files.map((file) => file.path.length),
    1,
  );
  const facts = input.candidate.plugin;
  const filesCount = input.summary.files.length;
  return [
    `  repo      ${safe(input.upstream)}`,
    `  ref       ${safe(input.ref)}`,
    `  commit    ${safe(input.commit)}`,
    `  path      ${safe(input.candidate.subpath)}${input.candidate.subpath === "." ? "  (SKILL.md at the repo root)" : ""}`,
    ...(facts === undefined ? [] : [pluginLine(facts)]),
    `  install   ${installPath}  (local scope, gitignored)`,
    `  files     ${filesCount} ${plural(filesCount, "file")}, ${formatBytes(input.summary.totalBytes)}`,
    ...input.summary.files.map(
      (file) =>
        `              ${safe(file.path).padEnd(width)}  ${formatBytes(file.bytes)}`,
    ),
    ...(input.runs === null ? [] : pluginRunsField(input.runs)),
    `  license   ${describeLicense(input.license)}`,
    "",
    ...(factsWarnOnInstall(facts) ? [...renderPluginFacts(facts!), ""] : []),
    ...(input.candidate.description === null
      ? []
      : [`  ${input.name}: ${safe(input.candidate.description)}`, ""]),
    "  capshelf does not review this content. Your agent runs it with your permissions.",
  ].join("\n");
}

function pluginLine(facts: SkillPluginFacts): string {
  const noParts = facts.usesPluginParts.length === 0 && facts.factsComplete;
  return `  plugin    ${safe(facts.plugin.name)}${noParts ? "  (no parts outside the skill)" : ""}`;
}

function describeLicense(
  license: LicenseFinding,
  subject: "item" | "plugin" = "item",
): string {
  if (license.path === null)
    return "none found in the item or at the repo root";
  const where = license.insideItem
    ? "inside the item, copied with it"
    : `at the repo root, outside the ${subject}, not copied`;
  const label =
    subject === "plugin"
      ? (license.label ?? "not recognized")
      : (license.label ?? "unrecognized");
  return `${label}  (${safe(license.path)}, ${where})`;
}

/**
 * `entry.source` can be absent for `unsafe-path` entries, so the text omits it
 * rather than naming the entry as its own source.
 */
function skipReasonText(entry: SkippedEntry): string {
  const source = entry.source;
  switch (entry.reason) {
    case "unsafe-path":
      return source === undefined ? "unsafe source" : `unsafe source ${source}`;
    case "missing":
      return source === undefined
        ? "does not exist at this commit"
        : `${source} does not exist at this commit`;
    case "not-a-file":
      return source === undefined
        ? "is a symlink or submodule"
        : `${source} is a symlink or submodule`;
    case "nested-plugin":
      return source === undefined
        ? "is inside another plugin"
        : `${source} is inside another plugin`;
    case "external-source":
      return "external source";
  }
}

async function printCandidateList(
  input: string,
  parsed: RemoteSkillUrl,
  ref: string,
  commit: string,
  discovery: RemoteDiscovery,
  scope: "repository" | { plugin: DiscoveredPlugin },
  opts: RemoteAddOptions,
): Promise<void> {
  for (const entry of discovery.skipped) {
    if (entry.reason === "external-source") continue;
    console.error(
      `⚠ ${safe(`${entry.catalog} catalog entry "${entry.name}": ${skipReasonText(entry)}, skipped`)}`,
    );
  }
  if (opts.json === true) {
    printCandidateListJson(parsed, ref, commit, discovery);
    return;
  }
  const { lines, summaryLength } = renderCandidateList({
    url: input,
    upstream: parsed.upstream,
    ref,
    commit,
    discovery,
    scope,
  });

  const skillPlugins = discovery.plugins.filter(hasSkills);
  const offer = scope === "repository" ? pickerOffer(discovery) : null;
  const wholePlugins = offer?.plugins ?? [];
  const context = confirmationContext();
  const askBeforeShowingAll =
    opts.yes !== true &&
    context.stdinIsTTY &&
    context.stdoutIsTTY === true &&
    context.stderrIsTTY &&
    context.terminalRows !== null &&
    context.terminalRows !== undefined &&
    context.terminalRows > 0 &&
    (skillPlugins.length > 0 || wholePlugins.length > 0) &&
    lines.length > context.terminalRows;
  if (!askBeforeShowingAll) {
    for (const line of lines) console.log(line);
    return;
  }

  for (const line of lines.slice(0, summaryLength)) console.log(line);
  const skillCount = discovery.candidates.length;
  const showAll = await confirmShowAll(
    context,
    offer !== null && wholePlugins.length > 0
      ? unitCount(offer)
      : `${skillCount} ${plural(skillCount, "skill")}`,
    lines.length,
  );
  if (showAll) {
    for (const line of lines.slice(summaryLength)) console.log(line);
    return;
  }
  // When the listing is already plugin-scoped, only the JSON command prints,
  // since naming the same plugin would repeat the command just run.
  if (scope === "repository") {
    // SAFETY: `askBeforeShowingAll` above required `skillPlugins` or
    // `wholePlugins` to be non-empty, and neither changes in between.
    const firstPlugin = skillPlugins[0] ?? wholePlugins[0]!.plugin;
    console.log(
      `  one plugin:   ${safe(shellCommand([PRODUCT_NAME, "add", input, "--list", "--path", firstPlugin.source]))}`,
    );
  }
  const scopeArgs =
    scope === "repository" ? [] : ["--path", scope.plugin.source];
  console.log(
    `  everything:   ${safe(shellCommand([PRODUCT_NAME, "add", input, "--list", ...scopeArgs, "--json"]))}`,
  );
}

/**
 * A rejected prompt counts as "no": EOF rejects it, and Ctrl-C does too because
 * readline's raw mode reads it as a key and closes, so no SIGINT is sent.
 */
async function confirmShowAll(
  context: DestructiveConfirmationContext,
  units: string,
  lineCount: number,
): Promise<boolean> {
  for (;;) {
    let answer: string;
    try {
      answer = await context.prompt(
        `Show all ${units} (${lineCount} lines)? [Y/n] `,
      );
    } catch {
      return false;
    }
    const normalized = answer.trim().toLowerCase();
    if (normalized === "" || normalized === "y" || normalized === "yes") {
      return true;
    }
    if (normalized === "n" || normalized === "no") return false;
  }
}

function printCandidateListJson(
  parsed: RemoteSkillUrl,
  ref: string,
  commit: string,
  discovery: RemoteDiscovery,
): void {
  console.log(
    JSON.stringify(
      {
        verb: "add",
        source: "remote",
        repo: parsed.upstream,
        ref,
        commit,
        skills: discovery.candidates.map((candidate) => ({
          subpath: candidate.subpath,
          name: candidate.defaultName,
          description: candidate.description,
          origin: candidate.origin,
          ...(candidate.plugin !== undefined && {
            ...pluginJsonFields(candidate.plugin),
            ...(candidate.plugin.unread.length > 0 && {
              unread: candidate.plugin.unread,
            }),
          }),
        })),
        plugins: discovery.plugins.map((plugin) => {
          const whole = discovery.wholePlugins?.find(
            (candidate) => candidate.source === plugin.source,
          );
          return {
            name: plugin.name,
            source: plugin.source,
            catalogs: plugin.catalogs,
            ships: plugin.ships,
            skills: plugin.skillDirs.length,
            installable: whole !== undefined,
            description: whole?.description ?? null,
            skillSubpaths: discovery.candidates
              .filter(
                (candidate) =>
                  candidate.plugin?.plugin.source === plugin.source,
              )
              .map((candidate) => candidate.subpath),
          };
        }),
        skipped: discovery.skipped,
        warnings: discovery.warnings,
      },
      null,
      2,
    ),
  );
}

function pluginJsonFields(facts: SkillPluginFacts) {
  return {
    plugin: {
      name: facts.plugin.name,
      source: facts.plugin.source,
      catalogs: facts.plugin.catalogs,
    },
    usesPluginParts: facts.usesPluginParts,
    factsComplete: facts.factsComplete,
  };
}

function runsJsonField(runs: PluginRuns) {
  return {
    hooks: runs.hooks.length,
    mcpServers: runs.mcpServers.length,
    unknown: runs.unknown,
  };
}

function printInstalled(
  parsed: RemoteSkillUrl,
  ref: string,
  commit: string,
  results: Installed[],
  opts: RemoteAddOptions,
): void {
  const first = results[0];
  if (first === undefined) return;
  if (opts.json === true) {
    console.log(
      JSON.stringify(
        results.length === 1
          ? {
              verb: "add",
              source: "remote",
              kind: first.kind,
              name: first.name,
              scope: "local",
              action: first.action,
              sha: first.sha,
              sourceCommit: commit,
              upstream: parsed.upstream,
              ref,
              subpath: first.subpath,
              path: first.path,
              license: first.license,
              files: first.files,
              ...(first.plugin !== undefined && pluginJsonFields(first.plugin)),
              ...(first.runs !== undefined && {
                runs: runsJsonField(first.runs),
              }),
            }
          : {
              verb: "add",
              source: "remote",
              scope: "local",
              upstream: parsed.upstream,
              ref,
              sourceCommit: commit,
              items: results.map((result) => ({
                kind: result.kind,
                name: result.name,
                action: result.action,
                sha: result.sha,
                subpath: result.subpath,
                path: result.path,
                license: result.license,
                files: result.files,
                ...(result.plugin !== undefined &&
                  pluginJsonFields(result.plugin)),
                ...(result.runs !== undefined && {
                  runs: runsJsonField(result.runs),
                }),
              })),
            },
        null,
        2,
      ),
    );
    return;
  }
  if (results.length === 1 && first.action === "already-current") {
    console.log(
      `= already current local/${remoteKey(first.kind, first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  ${first.path}`);
    return;
  }
  if (results.length === 1) {
    console.log(
      `✓ added local/${remoteKey(first.kind, first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  source commit: ${commit}`);
    console.log(`  ${first.path}`);
    if (first.kind === "plugins") {
      // Claude Code loads a plugin from a skills folder as
      // `<plugin>@skills-dir`, and only once the workspace is trusted.
      console.log(
        `  Claude Code loads it as ${first.name}@skills-dir in a trusted workspace`,
      );
    }
  } else {
    for (const result of results) {
      console.log(
        `+ ${`${result.kind}/${result.name}`.padEnd(33)} @ ${shortIdentity(result.sha)}`,
      );
    }
    console.log("");
    console.log(`✓ ${results.length} added from one clone`);
    for (const result of results) console.log(`  ${result.path}`);
    for (const result of results) {
      if (result.kind !== "plugins") continue;
      console.log(
        `  Claude Code loads plugins/${result.name} as ${result.name}@skills-dir in a trusted workspace`,
      );
    }
  }
  console.log("  not committed, so your teammates do not get it");
  console.log(
    `  to give it to the team: ${PRODUCT_NAME} share ${first.kind}/${first.name} --adopt`,
  );
}
