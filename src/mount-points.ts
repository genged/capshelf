import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PreconditionError } from "./errors";
import { ensureDir, isErrno, rmTreeWithRetries } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";
import { findDestinationPathCollision } from "./path-collision";
import { assertInScope, type MutationScope } from "./path-safety";

/**
 * A rename takes a mounted volume with the folder, and a recursive delete
 * empties the volume then fails with EBUSY, so replacements must leave mount
 * points in place and must not move, copy, or delete their contents.
 */
export interface MountLayout {
  mounts: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
}

const NO_MOUNTS: MountLayout = { mounts: new Set(), pinned: new Set() };

export async function readMountLayout(root: string): Promise<MountLayout> {
  const found = await layoutAt(root);
  if (found.rootIsMount) {
    throw new PreconditionError(
      `${root} is a mount point; ${PRODUCT_NAME} cannot replace a folder that is mounted`,
      {
        hint: "Mount the volume on a folder inside the item, for example its node_modules, then rerun the command.",
      },
    );
  }
  return found.layout;
}

async function layoutAt(
  root: string,
): Promise<{ rootIsMount: boolean; layout: MountLayout }> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { rootIsMount: false, layout: NO_MOUNTS };
    }
    throw error;
  }
  const found = await mountPointsAt(realRoot);
  const outermost = found.below.filter(
    (path) =>
      !found.below.some(
        (other) => other !== path && path.startsWith(`${other}/`),
      ),
  );
  return { rootIsMount: found.root, layout: holding(NO_MOUNTS, outermost) };
}

export function holding(
  layout: MountLayout,
  paths: readonly string[],
): MountLayout {
  if (paths.length === 0) return layout;
  const mounts = new Set(layout.mounts);
  const pinned = new Set(layout.pinned);
  for (const path of paths) {
    mounts.add(path);
    for (const ancestor of ancestorsOf(path)) pinned.add(ancestor);
  }
  return { mounts, pinned };
}

export function carriedUnits(opts: {
  kept: readonly string[];
  blockers: readonly string[];
  layout: MountLayout;
}): string[] {
  const blocked = new Set<string>([""]);
  for (const path of [...opts.blockers, ...opts.layout.mounts]) {
    blocked.add(path);
    for (const ancestor of ancestorsOf(path)) blocked.add(ancestor);
  }
  const units = new Set<string>();
  for (const path of opts.kept) {
    if (isOnMount(opts.layout, path)) continue;
    const parts = path.split("/");
    let unit = path;
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      if (!blocked.has(prefix)) {
        unit = prefix;
        break;
      }
    }
    units.add(unit);
  }
  return [...units].sort();
}

/**
 * Renaming a folder to a new parent must write its `..` entry, which Linux
 * refuses with EACCES for read-only folders (e.g. Go module cache), so those
 * are held in place.
 */
export async function splitMovableUnits(
  root: string,
  units: readonly string[],
): Promise<{ movable: string[]; held: string[] }> {
  const movable: string[] = [];
  const held: string[] = [];
  for (const unit of units) {
    const path = absolute(root, unit);
    if (!(await lstat(path)).isDirectory()) {
      movable.push(unit);
      continue;
    }
    try {
      await access(path, constants.W_OK);
      movable.push(unit);
    } catch (error) {
      if (!isErrno(error, "EACCES") && !isErrno(error, "EPERM")) throw error;
      held.push(unit);
    }
  }
  return { movable, held };
}

/**
 * Every move in this file goes through here, and both paths pass the scope
 * check before the rename, so a symlinked parent cannot take a move out of the
 * scope's root.
 */
async function renameInScope(
  from: string,
  to: string,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, from);
  await assertInScope(scope, to);
  await rename(from, to);
}

export async function moveUnits(
  units: readonly string[],
  from: string,
  to: string,
  scope: MutationScope,
): Promise<void> {
  for (const unit of units) {
    const destination = absolute(to, unit);
    await ensureDir(dirname(destination), scope);
    await renameInScope(absolute(from, unit), destination, scope);
  }
}

export async function returnUnits(
  units: readonly string[],
  places: readonly string[],
  backup: string,
  scope: MutationScope,
): Promise<void> {
  for (const unit of [...units].reverse()) {
    for (const place of places) {
      const source = absolute(place, unit);
      try {
        await lstat(source);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      const destination = absolute(backup, unit);
      await ensureDir(dirname(destination), scope);
      await renameInScope(source, destination, scope);
      break;
    }
  }
}

export async function assertNoManagedPathOnMount(
  root: string,
  layout: MountLayout,
  managedPaths: readonly string[],
): Promise<void> {
  if (layout.mounts.size === 0) return;
  const collision = await findDestinationPathCollision(root, managedPaths, [
    ...layout.mounts,
  ]);
  if (!collision) return;
  throw new PreconditionError(
    `managed path ${collision.left} in ${root} collides with mount point ${collision.right}; ${PRODUCT_NAME} does not write on a mounted volume`,
    {
      hint: "Unmount the volume or move it to a path the item does not manage, then rerun the command.",
    },
  );
}

export function isOnMount(layout: MountLayout, path: string): boolean {
  for (const mount of layout.mounts) {
    if (path === mount || path.startsWith(`${mount}/`)) return true;
  }
  return false;
}

export async function detachTree(
  target: string,
  backup: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await renameInScope(target, backup, scope);
    return;
  }
  await ensureDir(backup, scope);
  await moveChildren(target, backup, "", layout, scope);
}

export async function attachTree(
  source: string,
  target: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await renameInScope(source, target, scope);
    return;
  }
  await moveChildren(source, target, "", layout, scope);
}

