/**
 * `capshelf add <url>`: install a skill, or a whole plugin, from any Git
 * repository.
 *
 * One of the three surfaces that reach the network, and the only one `add` has.
 * A URL on the command line is what makes this command networked; no project
 * state can.
 *
 * The install is local scope and the record is gitignored, by D5. A teammate
 * who clones the project gets neither the files nor the row, which is the
 * opposite of what a user arriving from skills.sh expects — so the success
 * output says so.
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

/** One unit the user chose, with its install name resolved. */
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

/** One picker unit (plugin D5): a whole plugin or one skill. */
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
  /** Set when the installed skill came from a plugin. */
  plugin?: SkillPluginFacts;
  /** Set when a whole plugin was installed: what it runs (D6). */
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
  // Deliberately not `loadAddContext`: that resolves a data repo, and D7 says
  // a remote skill needs none.
  const project = projectRoot();
  const parsed = parseRemoteSkillUrl(input);

  // The network, and the only place this command reaches it.
  const cache = await ensureRemoteCache(
    parsed.cloneUrl,
    parsed.upstream,
    process.env,
  );
  // `ensureClone` clones once and never fetches again, so a second `add` from
  // a repository this machine already holds would resolve the ref against a
  // cache of any age and ask the user to consent to a commit that is not the
  // one upstream has. `add <url>` is documented as a network operation, so it
  // goes to the network. A failed fetch is reported rather than fatal: the
  // cache can still answer, and refusing would break `add` for a warm cache on
  // a machine that is briefly offline.
  if (!cache.cloned) {
    const fetched = await fetchOrigin(cache.path, { prune: true });
    if (!fetched.ok) {
      console.error(
        `⚠ could not fetch ${parsed.upstream}; pinning from the cache this machine already holds`,
      );
      console.error(`  ${fetched.stderr.toString().trim()}`);
    }
  }
  // A browser URL has no delimiter between the branch and the path inside it,
  // so the split is settled against the clone rather than guessed: the longest
  // ref that actually exists wins. Without this, `…/tree/feature/login/skills/x`
  // reads as ref `feature`, which silently installs from the wrong branch when
  // one by that name also exists.
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
  // D10 and D5 share one lookup: `--list` with a plugin path lists that
  // plugin, and a bare `--path` (no `--list`) at the same path refuses before
  // `candidateAtSubpath` ever reads it as a single skill.
  const pluginScope = hasExplicitSubpath
    ? await pluginAtSubpath(
        cache.path,
        commit,
        explicitSubpath,
        parsed.repoName,
      )
    : null;
  // A plugin whose manifest names its own directory as a skill (`"skills":
  // "./"`): `explicitSubpath` is the plugin's source *and* one of its own
  // `skillDirs`. With a Claude manifest it installs whole (below). With none,
  // it installs as a skill, as it did before plugins were installable.
  const pluginRootIsAlsoASkill =
    hasExplicitSubpath &&
    (pluginScope?.plugin.skillDirs.includes(explicitSubpath) ?? false);
  // D3 takes the item name from `.claude-plugin/plugin.json`. Read only for
  // an install at a plugin root, never for `--list`.
  const claudeManifest =
    pluginScope !== null && hasExplicitSubpath && opts.list !== true
      ? await readClaudePluginManifest(cache.path, commit, explicitSubpath)
      : null;
  // A plugin root with a Claude manifest installs whole, even when the
  // manifest also names the root as one of its own skills: the whole plugin
  // wins, so its hooks reach the consent prompt. A self-skill root with no
  // Claude manifest still installs as a skill, below.
  if (
    pluginScope !== null &&
    hasExplicitSubpath &&
    opts.list !== true &&
    (claudeManifest !== null || !pluginRootIsAlsoASkill)
  ) {
    for (const warning of pluginScope.warnings) {
      console.error(`⚠ ${safe(`${warning.path} ${warning.message}`)}`);
    }
    // A plugin with only a Codex manifest, or only a catalog entry, has no
    // Claude manifest name, so it keeps the step 1 refusal.
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
            // Set only for a self-skill plugin root (`pluginRootIsAlsoASkill`).
            // Its catalog or manifest can still warn, and this install reads
            // that plugin.
            warnings: pluginScope?.warnings ?? [],
          };
  // Sanitized like every other repository-controlled string here: a warning
  // about a malformed catalog or manifest quotes the repository's own text.
  for (const warning of discovery.warnings) {
    console.error(`⚠ ${safe(`${warning.path} ${warning.message}`)}`);
  }

  // `--list` answers a question about the repository. It returns before the
  // cardinality rule below, because "too many to install without choosing" is
  // not a reason to refuse to say what is there.
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

  // Plugin D5: the picker takes its unit from the repository shape. A
  // `--path` that reaches here names one skill, and its discovery carries no
  // whole plugin, so the offer is that skill alone.
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
      `add --as names one skill, and ${chosen.length} were selected`,
      { hint: "install them one at a time with --path <subpath> --as <name>" },
    );
  }

  // Every name check runs before the first install, so a refusal leaves no
  // trace. A plugin takes its name from its manifest (D3).
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
    // Record each install before the next one can refuse the command. A save
    // after the loop would leave an earlier skill's files on disk with no row
    // when a later candidate is declined or refused: invisible to every other
    // command, and refused by the next `add` as an unmanaged path. The rest of
    // this feature follows the same rule — write the bytes, then the record,
    // and never leave content with no owner.
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
 * `src/cli.ts`'s `reportError` prints a `CliError`'s `hint` as `` `  ${hint}` ``
 * — one leading two-space indent, added once, before the string's first
 * character. A hint built from several desired on-screen lines must omit
 * that indent from its own first line (the renderer supplies it) and spell
 * every later line's indent itself, because nothing is added after an
 * embedded `\n`.
 */
