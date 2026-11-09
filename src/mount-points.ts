import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { PreconditionError } from "./errors";
import { isErrno, rmTreeWithRetries } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";
import { findDestinationPathCollision } from "./path-collision";

/**
 * The mount points inside an installed folder.
 *
 * A container can attach a volume on a folder inside an item, for example a
 * skill's `node_modules`. A rename of the item folder takes the mount with it,
 * and a recursive delete of the old copy then empties the volume and fails
 * with EBUSY on the mount point. So a folder replacement must keep each mount
 * point in its place and must not move, copy, or delete what is on it.
 */
export interface MountLayout {
  /** The outermost mount points below the root, as `/` paths. */
  mounts: ReadonlySet<string>;
  /** The folders that hold a mount point, as `/` paths. `""` is the root. */
  pinned: ReadonlySet<string>;
}

const NO_MOUNTS: MountLayout = { mounts: new Set(), pinned: new Set() };

/**
 * Read the mount points below `root`. A missing root has none. Refuses a
 * root that is itself a mount point, because a rename cannot move it.
 */
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

/**
 * `layout`, plus `paths` held in place like mount points. Each walk below
 * skips a held path and keeps the folders above it. A move of row-4 state by
 * rename holds those paths, so a copy or a delete of the rest leaves them.
 */
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

/**
 * The row-4 entries a folder replacement moves with one rename each. Each
 * kept path goes in the largest folder above it that holds no blocker, or
 * moves alone. A blocker is a path the replacement writes, deletes, or must
 * not move: a managed or visible path, or a mount point. A kept path on a
 * mount point is not moved at all.
 */
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
 * Split `units` below `root` into the ones a rename can move and the ones
 * that must stay in place. A rename that gives a folder a new parent must
 * write the folder's `..` entry, so Linux refuses it for a read-only folder
 * (EACCES). Tools such as the Go module cache make folders read-only. A held
 * unit stays where it is, like a mount point, so it is never moved or copied.
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

/** Rename each unit from `from` to `to`, creating parent folders. */
export async function moveUnits(
  units: readonly string[],
  from: string,
  to: string,
): Promise<void> {
  for (const unit of units) {
    const destination = absolute(to, unit);
    await mkdir(dirname(destination), { recursive: true });
    await rename(absolute(from, unit), destination);
  }
}

/**
 * Put moved units back in `backup`. A unit is in the first of `places` that
 * holds it, or it never left `backup`. A unit is never a pinned folder or a
 * mount point, so a path in `places` with its name is the moved unit.
 */
export async function returnUnits(
  units: readonly string[],
  places: readonly string[],
  backup: string,
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
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      break;
    }
  }
}

/**
 * Refuse managed paths that are on a mount point, or that would replace a
 * folder that holds one. A folder replacement cannot write either.
 */
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

/** True when `path` is a mount point in `layout` or is on one. */
export function isOnMount(layout: MountLayout, path: string): boolean {
  for (const mount of layout.mounts) {
    if (path === mount || path.startsWith(`${mount}/`)) return true;
  }
  return false;
}

/**
 * Move the contents of `target` to the new path `backup`. Without mounts this
 * is one rename. With mounts, the folders that hold a mount stay in `target`,
 * the mount points stay where they are, and all other entries move.
 */
export async function detachTree(
  target: string,
  backup: string,
  layout: MountLayout,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await rename(target, backup);
    return;
  }
  // The caller may have created `backup` already.
  await mkdir(backup, { recursive: true });
  await moveChildren(target, backup, "", layout);
}

/**
 * Move the contents of `source` into `target`. Without mounts this is one
 * rename, and `target` must not exist. With mounts, `target` holds only its
 * pinned folders and its mount points, and each other entry moves in.
 */
export async function attachTree(
  source: string,
  target: string,
  layout: MountLayout,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await rename(source, target);
    return;
  }
  await moveChildren(source, target, "", layout);
}

/** Copy `source` into `target` the way `attachTree` moves it. */
export async function copyTree(
  source: string,
  target: string,
  layout: MountLayout,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await cp(source, target, { recursive: true, preserveTimestamps: true });
    return;
  }
  await copyChildren(source, target, "", layout);
}

/**
 * Remove `target`. With mounts, the pinned folders and the mount points stay,
 * and nothing on a mount point is deleted.
 */
export async function clearTree(
  target: string,
  layout: MountLayout,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await rmTreeWithRetries(target);
    return;
  }
  await clearChildren(target, "", layout);
}

/**
 * Delete an installed item folder, but keep each mount point in it and the
 * folders above one. Returns the kept mount points as `/` paths below
 * `root`. A delete through a mount point would empty the volume and then
 * fail with EBUSY, so `rm`, `init`, and adopt delete with this.
 */
export async function removeInstalledTree(root: string): Promise<string[]> {
  const layout = await readMountLayout(root);
  await clearTree(root, layout);
  return [...layout.mounts].sort();
}

/**
 * True when `root` holds mount points and nothing else: only the folders above
 * them. This is what `rm` leaves behind for an item with a mounted volume, so
 * `add` treats it as an empty target, not as an unmanaged one.
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
 * Remove a scratch folder, but refuse when a mount point is inside it. A
 * recursive delete would empty the mounted volume first and then fail on the
 * mount point, so this check runs before any delete.
 */
export async function removeScratchTree(path: string): Promise<void> {
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
  await rmTreeWithRetries(path);
}

async function moveChildren(
  from: string,
  to: string,
  relDir: string,
  layout: MountLayout,
): Promise<void> {
  for (const name of await readdir(absolute(from, relDir))) {
    const path = childPath(relDir, name);
    if (layout.mounts.has(path)) continue;
    if (layout.pinned.has(path)) {
      await mkdir(absolute(to, path), { recursive: true });
      await moveChildren(from, to, path, layout);
      continue;
    }
    await rename(absolute(from, path), absolute(to, path));
  }
}

async function copyChildren(
  from: string,
  to: string,
  relDir: string,
  layout: MountLayout,
): Promise<void> {
  for (const name of await readdir(absolute(from, relDir))) {
    const path = childPath(relDir, name);
    if (layout.mounts.has(path)) continue;
    if (layout.pinned.has(path)) {
      await mkdir(absolute(to, path), { recursive: true });
      await copyChildren(from, to, path, layout);
      continue;
    }
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
      await clearChildren(target, path, layout);
      continue;
    }
    await rmTreeWithRetries(absolute(target, path));
  }
}

interface MountPointsAt {
  root: boolean;
  below: string[];
}

/**
 * Linux lists every mount of this process in /proc/self/mountinfo. That also
 * finds a bind mount from the same filesystem, which keeps its device number.
 * Other systems have no such file, so the fallback compares device numbers.
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
