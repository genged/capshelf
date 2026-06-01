import type { Manifest } from "./manifest";
import { normalizeRemoteUrl, originRemoteUrl } from "./git";
import {
  LOCK_FILE,
  LOCAL_CONFIG_FILE,
  MANIFEST_FILE,
  METADATA_DIR,
} from "./identity";

export class UpstreamVerificationError extends Error {
  readonly exitCode = 4;
}

export function normalizedManifestUpstream(manifest: Manifest): string | null {
  if (!manifest.dataRepoUpstream) return null;
  const normalized = normalizeRemoteUrl(manifest.dataRepoUpstream);
  if (!normalized) {
    throw new Error(
      `invalid dataRepoUpstream in ${METADATA_DIR}/${MANIFEST_FILE}: ${manifest.dataRepoUpstream}`,
    );
  }
  return normalized;
}

export async function verifyDataRepoUpstream(
  dataRepo: string,
  manifest: Manifest,
): Promise<void> {
  const upstream = normalizedManifestUpstream(manifest);
  if (!upstream) return;

  const origin = await originRemoteUrl(dataRepo);
  if (origin === null) {
    throw new UpstreamVerificationError(
      `data repo at ${dataRepo} has no \`origin\` remote configured.\n` +
        `  ${METADATA_DIR}/${MANIFEST_FILE} declares dataRepoUpstream: ${upstream}\n` +
        "  add the remote and retry:\n" +
        `    git -C ${dataRepo} remote add origin ${upstream}`,
    );
  }

  const normalizedOrigin = normalizeRemoteUrl(origin);
  if (normalizedOrigin !== upstream) {
    throw new UpstreamVerificationError(
      `data repo at ${dataRepo} is bound to the wrong upstream.\n\n` +
        `  ${METADATA_DIR}/${MANIFEST_FILE} declares: ${upstream}\n` +
        `  local clone origin:     ${normalizedOrigin ?? origin.trim()}\n\n` +
        "  fix by one of:\n" +
        "    - point capshelf at a clone of the declared upstream:\n" +
        "        capshelf set-data <path-to-correct-clone>\n" +
        `    - change the project's declared upstream (commits to ${METADATA_DIR}/${MANIFEST_FILE}):\n` +
        "        capshelf set-upstream <new-url>",
    );
  }
}

export function missingSourceCommitMessage(
  dataRepo: string,
  commit: string,
  manifest: Manifest,
): string {
  const upstream = normalizedManifestUpstream(manifest);
  return (
    `data repo at ${dataRepo} does not contain commit ${commit} recorded in ${METADATA_DIR}/${LOCK_FILE}\n` +
    "  this can happen if:\n" +
    `    - ${METADATA_DIR}/${LOCAL_CONFIG_FILE} points at the wrong clone\n` +
    "    - the local clone needs `git fetch`\n" +
    "    - the data repo history was rewritten" +
    (upstream ? `\n  current dataRepoUpstream: ${upstream}` : "")
  );
}
