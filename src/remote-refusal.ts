/**
 * The one gate the shelf-owning verbs share for a pulled skill.
 *
 * `promote`, `move`, `keep-local`, and `revert` each resolve a ref against the
 * capshelf locks, and a remote row is in neither by A3. Without this gate each
 * of them reports "not tracked in this project", which is true about the lock
 * it searched and useless to a user who can see the skill installed.
 *
 * It runs before any data-repo resolution. D7 allows a project that holds
 * remote rows and no data-repo binding, and in that project the resolution
 * exits 6 with a message about a shelf the user never bound.
 */
import type { ItemRef } from "./item-ref";
import { remoteVerbRefusal } from "./remote-item";
import { loadRemotesLock, remoteKeysForRef } from "./remotes-lock";

export async function assertNotPulledSkill(
  project: string,
  ref: ItemRef,
  verb: string,
): Promise<void> {
  const remotes = await loadRemotesLock(project);
  if (remoteKeysForRef(remotes, ref).length === 0) return;
  throw remoteVerbRefusal(verb, ref.name);
}
