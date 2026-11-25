/**
 * Who hears that a Window opened, and whether one is open now (moved from
 * `client/components/GameWindow.tsx` with EqxWindow; the old path re-exports it).
 *
 * - `onGameWindowOpen`: run a callback each time a Window opens. The Build
 *   sidebar closes itself on it, so it never
 *   pokes out from under a window.
 * - `useAnyWindowOpen`: true while at least one EqxWindow is open. App.tsx's
 *   `uiCoversGame` check reads it, as it reads the open drawer panel.
 */
import { useSyncExternalStore } from 'react';

const openListeners = new Set<() => void>();
/** Run `fn` each time a game window opens; returns the unsubscribe. */
export function onGameWindowOpen(fn: () => void): () => void {
  openListeners.add(fn);
  return () => { openListeners.delete(fn); };
}
/** Tell the {@link onGameWindowOpen} listeners a game window opened (EqxWindow). */
export function notifyGameWindowOpen(): void {
  for (const fn of openListeners) fn();
}

let openCount = 0;
const countListeners = new Set<() => void>();
function subscribeCount(fn: () => void): () => void {
  countListeners.add(fn);
  return () => { countListeners.delete(fn); };
}
/** EqxWindow only: one more (+1) or one fewer (-1) Window is open. */
export function markWindowOpen(delta: 1 | -1): void {
  openCount = Math.max(0, openCount + delta);
  for (const fn of countListeners) fn();
}
/** Is any EqxWindow open right now? */
export function isAnyWindowOpen(): boolean {
  return openCount > 0;
}
/** React: true while any EqxWindow is open. */
export function useAnyWindowOpen(): boolean {
  return useSyncExternalStore(subscribeCount, isAnyWindowOpen, isAnyWindowOpen);
}
