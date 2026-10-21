/**
 * `.capshelf/remotes.lock.json`: the record of every skill or plugin pulled
 * from a repository outside the shelf (spec D4).
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
 *
 * The file moves to version 2 only when a row holds `plugins`: a skills-only
 * file stays version 1, so an older capshelf can still read it. The writer
 * computes the version from the rows every time; nothing sets it directly.
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
import { PreconditionError } from "./errors";
import { atomicWriteFile, isErrno } from "./fs-utils";
import { PRODUCT_NAME, REMOTES_LOCK_FILE } from "./identity";
import type { ItemRef } from "./item-ref";
import { ensureGitignored } from "./local-config";
import { remotesLockPath } from "./paths";
import { PIN_DIGEST_PATTERN } from "./pin";

/**
 * The newest version this build understands, read or write. A file that
 * declares a higher number is refused with "upgrade capshelf" before it is
 * parsed any further.
 */
export const REMOTES_LOCK_VERSION = 2 as const;

/** The kinds a remote row may hold, by D4. */
export const REMOTE_ITEM_KINDS = ["skills", "plugins"] as const;
export type RemoteItemKind = (typeof REMOTE_ITEM_KINDS)[number];

function isRemoteItemKind(value: string | undefined): value is RemoteItemKind {
  return (
    value !== undefined && REMOTE_ITEM_KINDS.some((kind) => kind === value)
  );
}

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
    version: z.union([z.literal(1), z.literal(2)]),
    items: z.record(z.string(), RemoteLockEntrySchema).default({}),
  })
  .superRefine((lock, ctx) => {
    for (const key of Object.keys(lock.items)) {
      let kind: RemoteItemKind;
      try {
        kind = parseRemoteKey(key).kind;
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["items", key],
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // D4: a version 1 file predates the `plugins` kind, so a plugins row
      // there would be silently unreadable by capshelf 0.13. The writer
      // never produces this combination; only a hand-edited file can.
      if (kind === "plugins" && lock.version === 1) {
        ctx.addIssue({
          code: "custom",
          path: ["items", key],
          message: "plugins rows need remotes lock version 2",
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
  version: 1 | 2;
  items: Record<string, RemoteLockEntry>;
}

export function emptyRemotesLock(): RemotesLock {
  return { version: 1, items: {} };
}

export function remoteKey(kind: RemoteItemKind, name: string): string {
  return `${REMOTE_KEY_PREFIX}/${kind}/${name}`;
}

export interface RemoteKeyParts {
  kind: RemoteItemKind;
  name: string;
}

export function parseRemoteKey(key: string): RemoteKeyParts {
  const [prefix, kind, ...nameParts] = key.split("/");
  if (prefix !== REMOTE_KEY_PREFIX || nameParts.length === 0) {
    throw new Error(
      `invalid remote key: ${key} (expected ${REMOTE_KEY_PREFIX}/<${REMOTE_ITEM_KINDS.join("|")}>/<name>)`,
    );
  }
  if (!isRemoteItemKind(kind)) {
    throw new Error(
      `unsupported remote key kind: ${kind ?? "(missing)"} (only ${REMOTE_ITEM_KINDS.join(", ")} can be pulled from a repository)`,
    );
  }
  const name = nameParts.join("/");
  assertSafeItemName(name, `remote key ${key}`);
  return { kind, name };
}

/**
 * The remote keys an item ref selects. An unsafe name matches nothing. With
 * no kind named, both kinds are searched — a bare name does not say which
 * one a repository published.
 */
export function remoteKeysForRef(lock: RemotesLock, ref: ItemRef): string[] {
  if (ref.kind !== undefined && !isRemoteItemKind(ref.kind)) return [];
  if (!isSafeItemName(ref.name)) return [];
  const kinds: readonly RemoteItemKind[] = isRemoteItemKind(ref.kind)
    ? [ref.kind]
    : REMOTE_ITEM_KINDS;
  const wanted = new Set(kinds.map((kind) => remoteKey(kind, ref.name)));
  return Object.keys(lock.items).filter((key) => wanted.has(key));
}

/**
 * `remoteKeysForRef`, refused when a bare name selects both kinds.
 *
 * The CLI never creates `remote/skills/<n>` beside `remote/plugins/<n>`: both
 * install to one folder, and D2 guard 5 refuses the second install. A hand
 * edit or an older state can still hold the pair. Then a bare name must not
 * pick one row silently (`rm` would delete one owner's row and keep the
 * other) or reconcile both into one folder (`apply`, `update`). This is the
 * refusal the shelf gives for the same ambiguity.
 */
export function remoteKeysForNamedRef(
  lock: RemotesLock,
  ref: ItemRef,
): string[] {
  const keys = remoteKeysForRef(lock, ref);
  if (keys.length > 1) {
    const found = keys
      .map((key) => {
        const parts = parseRemoteKey(key);
        return `${parts.kind}/${parts.name}`;
      })
      .sort()
      .join(", ");
    throw new PreconditionError(
      `ambiguous item "${ref.name}": found ${found}; use kind/name`,
    );
  }
  return keys;
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
 *
 * The version is computed from the rows, not carried from `lock.version`: a
 * file with a `plugins` row is written as version 2, and one with skill rows
 * only is written as version 1, so removing the last plugin row moves the
 * file back down and capshelf 0.13 can read it again.
 */
export function serializeRemotesLock(lock: RemotesLock): string {
  const version: 1 | 2 = Object.keys(lock.items).some(
    (key) => parseRemoteKey(key).kind === "plugins",
  )
    ? 2
    : 1;
  const parsed = RemotesLockSchema.parse({ ...lock, version });
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
