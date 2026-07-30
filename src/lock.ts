import { z } from "zod";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { localLockPath, lockPath, lockReadPath } from "./paths";
import { atomicWriteFile, isErrno } from "./fs-utils";
import { ItemNeedsSchema } from "./metadata";
import type { ItemNeeds } from "./metadata";

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

const DataLockEntryV2Schema = z.object({
  source: z.literal("data"),
  sha: z.string(),
  sourceCommit: GitCommitSchema,
  appliedAt: z.string(),
  label: z.string().optional(),
  local: z.literal(true).optional(),
  localReason: z.string().optional(),
});

export const DataLockEntrySchema = DataLockEntryV2Schema.extend({
  needs: ItemNeedsSchema.nullable(),
  needsSourceCommit: GitCommitSchema.nullable(),
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
  DataLockEntrySchema,
  SystemLockEntrySchema,
]);

export const LockV2Schema = z.object({
  version: z.literal(2),
  items: z.record(z.string(), LockEntryV2Schema).default({}),
});

export const LockV3Schema = z
  .object({
    version: z.literal(3),
    items: z.record(z.string(), LockEntrySchema).default({}),
  })
  .superRefine((lock, ctx) => {
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
  });

export const LockSchema = LockV3Schema;

type PersistedDataLockEntry = z.infer<typeof DataLockEntrySchema>;
export type DataLockEntry = Omit<
  PersistedDataLockEntry,
  "needs" | "needsSourceCommit"
> & {
  /**
   * Optional only for source-level compatibility with older test/client
   * constructors. Both loaders always migrate these to explicit nulls, and
   * both writers validate the required v3 shape.
   */
  needs?: ItemNeeds | null;
  needsSourceCommit?: string | null;
};
export type SystemLockEntry = z.infer<typeof SystemLockEntrySchema>;
export type LockEntry = DataLockEntry | SystemLockEntry;
export interface Lock {
  version: 3;
  items: Record<string, LockEntry>;
}

export function emptyLock(): Lock {
  return { version: 3, items: {} };
}

export async function loadLock(project: string): Promise<Lock> {
  const p = lockReadPath(project);
  if (!p) return emptyLock();
  const raw = await readFile(p, "utf-8");
  return parseLock(JSON.parse(raw));
}

export async function saveLock(project: string, lock: Lock): Promise<void> {
  const p = lockPath(project);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, `${JSON.stringify(asVersion3(lock), null, 2)}\n`);
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
  lock: Lock,
): Promise<void> {
  const p = localLockPath(project);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, `${JSON.stringify(asVersion3(lock), null, 2)}\n`);
}

function parseLock(value: unknown): Lock {
  const version =
    typeof value === "object" && value !== null && "version" in value
      ? (value as { version?: unknown }).version
      : undefined;
  if (typeof version === "number" && version > 3) {
    throw new Error(
      `lock version ${version} is newer than this capshelf supports — upgrade capshelf`,
    );
  }
  if (version === 2) {
    const lock = LockV2Schema.parse(value);
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
  return LockV3Schema.parse(value);
}

function asVersion3(lock: Lock): Lock {
  return LockV3Schema.parse({ ...lock, version: 3 });
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
  sha: string;
  sourceCommit: string;
  needs: ItemNeeds;
  needsSourceCommit: string;
  appliedAt?: string;
  label?: string;
  local?: true;
  localReason?: string;
}

export function createDataLockEntry(input: DataLockEntryInput): DataLockEntry {
  return {
    source: "data",
    sha: input.sha,
    sourceCommit: input.sourceCommit,
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
): DataLockEntry {
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
