/**
 * Refuse remote rows before data-repo resolution so projects without a
 * data-repo binding get the remote-item refusal instead of a binding error.
 */
import type { ItemRef } from "./item-ref";
import { remoteVerbRefusal } from "./remote-item";
import {
  loadRemotesLock,
  parseRemoteKey,
  remoteKeysForRef,
} from "./remotes-lock";

export async function assertNotPulledSkill(
  project: string,
  ref: ItemRef,
  verb: string,
): Promise<void> {
  const remotes = await loadRemotesLock(project);
  const keys = remoteKeysForRef(remotes, ref);
  const first = keys[0];
  if (first === undefined) return;
  throw remoteVerbRefusal(verb, parseRemoteKey(first).kind, ref.name);
}
