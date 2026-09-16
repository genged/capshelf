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
  defaultCachedBranch,
  ensureRemoteCache,
  resolveCachedRef,
} from "../remote-cache";
import {
  candidateAtSubpath,
  discoverRemoteSkills,
  findLicense,
  remoteTreeSource,
  summarizeCandidate,
} from "../remote-discovery";
import type { LicenseFinding, RemoteSkillCandidate } from "../remote-discovery";
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
      "add --target is not supported; a pulled skill installs one directory",
    );
  }
  // Deliberately not `loadAddContext`: that resolves a data repo, and D7 says
  // a pulled skill needs none.
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
  const discovery =
    explicitSubpath === null || explicitSubpath === undefined
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
          warnings: [],
        };
  // Sanitized like every other repository-controlled string here: a warning
  // about a malformed marketplace quotes the repository's own text.
  for (const warning of discovery.warnings) console.error(`⚠ ${safe(warning)}`);

  // `--list` answers a question about the repository. It returns before the
  // cardinality rule below, because "too many to install without choosing" is
  // not a reason to refuse to say what is there.
  if (opts.list === true) {
    printCandidateList(input, parsed, ref, commit, discovery.candidates, opts);
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

function printCandidateList(
  input: string,
  parsed: RemoteSkillUrl,
  ref: string,
  commit: string,
  candidates: RemoteSkillCandidate[],
  opts: RemoteAddOptions,
): void {
  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          verb: "add",
          source: "remote",
          repo: parsed.upstream,
          ref,
          commit,
          skills: candidates.map((candidate) => ({
            subpath: candidate.subpath,
            name: candidate.defaultName,
            description: candidate.description,
            origin: candidate.origin,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`  repo      ${parsed.upstream}`);
  console.log(`  ref       ${ref}`);
  console.log(`  commit    ${commit}`);
  console.log(
    `  found     ${candidates.length} ${candidates.length === 1 ? "skill" : "skills"}`,
  );
  if (candidates.length === 0) return;
  console.log("");
  const width = Math.max(...candidates.map((c) => c.subpath.length));
  for (const candidate of candidates) {
    console.log(
      `    ${safe(candidate.subpath).padEnd(width)}   ${safe(candidate.description ?? "")}`.trimEnd(),
    );
  }
  console.log("");
  console.log(
    `  install one:   ${PRODUCT_NAME} add ${input} --path ${safe(candidates[0]!.subpath)}`,
  );
  console.log(`  install some:  ${PRODUCT_NAME} add ${input}`);
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
