/**
 * `.capshelf/remotes.lock.json`: the record of every skill pulled from a
 * repository outside the shelf.
 *
 * It is a separate document, not a third scope in the project lock. A remote
 * entry is not a `LockEntryV4` — it carries an upstream, a ref, and an item
 * root, and it carries no `needs` snapshot — so putting it in `Lock["items"]`
 * would widen the type every consumer of the project lock reads. The version 4
 * project lock is untouched by this file, and no project runs `lock migrate`
 * because a remote row exists.
 *
 * The file is gitignored. Every row is local scope, and a teammate who clones
 * the project gets none of them.
 */
import { z } from "zod";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertSafeItemName,
  isSafeGitRef,
  isSafeItemName,
  isSafeItemRoot,
} from "./assert";
import type { ConfigValue } from "./config-values";
import { atomicWriteFile, isErrno } from "./fs-utils";
import { PRODUCT_NAME, REMOTES_LOCK_FILE } from "./identity";
import type { ItemRef } from "./item-ref";
import { ensureGitignored } from "./local-config";
import { remotesLockPath } from "./paths";
import { PIN_DIGEST_PATTERN } from "./pin";

export const REMOTES_LOCK_VERSION = 1 as const;

/** The one kind a remote row may hold, by D4. */
export const REMOTE_ITEM_KIND = "skills" as const;

const REMOTE_KEY_PREFIX = "remote";

/**
 * Full object names only, for the same reason the project lock requires them:
 * an abbreviation is a request for Git to guess, and it would be guessing
 * inside a `git show <rev>:<path>` argv where a trailing `:<path>` defeats any
 * `--` guard.
 */
const FullGitCommitSchema = z
  .string()
  .regex(
    /^([0-9a-f]{40}|[0-9a-f]{64})$/,
    "sourceCommit must be a full lowercase hex git object name",
  );

const SourcePinDigestSchema = z
  .string()
  .regex(PIN_DIGEST_PATTERN, "sourcePinDigest must be 64 lowercase hex chars");

const RemoteLockEntrySchema = z
  .object({
    upstream: z.string().min(1),
    ref: z.string().refine(isSafeGitRef, "ref must be a plain branch or tag"),
    subpath: z
      .string()
      .refine(isSafeItemRoot, "subpath must stay inside the repository"),
    sourceCommit: FullGitCommitSchema,
    sourcePinDigest: SourcePinDigestSchema,
    appliedAt: z.string(),
    lastChecked: z.string().optional(),
    upstreamHead: FullGitCommitSchema.optional(),
    upstreamPinDigest: SourcePinDigestSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    // A head must never sit beside no timestamp: it would claim a measurement
    // nothing dates. The reverse is a real state — a check that reached the
    // repository and found the recorded ref gone — so a timestamp alone is
    // allowed, and `upstreamFacts` reads it as `missing_upstream`.
    if (entry.upstreamHead !== undefined && entry.lastChecked === undefined)
      ctx.addIssue({
        code: "custom",
        message: "upstreamHead requires the lastChecked it was read at",
      });
    // The measured digest may be absent while the head is present: that is a
    // check which reached the repository and found the item no longer at its
    // recorded subpath. The reverse cannot happen.
    if (
      entry.upstreamPinDigest !== undefined &&
      entry.upstreamHead === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "upstreamPinDigest requires the upstreamHead it was read at",
      });
  });

