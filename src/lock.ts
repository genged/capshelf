import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { localLockPath, lockPath, lockReadPath } from "./paths";
import { isErrno } from "./fs-utils";

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

export const DataLockEntrySchema = z.object({
  source: z.literal("data"),
  sha: z.string(),
  sourceCommit: GitCommitSchema,
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

export const LockEntrySchema = z.discriminatedUnion("source", [
  DataLockEntrySchema,
  SystemLockEntrySchema,
]);

export const LockSchema = z.object({
  version: z.literal(2),
  items: z.record(z.string(), LockEntrySchema).default({}),
});

export type Lock = z.infer<typeof LockSchema>;
export type LockEntry = z.infer<typeof LockEntrySchema>;
export type DataLockEntry = z.infer<typeof DataLockEntrySchema>;
export type SystemLockEntry = z.infer<typeof SystemLockEntrySchema>;

export function emptyLock(): Lock {
  return { version: 2, items: {} };
}

export async function loadLock(project: string): Promise<Lock> {
  const p = lockReadPath(project);
  if (!p) return emptyLock();
  const raw = await readFile(p, "utf-8");
  const parsed = JSON.parse(raw);
  return LockSchema.parse(parsed);
}

export async function saveLock(project: string, lock: Lock): Promise<void> {
  const p = lockPath(project);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(lock, null, 2)}\n`);
}

export async function loadLocalLock(project: string): Promise<Lock> {
  const p = localLockPath(project);
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    return LockSchema.parse(parsed);
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
  await writeFile(p, `${JSON.stringify(lock, null, 2)}\n`);
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
