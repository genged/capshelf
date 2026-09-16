/**
 * Who owned a skill before `share --adopt` took it.
 *
 * One interface with two implementations, by D13. A remote row and a skills.sh
 * row differ only in which file holds the record and how one row is deleted
 * from it; everything else in the transfer is identical, so nothing in
 * `share --adopt` branches on which owner it found.
 *
 * Each record carries a digest over the *whole* file, captured when the record
 * was read and re-checked before the release. A file that changed in between is
 * a refusal that keeps the previous owner: a lost row would strand an installed
 * skill with no owner at all, which is worse than two owners.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { PreconditionError } from "./errors";
import { atomicWriteFile } from "./fs-utils";
import {
  REMOTE_ITEM_KIND,
  loadRemotesLock,
  remoteKey,
  saveRemotesLock,
} from "./remotes-lock";
import { remotesLockPath } from "./paths";

export type PreviousOwnerKind = "remote" | "skills.sh";

export interface PreviousOwnerProvenance {
  upstream: string | null;
  upstreamCommit: string | null;
  upstreamPath: string | null;
}

export interface PreviousOwnerRecord {
  kind: PreviousOwnerKind;
  /** Absolute path of the file that holds the record. */
  path: string;
  /** sha-256 over the whole file as it was read. */
  digest: string;
  /** What the record says about the skill, for the provenance fields. */
  provenance: PreviousOwnerProvenance;
}

export interface PreviousOwner {
  /** The record for this skill, or null when this owner does not hold it. */
  find(project: string, name: string): Promise<PreviousOwnerRecord | null>;
  /**
   * Delete the skill's row. Refuses when the file changed since `record` was
   * captured. Preserves every field capshelf does not understand and the
   * file's trailing newline. Re-reads afterwards to prove the row is gone.
   */
  release(
    project: string,
    name: string,
    record: PreviousOwnerRecord,
  ): Promise<void>;
}

const SKILLS_SH_FILE = "skills-lock.json";
const SKILLS_SH_VERSION = 1;

export const REMOTE_PREVIOUS_OWNER: PreviousOwner = {
  async find(project, name) {
    const path = remotesLockPath(project);
    if (!existsSync(path)) return null;
    const digest = await fileDigest(path);
    const lock = await loadRemotesLock(project);
    const entry = lock.items[remoteKey(name)];
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

  async release(project, name, record) {
    const path = remotesLockPath(project);
    await assertUnchanged(path, record, REMOTES_LOCK_LABEL, name);
    const lock = await loadRemotesLock(project);
    delete lock.items[remoteKey(name)];
    await saveRemotesLock(project, lock);
    const after = await loadRemotesLock(project);
    if (after.items[remoteKey(name)] !== undefined) {
      throw new Error(`failed to release the remote row for ${ref(name)}`);
    }
  },
};

export const SKILLS_SH_PREVIOUS_OWNER: PreviousOwner = {
  async find(project, name) {
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

  async release(project, name, record) {
    const path = join(project, SKILLS_SH_FILE);
    await assertUnchanged(path, record, SKILLS_SH_FILE, name);
    const text = await readFile(path, "utf-8");
    const document = parseSkillsShLock(text);
    const skills = document.skills;
    if (!isConfigObject(skills)) {
      throw new PreconditionError(
        `${SKILLS_SH_FILE} has no skills object; Capshelf kept the skills.sh entry`,
      );
    }
    // Deliberately not `SkillsShLockSchema`: that schema strips every field
    // capshelf does not read, and stripping is exactly what a release must
    // never do. The document is mutated by key and re-serialized whole.
    delete skills[name];
    await atomicWriteFile(
      path,
      `${JSON.stringify(document, null, 2)}${text.endsWith("\n") ? "\n" : ""}`,
    );
    const after = parseSkillsShLock(await readFile(path, "utf-8"));
    if (skillsShRow(after, name) !== null) {
      throw new Error(`failed to release the skills.sh row for ${ref(name)}`);
    }
  },
};

/** The first owner that holds the skill, in the order remote, then skills.sh. */
export async function findPreviousOwner(
  project: string,
  name: string,
): Promise<PreviousOwnerRecord | null> {
  for (const owner of [REMOTE_PREVIOUS_OWNER, SKILLS_SH_PREVIOUS_OWNER]) {
    const record = await owner.find(project, name);
    if (record !== null) return record;
  }
  return null;
}

export function previousOwnerFor(kind: PreviousOwnerKind): PreviousOwner {
  return kind === "remote" ? REMOTE_PREVIOUS_OWNER : SKILLS_SH_PREVIOUS_OWNER;
}

/** Both places `share --adopt` searched, for the refusal that found neither. */
export function previousOwnerSearchPaths(project: string): string[] {
  return [remotesLockPath(project), join(project, SKILLS_SH_FILE)];
}

const REMOTES_LOCK_LABEL = "remotes.lock.json";

function ref(name: string): string {
  return `${REMOTE_ITEM_KIND}/${name}`;
}

async function assertUnchanged(
  path: string,
  record: PreviousOwnerRecord,
  label: string,
  name: string,
): Promise<void> {
  if (existsSync(path) && (await fileDigest(path)) === record.digest) return;
  throw new PreconditionError(
    `${label} changed while adopting ${ref(name)}; Capshelf kept the ${record.kind === "remote" ? "remote row" : "skills.sh entry"}`,
    {
      hint: `check ${ref(name)} with capshelf status, then retry with --adopt`,
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
 * The document, with only the two things capshelf depends on checked: the
 * version it knows, and an object under `skills`. Everything else stays a free
 * JSON value so the release can write it back untouched.
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
