import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { localLockPath, lockPath, lockReadPath } from "./paths";
import { atomicWriteFile, ensureDir, isErrno } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";
import { ItemNeedsSchema } from "./metadata";
import type { ItemNeeds } from "./metadata";
import type { ConfigValue } from "./config-values";
import { PIN_DIGEST_PATTERN } from "./pin";
import type { PinnedSource } from "./pin";
import { PreconditionError } from "./errors";

// Validated on load so a hostile lockfile cannot smuggle option-like values
// into `git show <rev>:<path>`, where the trailing `:<path>` defeats a `--`
// guard.
const GitCommitSchema = z
  .string()
  .regex(
    /^[0-9a-f]{7,64}$/,
    "sourceCommit must be a lowercase hex git object name",
  );

/**
 * Lock versions 4 and later require every `sourceCommit` to be a full object
 * name. An abbreviation is a request for Git to guess, and clones with
 * different object populations can guess differently.
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
   * Records intent, not content state: it survives `revert` and lock refresh,
   * and means "do not reconcile automatically" rather than "do not touch".
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

function withNeedsPairing<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T, z.output<T>, z.input<T>> {
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
  );
}

export const LockV3Schema = withNeedsPairing(
  z.object({
    version: z.literal(3),
    items: z.record(z.string(), LockEntrySchema).default({}),
  }),
);

/**
 * Lock versions 4 and 5 have no legacy data-entry variant. A union would keep
 * two identity models alive in every consumer, and a project with one
 * unreachable historical commit could stay mixed forever. `lock migrate` builds
 * a complete candidate or writes nothing.
 */
export const LockV4Schema = withNeedsPairing(
  z.object({
    version: z.literal(4),
    items: z.record(z.string(), LockEntryV4Schema).default({}),
  }),
);

export const LockV5Schema = withNeedsPairing(
  z.object({
    version: z.literal(5),
    items: z.record(z.string(), LockEntryV4Schema).default({}),
  }),
);

export const LockSchema = LockV5Schema;

export const LOCK_VERSION = 5 as const;

type PersistedDataLockEntryV3 = z.infer<typeof DataLockEntryV3Schema>;
type PersistedDataLockEntryV4 = z.infer<typeof DataLockEntryV4Schema>;

type NeedsFields = {
  /**
   * Optional only so older constructors still compile; loaders always migrate
   * these to explicit nulls and writers validate the required shape.
   */
  needs?: ItemNeeds | null;
  needsSourceCommit?: string | null;
};

export type DataLockEntryV3 = Omit<
  PersistedDataLockEntryV3,
  "needs" | "needsSourceCommit"
> &
  NeedsFields & { sourcePinDigest?: undefined };

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

export interface LockV5 {
  version: 5;
  items: Record<string, LockEntryV4>;
}

/**
 * Writers narrow through `assertWritableLock` so an ordinary command can never
 * silently upgrade a project's lock.
 */
export type Lock = LockV3 | LockV4 | LockV5;

export type WritableLock = LockV5;

export function emptyLock(): WritableLock {
  return { version: LOCK_VERSION, items: {} };
}

export function isWritableLock(lock: Lock): lock is WritableLock {
  return lock.version === LOCK_VERSION;
}

/**
 * The single gate that stops an ordinary command from writing an old lock.
 * Migrating on the next re-pin instead would rewrite every entry as a side
 * effect of updating one item, and would surface an unrelated blocker as an
 * `add`, `move`, or `keep-local` failure.
 */
export function assertWritableLock(lock: Lock, verb: string): WritableLock {
  if (isWritableLock(lock)) return lock;
  throw new PreconditionError(
    `this project's lock is version ${lock.version}; ${verb} writes lock version ${LOCK_VERSION}`,
    {
      hint: `Convert the project and local locks first: ${PRODUCT_NAME} lock migrate (preview it with --dry-run).`,
    },
  );
}