const RemotesLockSchema = z
  .object({
    version: z.literal(REMOTES_LOCK_VERSION),
    items: z.record(z.string(), RemoteLockEntrySchema).default({}),
  })
  .superRefine((lock, ctx) => {
    for (const key of Object.keys(lock.items)) {
      try {
        parseRemoteKey(key);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["items", key],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

export interface RemoteLockEntry {
  /** Normalized upstream identity, the value `normalizeRemoteUrl` returns. */
  upstream: string;
  /** The ref the user asked for, e.g. `main` or a tag. */
  ref: string;
  /** Repository-relative item root, POSIX separated, `.` for the repo root. */
  subpath: string;
  sourceCommit: string;
  sourcePinDigest: string;
  appliedAt: string;
  /**
   * Set only by `status --check-upstream`, and only after a fetch that
   * succeeded. `lastChecked` and `upstreamHead` move together or neither does,
   * so a timestamp can never sit beside a head it did not measure.
   */
  lastChecked?: string;
  upstreamHead?: string;
  /**
   * The item's content digest at `upstreamHead`, which is what decides
   * `update_available`. `upstreamHead` is reported to the user but never
   * compared: two skills in one repository share a commit and would both look
   * updated when either changes.
   *
   * Absent beside a set `upstreamHead` means the check reached the repository
   * and the item was no longer at `subpath`.
   */
  upstreamPinDigest?: string;
}

export interface RemotesLock {
  version: typeof REMOTES_LOCK_VERSION;
  items: Record<string, RemoteLockEntry>;
}

export function emptyRemotesLock(): RemotesLock {
  return { version: REMOTES_LOCK_VERSION, items: {} };
}

export function remoteKey(name: string): string {
  return `${REMOTE_KEY_PREFIX}/${REMOTE_ITEM_KIND}/${name}`;
}

export interface RemoteKeyParts {
  kind: typeof REMOTE_ITEM_KIND;
  name: string;
}

export function parseRemoteKey(key: string): RemoteKeyParts {
  const [prefix, kind, ...nameParts] = key.split("/");
  if (prefix !== REMOTE_KEY_PREFIX || nameParts.length === 0) {
    throw new Error(
      `invalid remote key: ${key} (expected ${REMOTE_KEY_PREFIX}/${REMOTE_ITEM_KIND}/<name>)`,
    );
  }
  if (kind !== REMOTE_ITEM_KIND) {
    throw new Error(
      `unsupported remote key kind: ${kind ?? "(missing)"} (only ${REMOTE_ITEM_KIND} can be pulled from a repository)`,
    );
  }
  const name = nameParts.join("/");
  assertSafeItemName(name, `remote key ${key}`);
  return { kind: REMOTE_ITEM_KIND, name };
}

/** The remote keys an item ref selects. An unsafe name matches nothing. */
export function remoteKeysForRef(lock: RemotesLock, ref: ItemRef): string[] {
  if (ref.kind !== undefined && ref.kind !== REMOTE_ITEM_KIND) return [];
  if (!isSafeItemName(ref.name)) return [];
  const wanted = remoteKey(ref.name);
  return Object.keys(lock.items).filter((key) => key === wanted);
}

export async function loadRemotesLock(project: string): Promise<RemotesLock> {
  const path = remotesLockPath(project);
  try {
    const document: ConfigValue = JSON.parse(await readFile(path, "utf-8"));
    return parseRemotesLock(document);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return emptyRemotesLock();
    throw error;
  }
}

export async function saveRemotesLock(
  project: string,
  lock: RemotesLock,
): Promise<void> {
  const path = remotesLockPath(project);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, serializeRemotesLock(lock));
  // Deliberately not `saveLocalConfig`: D7 allows a project that holds remote
  // rows and no data-repo binding, and `LocalConfigSchema` requires one.
  await ensureGitignored(project, REMOTES_LOCK_FILE);
}

/**
 * Serialize and strict-parse the result, the way `serializeLock` does. A
 * candidate that a refinement rejects has to fail here, before any file is
 * published.
 */
export function serializeRemotesLock(lock: RemotesLock): string {
  const parsed = RemotesLockSchema.parse({
    ...lock,
    version: REMOTES_LOCK_VERSION,
  });
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** The one field read before the version decides which schema applies. */
const VersionProbe = z.object({ version: z.number().optional() });

export function parseRemotesLock(value: ConfigValue): RemotesLock {
  const probe = VersionProbe.safeParse(value);
  const version = probe.success ? probe.data.version : undefined;
  if (version !== undefined && version > REMOTES_LOCK_VERSION) {
    throw new Error(
      `remotes lock version ${version} is newer than this ${PRODUCT_NAME} supports — upgrade ${PRODUCT_NAME}`,
    );
  }
  return RemotesLockSchema.parse(value);
}