function multilineHint(lines: readonly string[]): string {
  const [first, ...rest] = lines;
  return [(first ?? "").replace(/^ {2}/, ""), ...rest].join("\n");
}

const WHOLE_PLUGIN_NEEDS_MANIFEST = `capshelf installs a whole plugin only when it holds ${PLUGIN_MANIFEST_REL}`;

/**
 * Step 1 D5, kept for a plugin directory with no regular
 * `.claude-plugin/plugin.json`: `--path`, or a browser URL subpath, naming
 * that directory refuses before it is read as a single skill. D11: it names
 * no Claude or Codex command. The install command it offers names the
 * plugin's first skill in subpath order, the same order `describeCandidates`
 * sorts every other candidate list.
 */
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

/**
 * The plugin's `.claude-plugin/plugin.json` at the commit, parsed. Null when
 * the directory holds no regular blob at that path. A manifest that is not a
 * JSON object refuses: D3 needs its `name`.
 */
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

/**
 * D5: install the whole plugin at `subpath` as a remote row, in local scope,
 * and record it in `remotes`. The caller saves the lock and prints the
 * result. D3 names it from its manifest. D8 refuses a symlink before
 * consent. D7 point 1 asks before the install and shows what the plugin runs
 * (D6). Null when the user declines.
 */
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
    block: renderPluginConsent({
      repo: upstream,
      ref,
      commit,
      path: subpath,
      name,
      version: isConfigString(manifest.version) ? manifest.version : null,
      install: `${relative(project, installedPath(project, kind, name))}  (local scope, gitignored)`,
      files: summary.files,
      runs,
      license: describeLicense(license),
      description: isConfigString(manifest.description)
        ? manifest.description
        : null,
    }),
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

/** D3: Claude Code names a plugin from its manifest, so `--as` refuses. */
function refusePluginRename(name: string, opts: RemoteAddOptions): void {
  if (opts.as === undefined) return;
  throw new PreconditionError(
    `cannot rename a plugin: Claude Code names it from plugin.json ("${name}")`,
    {
      hint: `agents are called as ${name}:<agent>, whatever the directory name is`,
    },
  );
}

/**
 * D3: the manifest `name` is the item name. It must be a string that a
 * named command can address, and not the name of a system item, which owns
 * the same folder.
 */
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

/** D8: a symlink or a submodule refuses, with one plugin hint line. */
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

