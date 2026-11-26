/**
 * Each record carries a digest over the whole file, captured when the record
 * was read and re-checked before the release. A file that changed in between is
 * a refusal that keeps the previous owner, because a lost row would strand an
 * installed skill with no owner, which is worse than two owners.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { PreconditionError } from "./errors";
import { atomicWriteFile } from "./fs-utils";
import { loadRemotesLock, remoteKey, saveRemotesLock } from "./remotes-lock";
import type { RemoteItemKind } from "./remotes-lock";
import { remotesLockPath } from "./paths";

export type PreviousOwnerKind = "remote" | "skills.sh";

export interface PreviousOwnerProvenance {
  upstream: string | null;
  upstreamCommit: string | null;
  upstreamPath: string | null;
}

export interface PreviousOwnerRecord {
  kind: PreviousOwnerKind;
  path: string;
  digest: string;
  provenance: PreviousOwnerProvenance;
}

export interface PreviousOwner {
  /**
   * `kind` only matters to a remote row; a skills.sh row carries none, so it is
   * never asked about a plugin.
   */
  find(
    project: string,
    kind: RemoteItemKind,
    name: string,
  ): Promise<PreviousOwnerRecord | null>;
  release(
    project: string,
    kind: RemoteItemKind,
    name: string,
    record: PreviousOwnerRecord,
  ): Promise<void>;
}

const SKILLS_SH_FILE = "skills-lock.json";
const SKILLS_SH_VERSION = 1;

export const REMOTE_PREVIOUS_OWNER: PreviousOwner = {
  async find(project, kind, name) {
    const path = remotesLockPath(project);
    if (!existsSync(path)) return null;
    const digest = await fileDigest(path);
    const lock = await loadRemotesLock(project);
    const entry = lock.items[remoteKey(kind, name)];
    if (entry === undefined) return null;
    return {
      kind: "remote",
      path,
      digest,
      provenance: {
        upstream: entry.upstream,
        upstreamCommit: entry.sourceCommit,
        upstreamPath: entry.subpath,
      },
    };
  },

  async release(project, kind, name, record) {
    const path = remotesLockPath(project);
    await assertUnchanged(path, record, REMOTES_LOCK_LABEL, kind, name);
    const lock = await loadRemotesLock(project);
    delete lock.items[remoteKey(kind, name)];
    await saveRemotesLock(project, lock);
    const after = await loadRemotesLock(project);
    if (after.items[remoteKey(kind, name)] !== undefined) {
      throw new Error(`failed to release the remote row for ${kind}/${name}`);
    }
  },
};

export const SKILLS_SH_PREVIOUS_OWNER: PreviousOwner = {
  async find(project, _kind, name) {
    const path = join(project, SKILLS_SH_FILE);
    if (!existsSync(path)) return null;
    const text = await readFile(path, "utf-8");
    const document = parseSkillsShLock(text);
    const row = skillsShRow(document, name);
    if (row === null) return null;
    return {
      kind: "skills.sh",
      path,
      digest: digestOf(text),
      provenance: {
        upstream: isConfigString(row.source) ? row.source : null,
        upstreamCommit: null,
        upstreamPath: isConfigString(row.skillPath) ? row.skillPath : null,
      },
    };
  },

  async release(project, kind, name, record) {
    const path = join(project, SKILLS_SH_FILE);
    await assertUnchanged(path, record, SKILLS_SH_FILE, kind, name);
    const text = await readFile(path, "utf-8");
    const document = parseSkillsShLock(text);
    const skills = document.skills;
    if (!isConfigObject(skills)) {
      throw new PreconditionError(
        `${SKILLS_SH_FILE} has no skills object; Capshelf kept the skills.sh entry`,
      );
    }
    // Deliberately not `SkillsShLockSchema`, which strips fields capshelf does
    // not read; a release must preserve them.
    delete skills[name];
    await atomicWriteFile(
      path,
      `${JSON.stringify(document, null, 2)}${text.endsWith("\n") ? "\n" : ""}`,
      { root: project },
    );
    const after = parseSkillsShLock(await readFile(path, "utf-8"));
    if (skillsShRow(after, name) !== null) {
      throw new Error(
        `failed to release the skills.sh row for ${kind}/${name}`,
      );
    }
  },
};

/**
 * A plugin asks only its remote row: the skills.sh owner matches by name alone,
 * so it would find and release a skills.sh skill named like the plugin.
 */
export async function findPreviousOwner(
  project: string,
  kind: RemoteItemKind,
  name: string,
): Promise<PreviousOwnerRecord | null> {
  for (const owner of previousOwnersFor(kind)) {
    const record = await owner.find(project, kind, name);
    if (record !== null) return record;
  }
  return null;
}

function previousOwnersFor(kind: RemoteItemKind): PreviousOwner[] {
  return kind === "skills"
    ? [REMOTE_PREVIOUS_OWNER, SKILLS_SH_PREVIOUS_OWNER]
    : [REMOTE_PREVIOUS_OWNER];
}

export function previousOwnerFor(kind: PreviousOwnerKind): PreviousOwner {
  return kind === "remote" ? REMOTE_PREVIOUS_OWNER : SKILLS_SH_PREVIOUS_OWNER;
}

export function previousOwnerSearchPaths(
  project: string,
  kind: RemoteItemKind,
): string[] {
  return kind === "skills"
    ? [remotesLockPath(project), join(project, SKILLS_SH_FILE)]
    : [remotesLockPath(project)];
}

const REMOTES_LOCK_LABEL = "remotes.lock.json";

async function assertUnchanged(
  path: string,
  record: PreviousOwnerRecord,
  label: string,
  kind: RemoteItemKind,
  name: string,
): Promise<void> {
  if (existsSync(path) && (await fileDigest(path)) === record.digest) return;
  throw new PreconditionError(
    `${label} changed while adopting ${kind}/${name}; Capshelf kept the ${record.kind === "remote" ? "remote row" : "skills.sh entry"}`,
    {
      hint: `check ${kind}/${name} with capshelf status, then retry with --adopt`,
    },
  );
}

async function fileDigest(path: string): Promise<string> {
  return digestOf(await readFile(path, "utf-8"));
}

function digestOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Keep unknown fields as free JSON so releasing ownership preserves them.
 */
function parseSkillsShLock(text: string): ConfigObject {
  let value: ConfigValue;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PreconditionError(`invalid ${SKILLS_SH_FILE}: ${String(error)}`);
  }
  if (!isConfigObject(value)) {
    throw new PreconditionError(
      `invalid ${SKILLS_SH_FILE}: expected an object`,
    );
  }
  const version = value.version;
  if (version !== undefined && version !== SKILLS_SH_VERSION) {
    throw new PreconditionError(
      `${SKILLS_SH_FILE} declares version ${String(version)}; capshelf supports version ${SKILLS_SH_VERSION} only`,
      { hint: "upgrade capshelf, or remove the skill with skills.sh instead" },
    );
  }
  return value;
}

function skillsShRow(
  document: ConfigObject,
  name: string,
): ConfigObject | null {
  const skills = document.skills;
  if (!isConfigObject(skills)) return null;
  const row = skills[name];
  return isConfigObject(row) ? row : null;
}
