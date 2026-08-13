import { z } from "zod";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { localLockPath, lockPath, lockReadPath } from "./paths";
import { atomicWriteFile, isErrno } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";
import { ItemNeedsSchema } from "./metadata";
import type { ItemNeeds } from "./metadata";
import { PIN_DIGEST_PATTERN } from "./pin";
import type { PinnedSource } from "./pin";
import { PreconditionError } from "./errors";

// A git object name (abbreviated or full, SHA-1 or SHA-256). Validated on load
// so an attacker-supplied lockfile can't smuggle option-like values (e.g.
// `--output=/path`) into the `git show <rev>:<path>` argv, where the trailing
// `:<path>` defeats any `--` argument guard.
const GitCommitSchema = z
  .string()
  .regex(
    /^[0-9a-f]{7,64}$/,
    "sourceCommit must be a lowercase hex git object name",
  );

/**
 * Version 4 resolves every `sourceCommit` to a full object name. An
 * abbreviation is a request for Git to guess, and two clones with different
 * object populations can guess differently.
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

const DataLockEntryV2Schema = z.object({
  source: z.literal("data"),
  sha: z.string(),
  sourceCommit: GitCommitSchema,
  appliedAt: z.string(),
  label: z.string().optional(),
  /**
   * Intentional project-local divergence. Set only by `keep-local`, cleared
   * only by `keep-local --unset`. This records *intent*, not a fact about
   * current content: it survives `revert`, so a user can reset to the pinned
   * base and start a fresh edit without losing the marker, and it survives a
   * lock refresh (`refreshDataLockEntry`) so `update` and `sync` cannot
   * silently revoke it.
   *
   * It means "do not reconcile this automatically", not "do not touch".
   * `apply` and `update` skip the item. `revert` is the explicit user-driven
   * override and reconciles through it behind the destructive-change consent
   * gate. `promote` refuses: publishing would end the divergence the marker
   * asserts, so the user must clear it first.
   */
  local: z.literal(true).optional(),
  localReason: z.string().optional(),
});

export const DataLockEntryV3Schema = DataLockEntryV2Schema.extend({
  needs: ItemNeedsSchema.nullable(),
  needsSourceCommit: GitCommitSchema.nullable(),
});

/** Kept for source-level compatibility with existing importers. */
export const DataLockEntrySchema = DataLockEntryV3Schema;

export const DataLockEntryV4Schema = z.object({
  source: z.literal("data"),
  sourcePinDigest: SourcePinDigestSchema,
  sourceCommit: FullGitCommitSchema,
  needs: ItemNeedsSchema.nullable(),
  needsSourceCommit: GitCommitSchema.nullable(),
  appliedAt: z.string(),
  label: z.string().optional(),
  local: z.literal(true).optional(),
  localReason: z.string().optional(),
});

export const SystemLockEntrySchema = z.object({
  source: z.literal("system"),
  sha: z.string(),
  cliVersion: z.string(),
  appliedAt: z.string(),
});

const LockEntryV2Schema = z.discriminatedUnion("source", [
  DataLockEntryV2Schema,
  SystemLockEntrySchema,
]);

export const LockEntrySchema = z.discriminatedUnion("source", [
  DataLockEntryV3Schema,
  SystemLockEntrySchema,
]);

export const LockEntryV4Schema = z.discriminatedUnion("source", [
  DataLockEntryV4Schema,
  SystemLockEntrySchema,
]);

export const LockV2Schema = z.object({
  version: z.literal(2),
  items: z.record(z.string(), LockEntryV2Schema).default({}),
});

function withNeedsPairing<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine(
    (
      lock: {
        items: Record<
          string,
          { source: string; needs?: unknown; needsSourceCommit?: unknown }
        >;
      },
      ctx: z.RefinementCtx,
    ) => {
      for (const [key, entry] of Object.entries(lock.items)) {
        if (
          entry.source === "data" &&
          (entry.needs === null) !== (entry.needsSourceCommit === null)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["items", key],
            message:
              "needs and needsSourceCommit must both be null or both be set",
          });
        }
      }
    },
  ) as unknown as T;
}

