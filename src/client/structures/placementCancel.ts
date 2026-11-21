import { useUIStore } from '../state/store';

/**
 * Cancel the structure being placed (the ghost goes, Build stays). Every
 * player Cancel (the touch banner's Cancel, Escape, a mouse right-click) goes
 * through here, so a listener can tell a Cancel from a Confirm (both clear
 * `placementKind`). The Build sidebar treats both alike today: it comes back
 * for the next structure (SpeedDialMenu.tsx).
 * No-op when nothing is being placed.
 */
const cancelListeners = new Set<() => void>();

export function cancelPlacement(): void {
  const ui = useUIStore.getState();
  if (ui.placementKind === null) return;
  for (const fn of cancelListeners) fn();
  ui.setPlacementKind(null);
}

/** Run `fn` on every placement Cancel (before `placementKind` clears).
 *  Returns the unsubscribe. */
export function onPlacementCancel(fn: () => void): () => void {
  cancelListeners.add(fn);
  return () => { cancelListeners.delete(fn); };
}
