/**
 * Fire control: the selection's Target action (a left-strip icon), and the
 * fleet Lock that replaces it while my ships are selected (`fleetLockApplies`,
 * `lockFocus`; the strip and the T key share them). Target locks the
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
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { useUIStore } from '../state/store.js';
import { getGameClient } from '../net/clientSingleton.js';
import type { SelectionFocusKind, UISelection } from '../state/storeTypes.js';

/** Focus kinds the fleet can be ordered to attack (the renderer's
 *  `isAttackable`: ships, parked hulls, drones, structures; never rocks or pods). */
const FLEET_ATTACKABLE: ReadonlySet<SelectionFocusKind> = new Set<SelectionFocusKind>(['ship', 'lingering', 'drone', 'structure']);

/**
 * Tap rule T2 (ONE Lock): my ships are selected and the focus is an
 * attackable thing that is not one of them. With ships selected the renderer
 * keeps only a not-mine focus beside them (`focusSurvives`), so "not one of
 * the selected ships" is "not mine". The renderer re-checks on the order.
 */
export function fleetLockApplies(sel: UISelection): boolean {
  return sel.ids.length > 0 && sel.focusId !== null && sel.focusKind !== null
    && FLEET_ATTACKABLE.has(sel.focusKind) && !sel.ids.includes(sel.focusId);
}

/**
 * The Lock action, shared by the strip and the T key: the fleet Lock (the
 * selected ships attack the focus, through the renderer's `attackFocus`, the
 * right-click order path) when {@link fleetLockApplies}, else `personal` (the
 * pilot's own lock with the active weapon group). True when something was asked.
 */
export function lockFocus(
  sel: UISelection,
  fleet: Pick<IFleetView, 'attackFocus'> | null,
  personal: () => boolean,
): boolean {
  if (!fleetLockApplies(sel)) return personal();
  if (fleet === null) return false;
  fleet.attackFocus();
  return true;
}

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
