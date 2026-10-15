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
  // D10: `--list` with a plugin path lists that plugin, so the lookup runs
  // before `candidateAtSubpath`'s single-skill read — but only behind
  // `--list`. A bare `--path` (no `--list`) still goes straight to
  // `candidateAtSubpath`; a D5 refusal for a plugin root named without
  // `--list` is not implemented here.
  const pluginScope =
    explicitSubpath !== null &&
    explicitSubpath !== undefined &&
    opts.list === true
      ? await pluginAtSubpath(
          cache.path,
          commit,
          explicitSubpath,
          parsed.repoName,
        )
      : null;
  const discovery: RemoteDiscovery =
    pluginScope !== null
      ? {
          candidates: pluginScope.candidates,
          plugins: [pluginScope.plugin],
          skipped: [],
          warnings: pluginScope.warnings,
        }
      : explicitSubpath === null || explicitSubpath === undefined
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
        hint: "capshelf looks for SKILL.md at the repository root and under skills/, .claude/skills/, and .agents/skills/",
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
    detail: candidate.subpath,
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
  name: string;
  summary: {
    files: Array<{ path: string; bytes: number }>;
    totalBytes: number;
  };
  license: LicenseFinding;
  opts: RemoteAddOptions;
}): Promise<boolean> {
  if (input.opts.yes === true) return true;
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
  return [
    `  repo      ${input.upstream}`,
    `  ref       ${input.ref}`,
    `  commit    ${input.commit}`,
    `  path      ${safe(input.candidate.subpath)}${input.candidate.subpath === "." ? "  (SKILL.md at the repo root)" : ""}`,
    `  install   ${installPath}  (local scope, gitignored)`,
    `  files     ${input.summary.files.length} files, ${formatBytes(input.summary.totalBytes)}`,
    ...input.summary.files.map(
      (file) =>
        `              ${safe(file.path).padEnd(width)}  ${formatBytes(file.bytes)}`,
    ),
    `  license   ${describeLicense(input.license)}`,
    "",
    ...(input.candidate.description === null
      ? []
      : [`  ${input.name}: ${safe(input.candidate.description)}`, ""]),
    "  capshelf does not review this content. Your agent runs it with your permissions.",
  ].join("\n");
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
  // plugin skill never asks, which is what keeps a capshelf-shaped shelf
  // byte-identical in a terminal too (D2).
  const context = confirmationContext();
  const askBeforeShowingAll =
    opts.yes !== true &&
    context.stdinIsTTY &&
    context.stdoutIsTTY === true &&
    context.stderrIsTTY &&
    context.terminalRows !== null &&
    context.terminalRows !== undefined &&
    discovery.plugins.length > 0 &&
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
  // The "no" answer, D9: the plugin-scoped command (D10) names the first
  // plugin in listing order, so the user has a short next step instead of
  // the whole list.
  const firstPlugin = discovery.plugins[0]!;
  console.log(
    `  one plugin:   ${safe(shellCommand([PRODUCT_NAME, "add", input, "--list", "--path", firstPlugin.source]))}`,
  );
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
