/**
 * `capshelf add <url>`: install a skill from any Git repository.
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
import { PreconditionError } from "../errors";
import { fetchOrigin } from "../git";
import { confirmationContext } from "../destructive-change";
import type { DestructiveConfirmationContext } from "../destructive-change";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { findInstallConflict, installedPath } from "../installed";
import { parseItemRef, lockKeyForRef } from "../item-ref";
import { loadLocalLock, loadLock } from "../lock";
import { ensureLocalExcludes } from "../local-config";
import { PRODUCT_NAME } from "../identity";
import {
  assertNoDestinationCollisions,
  pinItemAtCommit,
  shortIdentity,
} from "../pin";
import { projectRoot } from "../paths";
import { pickItems } from "../pick";
import { sanitizeDisplayText } from "../pick-core";
import type { PickRow } from "../pick-core";
import {
  CLAUDE_CATALOG_PATH,
  CODEX_CATALOG_PATH,
  lastSegment,
} from "../plugin-discovery";
import type {
  DiscoveredPlugin,
  PluginCatalog,
  PluginPart,
  SkippedEntry,
} from "../plugin-discovery";
import type { PluginFactReason, SkillPluginFacts } from "../plugin-facts";
import {
  defaultCachedBranch,
  ensureRemoteCache,
  resolveCachedRef,
} from "../remote-cache";
import {
  candidateAtSubpath,
  discoverRemoteSkills,
  findLicense,
  pluginAtSubpath,
  remoteTreeSource,
  summarizeCandidate,
} from "../remote-discovery";
import type {
  LicenseFinding,
  RemoteDiscovery,
  RemoteSkillCandidate,
} from "../remote-discovery";
import { installRemoteSkill, reconcileRemoteSkill } from "../remote-item";
import { parseRemoteSkillUrl } from "../remote-url";
import type { BrowserRefCandidate, RemoteSkillUrl } from "../remote-url";
import {
  REMOTE_ITEM_KIND,
  loadRemotesLock,
  remoteKey,
  remoteKeysForRef,
  saveRemotesLock,
} from "../remotes-lock";
import type { RemotesLock } from "../remotes-lock";
import { isSafeItemName } from "../assert";
import { isSystemItemName } from "../bundled";
import { shellCommand } from "../shell-quote";

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

interface Selected {
  candidate: RemoteSkillCandidate;
  name: string;
}

interface Installed {
  name: string;
  subpath: string;
  path: string;
  sha: string;
  action: "created" | "already-current";
  files: number;
  license: string | null;
  /** Set when the installed skill came from a plugin. */
  plugin?: SkillPluginFacts;
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
  // "./"`) installs exactly as it did before this feature: `explicitSubpath`
  // is the plugin's source *and* one of its own `skillDirs`, so it is not a
  // plugin *root* in the D5 sense, even though `pluginAtSubpath` found it.
  const pluginRootIsAlsoASkill =
    hasExplicitSubpath &&
    (pluginScope?.plugin.skillDirs.includes(explicitSubpath) ?? false);
  if (pluginScope !== null && opts.list !== true && !pluginRootIsAlsoASkill) {
    for (const warning of pluginScope.warnings) {
      console.error(`⚠ ${safe(`${warning.path} ${warning.message}`)}`);
    }
    throw pluginRootRefusal(input, pluginScope);
  }
  const discovery: RemoteDiscovery =
    pluginScope !== null && (opts.list === true || !pluginRootIsAlsoASkill)
      ? {
          candidates: pluginScope.candidates,
          plugins: [pluginScope.plugin],
          skipped: [],
          warnings: pluginScope.warnings,
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
            warnings: [],
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

  if (discovery.candidates.length === 0) {
    throw new PreconditionError(
      `no skill found in ${parsed.upstream} at ${ref}`,
      {
        hint: "capshelf looks for SKILL.md at the repository root and under skills/, .claude/skills/, and .agents/skills/ and in plugins named by .claude-plugin/marketplace.json or .agents/plugins/marketplace.json",
      },
    );
  }

  const chosen = await chooseCandidates(discovery.candidates, parsed);
  if (chosen.length === 0) return;
  if (chosen.length > 1 && opts.as !== undefined) {
    throw new PreconditionError(
      `add --as names one skill, and ${chosen.length} were selected`,
      { hint: "install them one at a time with --path <subpath> --as <name>" },
    );
  }

  const selected: Selected[] = chosen.map((candidate) => ({
    candidate,
    name: opts.as ?? candidate.defaultName,
  }));
  for (const { candidate, name } of selected) {
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
  }
  assertNoNameCollision(input, selected);

  const remotes = await loadRemotesLock(project);
  const results: Installed[] = [];
  for (const { candidate, name } of selected) {
    const outcome = await installOne({
      project,
      cachePath: cache.path,
      commit,
      ref,
      upstream: parsed.upstream,
      candidate,
      name,
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

/**
 * D5: `--path`, or a browser URL subpath, naming a plugin directory refuses
 * before it is read as a single skill. D11: it names no Claude or Codex
 * command. The install command it offers names the plugin's first skill in
 * subpath order, the same order `describeCandidates` sorts every other
 * candidate list.
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
      hint: "capshelf cannot install a whole plugin",
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
        "  capshelf cannot install a whole plugin",
      ]),
    },
  );
}

/**
 * D6: two or more selected skills that would install under the same name
 * collide, and the check runs after `--as` is resolved and before any
 * project write — `loadRemotesLock` included, so a refused install leaves no
 * trace. `<subpath>` and `<name>` in the hint are literal placeholders, not
 * one of the actual colliding values, because a group can hold more than two
 * and no single pair is "the" example; they are not shell-quoted, because
 * they are not real arguments.
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
      const subpaths = group
        .map((entry) => safe(entry.candidate.subpath))
        .join(", ");
      return `${group.length} selected skills would install as "${safe(name)}": ${subpaths}`;
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
    commit,
    ref,
    upstream,
    candidate,
    name,
    remotes,
  } = input;
  const pin = await pinItemAtCommit(
    remoteTreeSource(cachePath, commit, candidate.subpath),
    REMOTE_ITEM_KIND,
    name,
  );

  // The already-current check runs *before* the ownership checks, and the
  // order is required. `findInstallConflict` reports any existing output path
  // with no exemption for the row that wrote it, so running it first would
  // make a second `add <same-url>` refuse instead of reporting the no-op.
  const existing = remotes.items[remoteKey(name)];
  if (
    existing !== undefined &&
    existing.upstream === upstream &&
    existing.ref === ref &&
    existing.subpath === candidate.subpath &&
    existing.sourcePinDigest === pin.sourcePinDigest
  ) {
    // The record matching the pin says nothing about the files. Reporting
    // `already current` beside a path that was deleted or edited would make the
    // obvious repair command a silent no-op, so the install is measured. The
    // reconcile itself belongs to `apply`, which owns the destructive plan that
    // gates a local edit; this only names it.
    const measured = await reconcileRemoteSkill({
      project,
      name,
      entry: existing,
      dryRun: true,
    });
    if (measured.action !== "already-current") {
      throw new PreconditionError(
        `${REMOTE_ITEM_KIND}/${name} is already pulled from ${upstream} at this commit, but the installed files do not match it`,
        {
          hint: `restore them: ${PRODUCT_NAME} apply ${REMOTE_ITEM_KIND}/${name}`,
        },
      );
    }
    return {
      name,
      subpath: candidate.subpath,
      path: installedPath(project, REMOTE_ITEM_KIND, name),
      sha: existing.sourcePinDigest,
      action: "already-current",
      files: pin.entries.length,
      license: null,
      plugin: candidate.plugin,
    };
  }

  await assertNameAvailable(project, name, remotes, upstream);

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
    name,
    summary,
    license,
    opts: input.opts,
  });
  if (!approved) return null;

  const destination = installedPath(project, REMOTE_ITEM_KIND, name);
  await assertNoDestinationCollisions(
    `${REMOTE_ITEM_KIND}/${name}`,
    destination,
    pin.entries.map((entry) => entry.path),
  );

  const result = await installRemoteSkill({
    project,
    cachePath,
    name,
    upstream,
    ref,
    subpath: candidate.subpath,
    pin,
  });
  await ensureLocalExcludes(project, REMOTE_ITEM_KIND, name);
  remotes.items[remoteKey(name)] = result.entry;
  return {
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
 * Every owner that could already hold the name, each naming the record that
 * holds it. Runs only for a row that is new or changed.
 */
async function assertNameAvailable(
  project: string,
  name: string,
  remotes: RemotesLock,
  upstream: string,
): Promise<void> {
  const ref = parseItemRef(`${REMOTE_ITEM_KIND}/${name}`);
  const projectLock = await loadLock(project);
  if (lockKeyForRef(projectLock, ref, "data")) {
    throw new PreconditionError(
      `${REMOTE_ITEM_KIND}/${name} is already tracked in project scope (.capshelf/capshelf.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${REMOTE_ITEM_KIND}/${name}`,
      },
    );
  }
  const localLock = await loadLocalLock(project);
  if (lockKeyForRef(localLock, ref, "data")) {
    throw new PreconditionError(
      `${REMOTE_ITEM_KIND}/${name} is already tracked in local scope (.capshelf/local.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${REMOTE_ITEM_KIND}/${name} --local`,
      },
    );
  }
  const held = remoteKeysForRef(remotes, ref).map((key) => remotes.items[key]!);
  // Same repository means the row is not a name collision at all: the caller
  // reached here because the upstream moved past the pin, and the command that
  // moves a pin is `update`. Naming a "different repository" would be false,
  // and `rm`/`--as` would answer a question nobody asked.
  const sameUpstream = held.some((entry) => entry.upstream === upstream);
  if (sameUpstream) {
    throw new PreconditionError(
      `${REMOTE_ITEM_KIND}/${name} is already pulled from ${upstream}, at a different commit (.capshelf/remotes.lock.json)`,
      {
        hint: `move the pin instead: ${PRODUCT_NAME} update ${REMOTE_ITEM_KIND}/${name}`,
      },
    );
  }
  if (held.length > 0) {
    throw new PreconditionError(
      `${REMOTE_ITEM_KIND}/${name} is already pulled from a different repository (.capshelf/remotes.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${REMOTE_ITEM_KIND}/${name}, or install under another name with --as`,
      },
    );
  }
  const external = await findSkillsShSkill(project, name);
  if (external) {
    throw new PreconditionError(
      `not installing ${REMOTE_ITEM_KIND}/${name} — ${skillsShConflictMessage(external)}`,
    );
  }
  const conflict = findInstallConflict(project, REMOTE_ITEM_KIND, name);
  if (conflict) {
    throw new PreconditionError(
      `not installing ${REMOTE_ITEM_KIND}/${name} — the install path already exists and capshelf does not manage it`,
      { hint: `existing path: ${conflict}` },
    );
  }
}

/**
 * D17: never guess. One candidate installs, several open the picker, and with
 * no terminal the command names the two flags that answer the question.
 */
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

async function chooseCandidates(
  candidates: RemoteSkillCandidate[],
  parsed: RemoteSkillUrl,
): Promise<RemoteSkillCandidate[]> {
  if (candidates.length === 1) return candidates;
  const rows: PickRow[] = candidates.map((candidate) => ({
    ref: `${REMOTE_ITEM_KIND}/${candidate.defaultName}`,
    id: candidate.subpath,
    kind: REMOTE_ITEM_KIND,
    name: candidate.defaultName,
    ...(candidate.description !== null && {
      description: candidate.description,
    }),
    tags: [],
    installed: false,
    detail: pickDetail(candidate),
  }));
  const picked = await pickItems({
    rows,
    message: `Select skills to install from ${parsed.upstream}`,
  });
  if (picked.kind === "cancelled") return [];
  if (picked.kind === "unavailable") {
    throw new PreconditionError(
      `${candidates.length} skills found in ${parsed.upstream}; name one with --path`,
      {
        hint: `list them: ${PRODUCT_NAME} add ${parsed.cloneUrl} --list`,
      },
    );
  }
  const bySubpath = new Map(
    candidates.map((candidate) => [candidate.subpath, candidate]),
  );
  return picked.refs.flatMap((id) => {
    const candidate = bySubpath.get(id);
    return candidate ? [candidate] : [];
  });
}

/**
 * D4/D7: `--yes` skips the prompt, so this is the only place that block
 * reaches a `--yes` install — on stderr, never stdout, so `--json` still
 * parses. It prints nothing when the skill is not a plugin skill, or uses
 * nothing outside itself and every file was checked.
 */
function printPluginFactsWarning(facts: SkillPluginFacts | undefined): void {
  if (!factsWarnOnInstall(facts)) return;
  for (const line of renderPluginFacts(facts!)) console.error(line);
}

async function confirmInstall(input: {
  project: string;
  upstream: string;
  ref: string;
  commit: string;
  candidate: RemoteSkillCandidate;
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
  opts: RemoteAddOptions;
}): Promise<boolean> {
  if (input.opts.yes === true) {
    printPluginFactsWarning(input.candidate.plugin);
    return true;
  }
  const context = confirmationContext();
  const block = renderConsent(input);
  if (input.opts.json === true || !context.stdinIsTTY || !context.stderrIsTTY) {
    throw new PreconditionError(
      `not installing ${REMOTE_ITEM_KIND}/${input.name} without consent — capshelf does not review this content, and your agent runs it with your permissions`,
      {
        hint: `review it first, then authorize with --yes. See what it holds: ${PRODUCT_NAME} add <url> --list`,
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
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
}): string {
  const installPath = relative(
    input.project,
    installedPath(input.project, REMOTE_ITEM_KIND, input.name),
  );
  const width = Math.max(
    ...input.summary.files.map((file) => file.path.length),
    1,
  );
  const facts = input.candidate.plugin;
  const filesCount = input.summary.files.length;
  return [
    `  repo      ${input.upstream}`,
    `  ref       ${input.ref}`,
    `  commit    ${input.commit}`,
    `  path      ${safe(input.candidate.subpath)}${input.candidate.subpath === "." ? "  (SKILL.md at the repo root)" : ""}`,
    ...(facts === undefined ? [] : [pluginLine(facts)]),
    `  install   ${installPath}  (local scope, gitignored)`,
    `  files     ${filesCount} ${plural(filesCount, "file")}, ${formatBytes(input.summary.totalBytes)}`,
    ...input.summary.files.map(
      (file) =>
        `              ${safe(file.path).padEnd(width)}  ${formatBytes(file.bytes)}`,
    ),
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

/**
 * Whether a consent prompt (install's, or `src/commands/update.ts`'s pin-move
 * prompt) owes the reader the `renderPluginFacts` block: a plugin skill that
 * uses something outside itself, or whose facts could not all be read.
 */
export function factsWarnOnInstall(
  facts: SkillPluginFacts | undefined,
): boolean {
  return (
    facts !== undefined &&
    (facts.usesPluginParts.length > 0 || !facts.factsComplete)
  );
}

/**
 * Repository-controlled text, made safe to paint.
 *
 * File paths come from `ls-tree` and a description comes from the item's YAML;
 * Git allows almost any byte in a path and YAML carries escapes freely. The
 * consent prompt is the one gate authorizing third-party code to run with the
 * user's permissions, so a repository able to emit ESC or OSC bytes into it
 * could redraw the prompt's own text — hide a file from the list, fake a
 * license line, or drive the terminal. `sanitizeDisplayText` is the same filter
 * the picker applies to the same class of text.
 */
function safe(text: string): string {
  return sanitizeDisplayText(text);
}

function describeLicense(license: LicenseFinding): string {
  if (license.path === null)
    return "none found in the item or at the repo root";
  const where = license.insideItem
    ? "inside the item, copied with it"
    : "at the repo root, outside the item, not copied";
  return `${license.label ?? "unrecognized"}  (${safe(license.path)}, ${where})`;
}

/** Singular everywhere a count can be one: "1 skill", "2 skills". */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * The skill row's "uses" column. "" when the candidate is not a plugin
 * skill or matches none of the four checks and its facts are complete.
 */
export function usesLabel(facts: SkillPluginFacts | undefined): string {
  if (facts === undefined) return "";
  const reasons = facts.usesPluginParts.map(
    (use) => USE_PART_LABELS[use.reason],
  );
  if (reasons.length === 0) {
    return facts.factsComplete ? "" : "facts incomplete";
  }
  const labels = facts.factsComplete
    ? reasons
    : [...reasons, "facts incomplete"];
  return `uses ${labels.join(", ")}`;
}

const USE_PART_LABELS: Record<PluginFactReason, string> = {
  "plugin-root": "plugin root",
  "plugin-agents": "agents",
  "plugin-workflows": "workflows",
  "outside-links": "outside links",
};

// A template string, not interpolation: this is the literal text the facts
// block prints, the plugin-root variable name a skill's own source reads.
const PLUGIN_ROOT_VARIABLE = `\${CLAUDE_PLUGIN_ROOT}`;

/**
 * The consent prompt's facts block: what a plugin skill reaches outside its
 * own directory, by reason, and what that costs an install that copies the
 * skill directory only. Exported so `src/commands/update.ts` can print the
 * same block when a skill's plugin facts change at the new commit.
 *
 * Pure: the caller decides whether anything here is worth printing at all
 * (`factsWarnOnInstall`) — this only renders the lines once that is decided.
 */
export function renderPluginFacts(facts: SkillPluginFacts): string[] {
  const lines: string[] = [
    `  ! this skill uses parts of the ${safe(facts.plugin.name)} plugin that are not installed:`,
  ];
  // The column width is the widest label *present in this block*, plus a
  // two-space gutter — not the widest of all four possible labels. Basing it
  // on every possible label would give "outside links" (already the widest)
  // zero gutter of its own whenever it is the longest one shown.
  const labelWidth =
    Math.max(
      ...facts.usesPluginParts.map((use) => USE_PART_LABELS[use.reason].length),
    ) + 2;
  for (const use of facts.usesPluginParts) {
    const refs = use.refs.map(safe).join(", ");
    const suffix =
      use.reason === "plugin-root"
        ? ` ${use.refs.length === 1 ? "reads" : "read"} ${PLUGIN_ROOT_VARIABLE}`
        : "";
    lines.push(
      `      ${USE_PART_LABELS[use.reason].padEnd(labelWidth)}${refs}${suffix}`,
    );
  }
  lines.push(
    `    ${facts.filesOutsideSkill} ${plural(facts.filesOutsideSkill, "file")} outside the skill directory ${facts.filesOutsideSkill === 1 ? "is" : "are"} not copied.`,
  );
  lines.push("    The skill can fail or run with less than it expects.");
  if (!facts.factsComplete) {
    const unread = facts.unread.length;
    lines.push(
      `    ${unread} ${plural(unread, "file")} ${unread === 1 ? "was" : "were"} not checked, so this list can be incomplete.`,
    );
  }
  return lines;
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

/**
 * Join parts as English prose: one part alone, two joined by "and", three
 * or more comma-separated with a final "and".
 */
function englishJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * `summaryLength` is the line count up to and including the `elsewhere`
 * line, or the last header line present when there is no `elsewhere` line,
 * plus the one blank line printed after it. A caller can slice `lines` at
 * this index to print the D9 "ask before a long list" summary before
 * asking whether to show the rest.
 */
export interface CandidateListRender {
  lines: string[];
  summaryLength: number;
}

/**
 * The `--list` text output, as plain lines, with no console calls — exported
 * so the D9 summary and the picker's plugin detail can reuse these lines.
 */
export function renderCandidateList(input: {
  url: string;
  upstream: string;
  ref: string;
  commit: string;
  discovery: RemoteDiscovery;
  scope: "repository" | { plugin: DiscoveredPlugin };
}): CandidateListRender {
  const lines: string[] = [
    `  repo      ${safe(input.upstream)}`,
    `  ref       ${safe(input.ref)}`,
    `  commit    ${input.commit}`,
  ];
  if (input.scope === "repository") {
    return renderRepositoryList(lines, input.url, input.discovery);
  }
  return renderPluginList(
    lines,
    input.url,
    input.discovery,
    input.scope.plugin,
  );
}

/** The `found 0 skills` early return, and the layout-only format unchanged
 * by byte, for a repository with no plugin at all. */
function renderRepositoryList(
  lines: string[],
  url: string,
  discovery: RemoteDiscovery,
): CandidateListRender {
  const candidates = discovery.candidates;
  if (discovery.plugins.length === 0) {
    lines.push(
      `  found     ${candidates.length} ${plural(candidates.length, "skill")}`,
    );
    if (candidates.length === 0) return { lines, summaryLength: lines.length };
    lines.push("");
    const width = Math.max(...candidates.map((c) => c.subpath.length));
    for (const candidate of candidates) {
      lines.push(
        `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
    lines.push(
      `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", candidates[0]!.subpath]))}`,
    );
    lines.push(
      `  install some:  ${safe(shellCommand([PRODUCT_NAME, "add", url]))}`,
    );
    return { lines, summaryLength: lines.length };
  }

  const catalogsUsed = new Set<PluginCatalog>();
  for (const plugin of discovery.plugins) {
    for (const catalog of plugin.catalogs) catalogsUsed.add(catalog);
  }
  const catalogPaths = [
    ...(catalogsUsed.has("claude") ? [CLAUDE_CATALOG_PATH] : []),
    ...(catalogsUsed.has("codex") ? [CODEX_CATALOG_PATH] : []),
  ];
  const usingCount = candidates.filter(
    (c) => c.plugin !== undefined && c.plugin.usesPluginParts.length > 0,
  ).length;

  lines.push(
    `  found     ${candidates.length} ${plural(candidates.length, "skill")} in ${discovery.plugins.length} ${plural(discovery.plugins.length, "plugin")}` +
      (catalogPaths.length > 0 ? `  (${catalogPaths.join(", ")})` : ""),
  );
  if (usingCount > 0) {
    lines.push(
      `            ${usingCount} ${usingCount === 1 ? "uses" : "use"} plugin parts outside the skill directory`,
    );
  }
  const noSkillPlugins = discovery.plugins.filter(
    (p) => p.skillDirs.length === 0,
  );
  if (noSkillPlugins.length > 0) {
    const dirs = noSkillPlugins.map((p) => safe(p.source)).join(", ");
    // Each part in the order its first no-skill plugin ships it, not
    // `PLUGIN_PARTS`'s own order: "plugins/insecure-defaults,
    // plugins/git-cleanup  (commands and workflows only)" names `commands`
    // first because `insecure-defaults` (listed first) ships it, even
    // though `PLUGIN_PARTS` puts `workflows` ahead of `commands`.
    const ships: PluginPart[] = [];
    for (const plugin of noSkillPlugins) {
      for (const part of plugin.ships) {
        if (!ships.includes(part)) ships.push(part);
      }
    }
    const shipsSuffix =
      ships.length > 0 ? `  (${englishJoin(ships)} only)` : "";
    lines.push(`  no skills  ${dirs}${shipsSuffix}`);
  }
  const elsewhere = discovery.skipped.filter(
    (s) => s.reason === "external-source",
  );
  if (elsewhere.length > 0) {
    lines.push(
      `  elsewhere  ${elsewhere.map((s) => safe(s.name)).join(", ")}  (sources outside this repository, not read)`,
    );
  }
  lines.push("");
  if (candidates.length === 0) {
    lines.pop();
    return { lines, summaryLength: lines.length };
  }
  const summaryLength = lines.length;

  const layout = candidates.filter((c) => c.plugin === undefined);
  const renderOrder: RemoteSkillCandidate[] = [...layout];
  if (layout.length > 0) {
    const width = Math.max(...layout.map((c) => c.subpath.length));
    for (const candidate of layout) {
      lines.push(
        `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
  }

  const pluginRows = candidates.filter((c) => c.plugin !== undefined);
  const nameWidth =
    pluginRows.length > 0
      ? Math.max(...pluginRows.map((c) => lastSegment(c.subpath).length))
      : 0;
  const usesWidth =
    pluginRows.length > 0
      ? Math.max(...pluginRows.map((c) => usesLabel(c.plugin).length))
      : 0;
  for (const plugin of discovery.plugins) {
    const rows = pluginRows.filter(
      (c) => c.plugin!.plugin.source === plugin.source,
    );
    if (rows.length === 0) continue;
    const shipsSuffix =
      plugin.ships.length > 0
        ? `   also ships: ${plugin.ships.join(", ")}`
        : "";
    lines.push(`  ${safe(plugin.source)}${shipsSuffix}`);
    for (const candidate of rows) {
      renderOrder.push(candidate);
      lines.push(
        `    ${safe(lastSegment(candidate.subpath)).padEnd(nameWidth)}   ${usesLabel(candidate.plugin).padEnd(usesWidth)}   ${safe(candidate.description ?? "")}`.trimEnd(),
      );
    }
    lines.push("");
  }

  if (usingCount > 0) {
    lines.push(
      `  ${usingCount} ${plural(usingCount, "skill")} ${usingCount === 1 ? "uses" : "use"} plugin parts that live outside the skill directory.`,
    );
    lines.push(
      "  --path copies the skill directory only. Those parts are not installed.",
    );
    lines.push("");
  }

  const firstSubpath = firstSubpathWithNoFacts(renderOrder).subpath;
  lines.push(
    `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", firstSubpath]))}`,
  );
  lines.push(
    `  install some:  ${safe(shellCommand([PRODUCT_NAME, "add", url]))}`,
  );
  lines.push(
    `  details:       ${safe(shellCommand([PRODUCT_NAME, "add", url, "--list", "--json"]))}`,
  );
  return { lines, summaryLength };
}

/** D10: `--list --path <plugin dir>` lists one plugin's skills. */
function renderPluginList(
  lines: string[],
  url: string,
  discovery: RemoteDiscovery,
  plugin: DiscoveredPlugin,
): CandidateListRender {
  const candidates = discovery.candidates;
  const shipsSuffix =
    plugin.ships.length > 0 ? `   also ships: ${plugin.ships.join(", ")}` : "";
  lines.push(
    `  found     ${candidates.length} ${plural(candidates.length, "skill")} in ${safe(plugin.source)}${shipsSuffix}`,
  );
  lines.push("");
  if (candidates.length === 0) {
    lines.pop();
    return { lines, summaryLength: lines.length };
  }
  const summaryLength = lines.length;

  const nameWidth = Math.max(
    ...candidates.map((c) => lastSegment(c.subpath).length),
  );
  const usesWidth = Math.max(
    ...candidates.map((c) => usesLabel(c.plugin).length),
  );
  for (const candidate of candidates) {
    lines.push(
      `    ${safe(lastSegment(candidate.subpath)).padEnd(nameWidth)}   ${usesLabel(candidate.plugin).padEnd(usesWidth)}   ${safe(candidate.description ?? "")}`.trimEnd(),
    );
  }
  lines.push("");
  const firstSubpath = firstSubpathWithNoFacts(candidates).subpath;
  lines.push(
    `  install one:   ${safe(shellCommand([PRODUCT_NAME, "add", url, "--path", firstSubpath]))}`,
  );
  return { lines, summaryLength };
}

/**
 * The first plugin skill in listing order with no `usesPluginParts` and
 * complete facts, for the "install one" example. Falls back to the first
 * candidate in that order when none qualifies — which may itself be a
 * layout skill with no plugin facts at all.
 */
function firstSubpathWithNoFacts(
  renderOrder: readonly RemoteSkillCandidate[],
): RemoteSkillCandidate {
  const noFacts = renderOrder.find(
    (c) =>
      c.plugin !== undefined &&
      c.plugin.usesPluginParts.length === 0 &&
      c.plugin.factsComplete,
  );
  // `renderOrder` is only ever built from a non-empty candidate list by both
  // callers, so the fallback always finds one.
  return noFacts ?? renderOrder[0]!;
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
  const skillPlugins = discovery.plugins.filter(
    (plugin) => plugin.skillDirs.length > 0,
  );
  const context = confirmationContext();
  const askBeforeShowingAll =
    opts.yes !== true &&
    context.stdinIsTTY &&
    context.stdoutIsTTY === true &&
    context.stderrIsTTY &&
    context.terminalRows !== null &&
    context.terminalRows !== undefined &&
    context.terminalRows > 0 &&
    skillPlugins.length > 0 &&
    lines.length > context.terminalRows;
  if (!askBeforeShowingAll) {
    for (const line of lines) console.log(line);
    return;
  }

  for (const line of lines.slice(0, summaryLength)) console.log(line);
  const showAll = await confirmShowAllSkills(
    context,
    discovery.candidates.length,
    lines.length,
  );
  if (showAll) {
    for (const line of lines.slice(summaryLength)) console.log(line);
    return;
  }
  // The "no" answer, D9. When the listing is already scoped to one plugin
  // (D10), naming that same plugin back would repeat the command the user
  // just ran, so only the JSON command prints. Otherwise the plugin-scoped
  // command names the first plugin *with a skill* in listing order — a
  // commands-only plugin has nothing to install — so the user has a short
  // next step instead of the whole list.
  if (scope === "repository") {
    // SAFETY: `askBeforeShowingAll` already required `skillPlugins.length >
    // 0` above, in this same function, with no intervening mutation.
    const firstPlugin = skillPlugins[0]!;
    console.log(
      `  one plugin:   ${safe(shellCommand([PRODUCT_NAME, "add", input, "--list", "--path", firstPlugin.source]))}`,
    );
  }
  console.log(
    `  everything:   ${safe(shellCommand([PRODUCT_NAME, "add", input, "--list", "--json"]))}`,
  );
}

/**
 * D9's question. Loops on anything that is not an explicit yes or no, and a
 * rejected prompt — EOF, Ctrl-C closes readline — counts as "no" the same as
 * typing it.
 */
async function confirmShowAllSkills(
  context: DestructiveConfirmationContext,
  skillCount: number,
  lineCount: number,
): Promise<boolean> {
  for (;;) {
    let answer: string;
    try {
      answer = await context.prompt(
        `Show all ${skillCount} ${plural(skillCount, "skill")} (${lineCount} lines)? [Y/n] `,
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
            plugin: {
              name: candidate.plugin.plugin.name,
              source: candidate.plugin.plugin.source,
              catalogs: candidate.plugin.plugin.catalogs,
            },
            usesPluginParts: candidate.plugin.usesPluginParts,
            factsComplete: candidate.plugin.factsComplete,
            ...(candidate.plugin.unread.length > 0 && {
              unread: candidate.plugin.unread,
            }),
          }),
        })),
        plugins: discovery.plugins.map((plugin) => ({
          name: plugin.name,
          source: plugin.source,
          catalogs: plugin.catalogs,
          ships: plugin.ships,
          skills: plugin.skillDirs.length,
        })),
        skipped: discovery.skipped,
        warnings: discovery.warnings,
      },
      null,
      2,
    ),
  );
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
              kind: REMOTE_ITEM_KIND,
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
              ...(first.plugin !== undefined && {
                plugin: {
                  name: first.plugin.plugin.name,
                  source: first.plugin.plugin.source,
                  catalogs: first.plugin.plugin.catalogs,
                },
                usesPluginParts: first.plugin.usesPluginParts,
                factsComplete: first.plugin.factsComplete,
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
                kind: REMOTE_ITEM_KIND,
                name: result.name,
                action: result.action,
                sha: result.sha,
                subpath: result.subpath,
                path: result.path,
                license: result.license,
                files: result.files,
                ...(result.plugin !== undefined && {
                  plugin: {
                    name: result.plugin.plugin.name,
                    source: result.plugin.plugin.source,
                    catalogs: result.plugin.plugin.catalogs,
                  },
                  usesPluginParts: result.plugin.usesPluginParts,
                  factsComplete: result.plugin.factsComplete,
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
      `= already current local/${remoteKey(first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  ${first.path}`);
    return;
  }
  if (results.length === 1) {
    console.log(
      `✓ added local/${remoteKey(first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  source commit: ${commit}`);
    console.log(`  ${first.path}`);
  } else {
    for (const result of results) {
      console.log(
        `+ ${`${REMOTE_ITEM_KIND}/${result.name}`.padEnd(33)} @ ${shortIdentity(result.sha)}`,
      );
    }
    console.log("");
    console.log(`✓ ${results.length} added from one clone`);
    for (const result of results) console.log(`  ${result.path}`);
  }
  console.log("  not committed, so your teammates do not get it");
  console.log(
    `  to give it to the team: ${PRODUCT_NAME} share ${REMOTE_ITEM_KIND}/${first.name} --adopt`,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}
