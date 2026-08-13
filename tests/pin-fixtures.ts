import {
  currentSourceCommit,
  itemTreeEntriesAtCommit,
  sourcePinDigest,
} from "../src/pin";
import type { ItemKind } from "../src/master";
import { installedTreeIdentity } from "../src/install-identity";

/**
 * The `sourcePinDigest` a lock entry would record for an item, computed the
 * same way `add`/`update` compute it: from the committed tree, never from the
 * data repo's working copy. Fixtures use this instead of hardcoding a digest
 * so a change to the formula shows up as one failing assertion rather than
 * fifty stale constants.
 */
export async function pinDigestAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<string> {
  return sourcePinDigest(
    await itemTreeEntriesAtCommit(dataRepo, kind, name, commit),
  );
}

export async function currentPinDigest(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string> {
  return await pinDigestAtCommit(
    dataRepo,
    kind,
    name,
    await currentSourceCommit(dataRepo, kind, name),
  );
}

/**
 * The installed identity of an item, named the way the pin names it. A clean
 * install equals `pinDigestAtCommit` for the same commit.
 */
export async function installedPinDigestFor(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit?: string,
): Promise<string | null> {
  return await installedTreeIdentity(
    project,
    dataRepo,
    kind,
    name,
    commit ?? (await currentSourceCommit(dataRepo, kind, name)),
  );
}

/**
 * The `(sourcePinDigest, sourceCommit)` pair for an item's current source, as
 * a spreadable fixture fragment.
 */
export async function currentPin(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<{ sourcePinDigest: string; sourceCommit: string }> {
  const sourceCommit = await currentSourceCommit(dataRepo, kind, name);
  return {
    sourcePinDigest: await pinDigestAtCommit(
      dataRepo,
      kind,
      name,
      sourceCommit,
    ),
    sourceCommit,
  };
}