export const LockV3Schema = withNeedsPairing(
  z.object({
    version: z.literal(3),
    items: z.record(z.string(), LockEntrySchema).default({}),
  }),
);

/**
 * Version 4 has **no legacy data-entry variant**. The lock version describes
 * every entry in the file, so a union would keep two identity models alive in
 * every consumer until the last entry happened to re-pin — and a project with
 * one unreachable historical commit could stay mixed forever. `lock migrate`
 * builds a complete v4 candidate or writes nothing.
 */
export const LockV4Schema = withNeedsPairing(
  z.object({
    version: z.literal(4),
    items: z.record(z.string(), LockEntryV4Schema).default({}),
  }),
);

export const LockSchema = LockV4Schema;

export const LOCK_VERSION = 4 as const;

type PersistedDataLockEntryV3 = z.infer<typeof DataLockEntryV3Schema>;
type PersistedDataLockEntryV4 = z.infer<typeof DataLockEntryV4Schema>;

type NeedsFields = {
  /**
   * Optional only for source-level compatibility with older test/client
   * constructors. Both loaders always migrate these to explicit nulls, and
   * both writers validate the required shape.
   */
  needs?: ItemNeeds | null;
  needsSourceCommit?: string | null;
};

/**
 * A data entry written by lock version 2 or 3: identity is `sha`, a hash of
 * the data repo *working tree*. Readable, never writable.
 */
export type DataLockEntryV3 = Omit<
  PersistedDataLockEntryV3,
  "needs" | "needsSourceCommit"
> &
  NeedsFields & { sourcePinDigest?: undefined };

/** A data entry written by lock version 4: identity is the committed tree. */
export type DataLockEntryV4 = Omit<
  PersistedDataLockEntryV4,
  "needs" | "needsSourceCommit"
> &
  NeedsFields & { sha?: undefined };

export type DataLockEntry = DataLockEntryV3 | DataLockEntryV4;
export type SystemLockEntry = z.infer<typeof SystemLockEntrySchema>;
export type LockEntry = DataLockEntry | SystemLockEntry;
export type LockEntryV4 = DataLockEntryV4 | SystemLockEntry;

export interface LockV3 {
  version: 3;
  items: Record<string, LockEntry>;
}

export interface LockV4 {
  version: 4;
  items: Record<string, LockEntryV4>;
}

/**
 * The runtime lock. Read-only and non-lock-writing commands accept either
 * version; every writer narrows to `LockV4` through `assertLockV4` first, so
 * an ordinary command can never silently upgrade a project.
 */
export type Lock = LockV3 | LockV4;

export function emptyLock(): LockV4 {
  return { version: LOCK_VERSION, items: {} };
}

export function isLockV4(lock: Lock): lock is LockV4 {
  return lock.version === LOCK_VERSION;
}

/**
 * The single gate that stops an ordinary command from writing an old lock.
 *
 * The alternative — migrating on the next natural re-pin — would rewrite every
 * entry in the file as a side effect of updating one item, and would surface an
 * unrelated blocker as an `add`, `move`, or `keep-local` failure.
 */
export function assertLockV4(lock: Lock, verb: string): LockV4 {
  if (isLockV4(lock)) return lock;
  throw new PreconditionError(
    `this project's lock is version ${lock.version}; ${verb} writes lock version ${LOCK_VERSION}`,
    {
      hint: `Convert the project and local locks first: ${PRODUCT_NAME} lock migrate (preview it with --dry-run).`,
    },
  );
}

/**
 * The identity a lock entry records, whichever version wrote it, for display
 * and for equality against a value computed the same way. Comparisons that
 * decide whether content is correct must not use this: a v3 `sha` and a v4
 * `sourcePinDigest` answer different questions, and mixing them silently
 * would recreate the defect version 4 exists to remove.
 */
export function entryIdentity(entry: LockEntry): string {
  if (entry.source === "system") return entry.sha;
  return entry.sourcePinDigest ?? entry.sha;
}

export async function loadLock(project: string): Promise<Lock> {
  const p = lockReadPath(project);
  if (!p) return emptyLock();
  const raw = await readFile(p, "utf-8");
  return parseLock(JSON.parse(raw));
}