/**
 * The identity a lock entry records, for display and for equality against a
 * value computed the same way. Never use it to decide whether content is
 * correct: a v3 `sha` and a v4 `sourcePinDigest` answer different questions.
 */
export function entryIdentity(entry: LockEntry): string {
  if (entry.source === "system") return entry.sha;
  return entry.sourcePinDigest ?? entry.sha;
}

export async function loadLock(project: string): Promise<Lock> {
  const p = lockReadPath(project);
  if (!p) return emptyLock();
  const document: ConfigValue = JSON.parse(await readFile(p, "utf-8"));
  return parseLock(document);
}

export async function saveLock(
  project: string,
  lock: WritableLock,
): Promise<void> {
  const p = lockPath(project);
  await ensureDir(dirname(p), { root: project });
  await atomicWriteFile(p, serializeLock(lock), { root: project });
}

export async function loadLocalLock(project: string): Promise<Lock> {
  const p = localLockPath(project);
  try {
    const document: ConfigValue = JSON.parse(await readFile(p, "utf-8"));
    return parseLock(document);
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return emptyLock();
    }
    throw err;
  }
}

export async function saveLocalLock(
  project: string,
  lock: WritableLock,
): Promise<void> {
  const p = localLockPath(project);
  await ensureDir(dirname(p), { root: project });
  await atomicWriteFile(p, serializeLock(lock), { root: project });
}

/**
 * Validates the complete v5 candidate against the schema before serializing, so
 * an entry with a dropped digest fails before any file is published.
 */
export function serializeLock(lock: WritableLock): string {
  const parsed = LockV5Schema.parse({ ...lock, version: LOCK_VERSION });
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

const VersionProbe = z.object({ version: z.number().optional() });

export function parseLock(value: ConfigValue): Lock {
  const probe = VersionProbe.safeParse(value);
  const version = probe.success ? probe.data.version : undefined;
  if (version !== undefined && version > LOCK_VERSION) {
    throw new Error(
      `lock version ${version} is newer than this ${PRODUCT_NAME} supports — upgrade ${PRODUCT_NAME}`,
    );
  }
  const lock: Lock =
    version === LOCK_VERSION
      ? LockV5Schema.parse(value)
      : version === 4
        ? LockV4Schema.parse(value)
        : version === 2
          ? normalizeV2(LockV2Schema.parse(value))
          : LockV3Schema.parse(value);
  refusePluginKeysBefore5(lock);
  return lock;
}

/**
 * An older binary silently strips unknown manifest arrays, so locks below
 * version 5 refuse a `plugins` key rather than let an old `lock migrate` carry
 * it across.
 */
function refusePluginKeysBefore5(lock: Lock): void {
  if (lock.version === LOCK_VERSION) return;
  const key = Object.keys(lock.items).find(
    (k) => k.split("/")[1] === "plugins",
  );
  if (key === undefined) return;
  throw new PreconditionError(
    `lock version ${lock.version} holds ${key}; plugin items need lock version ${LOCK_VERSION}`,
    { hint: `${PRODUCT_NAME} lock migrate` },
  );
}

/**
 * Version 2 gains explicit needs nulls in memory only. Capshelf never writes an
 * intermediate v3 file, because `lock migrate` feeds this straight into the
 * complete candidate at the current lock version.
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

export function hasNeedsSnapshot(
  entry: DataLockEntry,
): entry is DataLockEntry & { needs: ItemNeeds; needsSourceCommit: string } {
  return (
    entry.needs !== null &&
    entry.needs !== undefined &&
    entry.needsSourceCommit !== null &&
    entry.needsSourceCommit !== undefined
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface DataLockEntryInput {
  /**
   * The pin is one branded value so a call site cannot assemble (digest,
   * commit) from parts never observed together.
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

export function itemKey(
  source: "data" | "system",
  kind: string,
  name: string,
): string {
  return `${source}/${kind}/${name}`;
}