export async function copyTree(
  source: string,
  target: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, target);
  if (layout.pinned.size === 0) {
    await cp(source, target, { recursive: true, preserveTimestamps: true });
    return;
  }
  await copyChildren(source, target, "", layout, scope);
}

export async function clearTree(
  target: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await rmTreeWithRetries(target, scope);
    return;
  }
  await clearChildren(target, "", layout, scope);
}

/**
 * Deleting through a mount point would empty the volume and then fail with
 * EBUSY, so mount points are kept.
 */
export async function removeInstalledTree(
  root: string,
  scope: MutationScope,
): Promise<string[]> {
  await assertInScope(scope, root);
  const layout = await readMountLayout(root);
  await clearTree(root, layout, scope);
  return [...layout.mounts].sort();
}

/**
 * This is what `rm` leaves for an item with a mounted volume, so `add` treats
 * it as an empty target, not an unmanaged one.
 */
export async function holdsOnlyMountPoints(root: string): Promise<boolean> {
  const layout = await readMountLayout(root);
  if (layout.mounts.size === 0) return false;
  async function onlyPinned(relDir: string): Promise<boolean> {
    for (const entry of await readdir(absolute(root, relDir), {
      withFileTypes: true,
    })) {
      const path = childPath(relDir, entry.name);
      if (layout.mounts.has(path)) continue;
      if (!layout.pinned.has(path) || !entry.isDirectory()) return false;
      if (!(await onlyPinned(path))) return false;
    }
    return true;
  }
  return await onlyPinned("");
}

/**
 * A recursive delete would empty a mounted volume before failing on the mount
 * point, so refuse before deleting.
 */
export async function removeScratchTree(
  path: string,
  scope: MutationScope,
): Promise<void> {
  const found = await layoutAt(path);
  const [mount] = found.layout.mounts;
  const mountPoint = found.rootIsMount
    ? path
    : mount === undefined
      ? undefined
      : join(path, ...mount.split("/"));
  if (mountPoint !== undefined) {
    throw new Error(
      `${mountPoint} is a mount point; ${PRODUCT_NAME} did not delete the scratch folder ${path}. Unmount it, then remove ${path}.`,
    );
  }
  await rmTreeWithRetries(path, scope);
}

async function moveChildren(
  from: string,
  to: string,
  relDir: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  for (const name of await readdir(absolute(from, relDir))) {
    const path = childPath(relDir, name);
    if (layout.mounts.has(path)) continue;
    if (layout.pinned.has(path)) {
      await ensureDir(absolute(to, path), scope);
      await moveChildren(from, to, path, layout, scope);
      continue;
    }
    await renameInScope(absolute(from, path), absolute(to, path), scope);
  }
}

async function copyChildren(
  from: string,
  to: string,
  relDir: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  for (const name of await readdir(absolute(from, relDir))) {
    const path = childPath(relDir, name);
    if (layout.mounts.has(path)) continue;
    if (layout.pinned.has(path)) {
      await ensureDir(absolute(to, path), scope);
      await copyChildren(from, to, path, layout, scope);
      continue;
    }
    await assertInScope(scope, absolute(to, path));
    await cp(absolute(from, path), absolute(to, path), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
}

async function clearChildren(
  target: string,
  relDir: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(absolute(target, relDir));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  for (const name of names) {
    const path = childPath(relDir, name);
    if (layout.mounts.has(path)) continue;
    if (layout.pinned.has(path)) {
      await clearChildren(target, path, layout, scope);
      continue;
    }
    await rmTreeWithRetries(absolute(target, path), scope);
  }
}

interface MountPointsAt {
  root: boolean;
  below: string[];
}

/**
 * /proc/self/mountinfo finds bind mounts from the same filesystem that keep
 * their device number; other systems lack it, so fall back to comparing device
 * numbers.
 */
async function mountPointsAt(realRoot: string): Promise<MountPointsAt> {
  let mountinfo: string;
  try {
    mountinfo = await readFile("/proc/self/mountinfo", "utf-8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return await mountPointsByDevice(realRoot);
  }
  const prefix = realRoot === "/" ? "/" : `${realRoot}/`;
  const below = new Set<string>();
  let root = false;
  for (const line of mountinfo.split("\n")) {
    // Field 5 is the mount point, with space, tab, newline, and backslash
    // written as octal escapes.
    const field = line.split(" ")[4];
    if (field === undefined) continue;
    const mountPoint = field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (mountPoint === realRoot) root = true;
    else if (mountPoint.startsWith(prefix)) {
      below.add(mountPoint.slice(prefix.length));
    }
  }
  return { root, below: [...below].sort() };
}

async function mountPointsByDevice(realRoot: string): Promise<MountPointsAt> {
  const rootDevice = (await lstat(realRoot)).dev;
  const root =
    realRoot !== dirname(realRoot) &&
    (await lstat(dirname(realRoot))).dev !== rootDevice;
  const below: string[] = [];
  async function walk(relDir: string): Promise<void> {
    const entries = await readdir(absolute(realRoot, relDir), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = childPath(relDir, entry.name);
      if ((await lstat(absolute(realRoot, path))).dev !== rootDevice) {
        below.push(path);
        continue;
      }
      await walk(path);
    }
  }
  await walk("");
  return { root, below: below.sort() };
}

function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out = [""];
  for (let index = 1; index < parts.length; index++) {
    out.push(parts.slice(0, index).join("/"));
  }
  return out;
}

function childPath(relDir: string, name: string): string {
  return relDir ? `${relDir}/${name}` : name;
}

function absolute(root: string, path: string): string {
  return path ? join(root, ...path.split("/")) : root;
}