export async function saveLock(project: string, lock: LockV4): Promise<void> {
  const p = lockPath(project);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, serializeLock(lock));
}

export async function loadLocalLock(project: string): Promise<Lock> {
  const p = localLockPath(project);
  try {
    const raw = await readFile(p, "utf-8");
    return parseLock(JSON.parse(raw));
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return emptyLock();
    }
    throw err;
  }
}

export async function saveLocalLock(
  project: string,
  lock: LockV4,
): Promise<void> {
  const p = localLockPath(project);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, serializeLock(lock));
}

/**
 * Serialize a complete v4 candidate and strict-parse it back. `lock migrate`
 * relies on this being the only writer: a serializer that dropped a digest has
 * to fail here, before any file is published, rather than after.
 */
export function serializeLock(lock: LockV4): string {
  const parsed = LockV4Schema.parse({ ...lock, version: LOCK_VERSION });
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseLock(value: unknown): Lock {
  const version =
    typeof value === "object" && value !== null && "version" in value
      ? (value as { version?: unknown }).version
      : undefined;
  if (typeof version === "number" && version > LOCK_VERSION) {
    throw new Error(
      `lock version ${version} is newer than this ${PRODUCT_NAME} supports — upgrade ${PRODUCT_NAME}`,
    );
  }
  if (version === LOCK_VERSION) return LockV4Schema.parse(value) as LockV4;
  if (version === 2) return normalizeV2(LockV2Schema.parse(value));
  return LockV3Schema.parse(value) as LockV3;
}

/**
 * Version 2 gains explicit needs nulls in memory. Capshelf never writes an
 * intermediate v3 file: `lock migrate` feeds this straight into the complete
 * v4 candidate.
 */
function normalizeV2(lock: z.infer<typeof LockV2Schema>): LockV3 {
  return {
    version: 3,
    items: Object.fromEntries(
      Object.entries(lock.items).map(([key, entry]) => [
        key,
        entry.source === "data"
          ? { ...entry, needs: null, needsSourceCommit: null }
          : entry,
      ]),
    ),
  };
}

export function needsEqual(a: ItemNeeds, b: ItemNeeds): boolean {
  return (
    arraysEqual(a.network, b.network) &&
    arraysEqual(a.env, b.env) &&
    arraysEqual(a.bin, b.bin)
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface DataLockEntryInput {
  /**
   * PIN-2. The pin arrives as one branded value built by `src/pin.ts`, so a
   * call site cannot assemble `(digest, commit)` from parts that were never
   * observed together.
   */
  pin: PinnedSource;
  needs: ItemNeeds;
  needsSourceCommit: string;
  appliedAt?: string;
  label?: string;
  local?: true;
  localReason?: string;
}

export function createDataLockEntry(
  input: DataLockEntryInput,
): DataLockEntryV4 {
  return {
    source: "data",
    sourcePinDigest: input.pin.sourcePinDigest,
    sourceCommit: input.pin.sourceCommit,
    needs: input.needs,
    needsSourceCommit: input.needsSourceCommit,
    appliedAt: input.appliedAt ?? new Date().toISOString(),
    ...(input.label !== undefined && { label: input.label }),
    ...(input.local === true && { local: true as const }),
    ...(input.localReason !== undefined && { localReason: input.localReason }),
  };
}

export function refreshDataLockEntry(
  entry: DataLockEntry,
  input: DataLockEntryInput,
): DataLockEntryV4 {
  return createDataLockEntry({
    ...input,
    ...(entry.label !== undefined && { label: entry.label }),
    ...(entry.local === true && { local: true }),
    ...(entry.localReason !== undefined && {
      localReason: entry.localReason,
    }),
  });
}

export function dataKey(kind: string, name: string): string {
  return `data/${kind}/${name}`;
}

export function systemKey(kind: string, name: string): string {
  return `system/${kind}/${name}`;
}

/**
 * Build a lock key. Use dataKey/systemKey when source is known statically.
 */
export function itemKey(
  source: "data" | "system",
  kind: string,
  name: string,
): string {
  return `${source}/${kind}/${name}`;
}
