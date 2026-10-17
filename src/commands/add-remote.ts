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
import type { PickRow } from "../pick-core";
import type { DiscoveredPlugin, SkippedEntry } from "../plugin-discovery";
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
  pluginAtSubpath,
  remoteTreeSource,
  summarizeCandidate,
} from "../remote-discovery";
import type {
  LicenseFinding,
  RemoteDiscovery,
  RemoteSkillCandidate,
} from "../remote-discovery";
import { installRemoteItem, reconcileRemoteItem } from "../remote-item";
import {
  factsWarnOnInstall,
  hasSkills,
  plural,
  renderCandidateList,
  renderPluginFacts,
  safe,
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
import type { RemoteItemKind, RemotesLock } from "../remotes-lock";
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
  // D4 widens a remote row to `skills` or `plugins`; this command only ever
  // installs a skill today — installing a whole plugin is Task 8 (D5).
  const kind: RemoteItemKind = "skills";
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

  if (discovery.candidates.length === 0) {
    throw new PreconditionError(
      `no skill found in ${parsed.upstream} at ${ref}`,
      {
        hint: "capshelf looks for SKILL.md at the repository root and under skills/, .claude/skills/, and .agents/skills/ and in plugins named by .claude-plugin/marketplace.json or .agents/plugins/marketplace.json",
      },
    );
  }

  const chosen = await chooseCandidates(discovery.candidates, kind, parsed);
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
      kind,
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
        printInstalled(parsed, kind, ref, commit, results, opts);
      return;
    }
    results.push(outcome);
  }
  printInstalled(parsed, kind, ref, commit, results, opts);
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

  // The already-current check runs *before* the ownership checks, and the
  // order is required. `findInstallConflict` reports any existing output path
  // with no exemption for the row that wrote it, so running it first would
  // make a second `add <same-url>` refuse instead of reporting the no-op.
  const existing = remotes.items[remoteKey(kind, name)];
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
    return {
      name,
      subpath: candidate.subpath,
      path: installedPath(project, kind, name),
      sha: existing.sourcePinDigest,
      action: "already-current",
      files: pin.entries.length,
      license: null,
      plugin: candidate.plugin,
    };
  }

  await assertNameAvailable(project, kind, name, remotes, upstream);

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
  kind: RemoteItemKind,
  name: string,
  remotes: RemotesLock,
  upstream: string,
): Promise<void> {
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
  // and `rm`/`--as` would answer a question nobody asked.
  const sameUpstream = held.some((entry) => entry.upstream === upstream);
  if (sameUpstream) {
    throw new PreconditionError(
      `${kind}/${name} is already pulled from ${upstream}, at a different commit (.capshelf/remotes.lock.json)`,
      {
        hint: `move the pin instead: ${PRODUCT_NAME} update ${kind}/${name}`,
      },
    );
  }
  if (held.length > 0) {
    throw new PreconditionError(
      `${kind}/${name} is already pulled from a different repository (.capshelf/remotes.lock.json)`,
      {
        hint: `remove it first: ${PRODUCT_NAME} rm ${kind}/${name}, or install under another name with --as`,
      },
    );
  }
  const external = await findSkillsShSkill(project, name);
  if (external) {
    throw new PreconditionError(
      `not installing ${kind}/${name} — ${skillsShConflictMessage(external)}`,
    );
  }
  const conflict = findInstallConflict(project, kind, name);
  if (conflict) {
    throw new PreconditionError(
      `not installing ${kind}/${name} — the install path already exists and capshelf does not manage it`,
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
  kind: RemoteItemKind,
  parsed: RemoteSkillUrl,
): Promise<RemoteSkillCandidate[]> {
  if (candidates.length === 1) return candidates;
  const rows: PickRow[] = candidates.map((candidate) => ({
    ref: `${kind}/${candidate.defaultName}`,
    id: candidate.subpath,
    kind,
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
  opts: RemoteAddOptions;
}): Promise<boolean> {
  if (input.opts.yes === true) {
    // D4/D7: `--yes` skips the prompt, so this is the only place the facts
    // block reaches a `--yes` install. It goes to stderr, never stdout, so
    // `--json` still parses.
    const facts = input.candidate.plugin;
    if (factsWarnOnInstall(facts)) {
      for (const line of renderPluginFacts(facts!)) console.error(line);
    }
    return true;
  }
  const context = confirmationContext();
  const block = renderConsent(input);
  if (input.opts.json === true || !context.stdinIsTTY || !context.stderrIsTTY) {
    throw new PreconditionError(
      `not installing ${input.kind}/${input.name} without consent — capshelf does not review this content, and your agent runs it with your permissions`,
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
  kind: RemoteItemKind;
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
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
  // just ran, so only the JSON command prints, in the same scope. Otherwise
  // the plugin-scoped command names the first plugin *with a skill* in
  // listing order — a commands-only plugin has nothing to install — so the
  // user has a short next step instead of the whole list.
  if (scope === "repository") {
    // SAFETY: `askBeforeShowingAll` already required `skillPlugins.length >
    // 0` above, in this same function, with no intervening mutation.
    const firstPlugin = skillPlugins[0]!;
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
            ...pluginJsonFields(candidate.plugin),
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

function printInstalled(
  parsed: RemoteSkillUrl,
  kind: RemoteItemKind,
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
              kind,
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
            }
          : {
              verb: "add",
              source: "remote",
              scope: "local",
              upstream: parsed.upstream,
              ref,
              sourceCommit: commit,
              items: results.map((result) => ({
                kind,
                name: result.name,
                action: result.action,
                sha: result.sha,
                subpath: result.subpath,
                path: result.path,
                license: result.license,
                files: result.files,
                ...(result.plugin !== undefined &&
                  pluginJsonFields(result.plugin)),
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
      `= already current local/${remoteKey(kind, first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  ${first.path}`);
    return;
  }
  if (results.length === 1) {
    console.log(
      `✓ added local/${remoteKey(kind, first.name)} @ ${shortIdentity(first.sha)}`,
    );
    console.log(`  source commit: ${commit}`);
    console.log(`  ${first.path}`);
  } else {
    for (const result of results) {
      console.log(
        `+ ${`${kind}/${result.name}`.padEnd(33)} @ ${shortIdentity(result.sha)}`,
      );
    }
    console.log("");
    console.log(`✓ ${results.length} added from one clone`);
    for (const result of results) console.log(`  ${result.path}`);
  }
  console.log("  not committed, so your teammates do not get it");
  console.log(
    `  to give it to the team: ${PRODUCT_NAME} share ${kind}/${first.name} --adopt`,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}
