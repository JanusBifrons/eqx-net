/**
 * Fire control: the selection's Target action (a left-strip icon). Locks the
 * selected ship / drone / structure / rock / pod with the ACTIVE weapon group,
 * so the pilot doesn't have to track it with the smart-aim drag. Null (hidden)
 * for something not lockable, the pilot's own, or with no active group.
 *
 * `state` (`data-state` on the button, read by e2e helpers):
 *  - `lock`: no lock yet, a tap asks for one (`lockSelected`);
 *  - `cancel`: a lock is building, a tap cancels it;
 *  - `blocked`: the server cannot progress it (untrackable, or past lock
 *    range), a tap cancels it;
 *  - `unlock`: locked, a tap drops it.
 */
import { useUIStore } from '../state/store.js';
import { getGameClient } from '../net/clientSingleton.js';

/** Another player's AI-flown ship is selected as a `'lingering'` entity and is
 *  lockable like any player's ship (your own fleet arrives with `isOwn`). A
 *  cargo pod locks for the tractor (moves it; never loads it). A rock locks
 *  for mining lasers / tractors, keyed `s:<swarmId>` exactly as the lock line
 *  keys terrain (non-hostile: terrain never gets a failsafe ring). */
const LOCKABLE = new Set(['ship', 'lingering', 'drone', 'structure', 'pod', 'asteroid']);

export type TargetLockState = 'lock' | 'cancel' | 'blocked' | 'unlock';

export interface TargetLock {
  state: TargetLockState;
  /** Names the action and the group ("Lock · Mining"). */
  tooltip: string;
  /** The active weapon group's id. */
  groupId: string;
  onClick: () => void;
}

/** The lock key for a selection id: `s:<swarmId>` for swarm entities, else `p:<id>`. */
export function lockKeyFor(selected: string): string {
  return selected.startsWith('swarm-') ? `s:${selected.slice(6)}` : `p:${selected}`;
}

export function useTargetLock(isOwn: boolean): TargetLock | null {
  const kind = useUIStore((s) => s.selection.focusKind);
  const selected = useUIStore((s) => s.selection.focusId);
  const groups = useUIStore((s) => s.fcGroups);
  const active = useUIStore((s) => s.activeGroupId);
  const client = getGameClient();
  if (!client || isOwn || selected === null || selected === client.mirror.localPlayerId) return null;
  if (kind === null || !LOCKABLE.has(kind)) return null;
  const group = groups.find((g) => g.id === active);
  if (group === undefined) return null;
  const key = lockKeyFor(selected);
  const lock = group.locks.find((l) => l.target === key);
  const state: TargetLockState =
    lock === undefined ? 'lock' : lock.stage === 2 ? 'unlock' : lock.blocked ? 'blocked' : 'cancel';
  const tooltip =
    state === 'lock' ? `Lock · ${group.name}` : state === 'cancel' ? 'Cancel lock' : state === 'blocked' ? "Can't track: cancel lock" : `Unlock · ${group.name}`;
  const onClick = (): void => {
    const c = getGameClient();
    if (!c) return;
    if (state === 'lock') c.lockSelected();
    else c.cancelLock(group.id, key);
  };
  return { state, tooltip, groupId: group.id, onClick };
}