/**
 * D7 point 1. A remote add always asks. `--yes` skips the question, so it
 * prints what the plugin runs to stderr instead, where `--json` cannot see
 * it. With `--json` or no terminal, the refusal names what the plugin runs.
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
 * D6: two or more selected skills that would install under the same name
 * collide, and the check runs after `--as` is resolved and before any
 * project write — `loadRemotesLock` included, so a refused install leaves no
 * trace. `<subpath>` and `<name>` in the hint are literal placeholders, not
 * one of the actual colliding values, because a group can hold more than two
 * and no single pair is "the" example; they are not shell-quoted, because
 * they are not real arguments.
 *
 * A picked plugin installs to the same folder as a skill of its name, so it
 * joins the check. A group that holds a plugin says "items", not "skills".
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
  // Every colliding name, not only the first found — a picker selection can
  // reuse more than one name at once, and naming only one would send the
  // user back here a second time for the next.
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
  // A skill whose tree holds a plugin manifest loads in Claude Code as a
  // plugin and runs its hooks (R1), so the prompt shows what it runs.
  const runs = await itemPluginRunsAtCommit(cachePath, kind, pin.entries);

  // The already-current check runs *before* the ownership checks, and the
  // order is required. `findInstallConflict` reports any existing output path
  // with no exemption for the row that wrote it, so running it first would
  // make a second `add <same-url>` refuse instead of reporting the no-op.
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

/**
 * The recorded row when it already pins this exact tree from this upstream,
 * ref, and subpath, and the installed files match it. Null when no such row
 * exists. Refuses when the row matches but the files do not.
 */
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
  // The record matching the pin says nothing about the files. Reporting
  // `already current` beside a path that was deleted or edited would make the
  // obvious repair command a silent no-op, so the install is measured. The
  // reconcile itself belongs to `apply`, which owns the destructive plan that
  // gates a local edit; this only names it.
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
 * Every owner that could already hold the name, each naming the record that
 * holds it. Runs only for a row that is new or changed.
 *
 * The checks for the same kind come first, because they name the exact
 * command that frees the name. `assertSkillTargetFree` then covers the other
 * kind that installs to the same folder (spec D2 guard 5). It exempts an
 * unmanaged folder when `self` is null, so `findInstallConflict` stays last
 * and still refuses a folder that capshelf does not manage.
 */
