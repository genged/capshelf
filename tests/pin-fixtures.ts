import {
  currentSourceCommit,
  itemTreeEntriesAtCommit,
  sourcePinDigest,
} from "../src/pin";
import { gitTreeSource } from "../src/item-source";
import type { ItemKind } from "../src/master";
import { installedTreeIdentity } from "../src/install-identity";

/**
 * Computed from the committed tree, never the working copy, so a formula change
 * fails one assertion instead of many hardcoded digests.
 */
export async function pinDigestAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<string> {
  return sourcePinDigest(
    await itemTreeEntriesAtCommit(
      gitTreeSource({ repo: dataRepo, kind, name, commit }),
      kind,
    ),
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

export async function installedPinDigestFor(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit?: string,
): Promise<string | null> {
  return await installedTreeIdentity(
    project,
    gitTreeSource({
      repo: dataRepo,
      kind,
      name,
      commit: commit ?? (await currentSourceCommit(dataRepo, kind, name)),
    }),
    kind,
    name,
  );
}

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