async function assertNameAvailable(input: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  remotes: RemotesLock;
  upstream: string;
  subpath: string;
  /** The command that installs this item, for the switch message. */
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
  // Same repository means the row is not a name collision at all: the caller
  // reached here because the upstream moved past the pin, and the command that
  // moves a pin is `update`. Naming a "different repository" would be false,
  // and `rm`/`--as` would answer a question nobody asked. A plugin takes its
  // name from its manifest (D3), so two directories of one repository can
  // name the same plugin. Only the same directory is the same row.
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
 * The first browser split whose ref exists in the clone, or null.
 *
 * `refCandidates` is ordered longest ref first, so a branch named
 * `feature/login` is preferred over one named `feature` when both exist — the
 * URL that produced this was written against the longer one.
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

/**
 * The picker row's `detail`: the plugin's source directory, plus the "uses"
 * label when it names anything, so a picker row carries the same facts the
 * consent prompt and `--list` show.
 */
function pickDetail(candidate: RemoteSkillCandidate): string {
  if (candidate.plugin === undefined) return candidate.subpath;
  const uses = usesLabel(candidate.plugin);
  const source = candidate.plugin.plugin.source;
  return uses === "" ? source : `${source} · ${uses}`;
}

/**
 * A plugin row's id. A skill row's id is its subpath, which never starts
 * with "/" (`isSafeItemRoot`), so the two can never be equal.
 */
function pluginRowId(source: string): string {
  return `/${source}`;
}

function unitRow(unit: Unit): PickRow {
  if (unit.kind === "plugins") {
    const { plugin, whole } = unit.offered;
    return {
      ref: `plugins/${plugin.name}`,
      id: pluginRowId(plugin.source),
      kind: "plugins",
      name: plugin.name,
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

/**
 * D17: never guess. One unit installs, several open the picker, and with no
 * terminal the command names the two flags that answer the question. The
 * unit comes from the repository shape (plugin D5): a plugin row for each
 * whole plugin, then a skill row for each skill that no such plugin holds.
 */
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
  /** What the skill runs as a plugin, or null when it holds no manifest. */
  runs: PluginRuns | null;
  opts: RemoteAddOptions;
}): Promise<boolean> {
  const { runs } = input;
  if (input.opts.yes === true) {
    // D4/D7: `--yes` skips the prompt, so this is the only place the facts
    // block reaches a `--yes` install. It goes to stderr, never stdout, so
    // `--json` still parses.
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

/**
 * `  plugin    <name>` and, when the skill uses nothing outside itself and
 * every file was checked, a note that says so — the same condition that
 * decides whether `renderPluginFacts` prints anything at all.
 */
function pluginLine(facts: SkillPluginFacts): string {
  const noParts = facts.usesPluginParts.length === 0 && facts.factsComplete;
  return `  plugin    ${safe(facts.plugin.name)}${noParts ? "  (no parts outside the skill)" : ""}`;
}

function describeLicense(license: LicenseFinding): string {
  if (license.path === null)
    return "none found in the item or at the repo root";
  const where = license.insideItem
    ? "inside the item, copied with it"
    : "at the repo root, outside the item, not copied";
  return `${license.label ?? "unrecognized"}  (${safe(license.path)}, ${where})`;
}

/**
 * The reason text for one skipped catalog entry (`external-source` excluded
 * — it becomes the `elsewhere` summary line, not a warning). `entry.source`
 * is absent for some `unsafe-path` entries (for example a Codex `local`
 * source with no `path` at all); the text then leaves the source out
 * rather than naming the entry itself as its source.
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
      // The caller filters this reason out; the elsewhere line covers it.
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
  // Skipped entries other than `external-source` (which becomes the
  // `elsewhere` summary line) are warnings about catalog entries this
  // listing could not read.
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

  // D9: a long plugin listing asks before it floods the terminal. A pipe,
  // `--json` (already handled above), and `--yes` print the full list with no
  // question, so scripts and `| less` work as today. A listing with no
  // plugin *skill* never asks — `discovery.plugins` also holds a
  // commands-only plugin, which must not count — which is what keeps a
  // capshelf-shaped shelf byte-identical in a terminal too (D2).
  const skillPlugins = discovery.plugins.filter(hasSkills);
  // Plugin D5: a listing that offers a whole plugin asks too, and the
  // question counts the picker's unit. A plugin-scoped listing (D10) lists
  // that plugin's skills, so it counts skills.
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
  // The "no" answer, D9. When the listing is already scoped to one plugin
  // (D10), naming that same plugin back would repeat the command the user
  // just ran, so only the JSON command prints, in the same scope. Otherwise
  // the plugin-scoped command names the first plugin *with a skill* in
  // listing order — a commands-only plugin has nothing to install — so the
  // user has a short next step instead of the whole list.
  if (scope === "repository") {
    // SAFETY: `askBeforeShowingAll` already required `skillPlugins.length >
    // 0` or `wholePlugins.length > 0` above, in this same function, with no
    // intervening mutation.
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
 * D9's question. Loops on anything that is not an explicit yes or no, and a
 * rejected prompt counts as "no" the same as typing it. Closed input (EOF)
 * rejects the prompt. So does Ctrl-C at the question: readline holds the
 * terminal in raw mode, reads Ctrl-C as a key, and closes, so no SIGINT is
 * sent. Both exit 0 with the "no" text, as D9 says.
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
            // Plugin D5: added fields only. `installable` says whether
            // `--path <source>` installs the whole plugin.
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

/**
 * D7: the fields a plugin skill adds to a JSON row, the same in the `--list`
 * rows and in the install result rows.
 */
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

/** D11's JSON shape for what a plugin runs: two counts and the unknown list. */
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
      // R1, R5: Claude Code loads a plugin from a skills folder under the
      // name `<plugin>@skills-dir`, and only after the workspace is trusted.
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
