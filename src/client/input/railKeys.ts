/**
 * Desktop keys for the right rail and the left strip (UI language plan A5, U1-9).
 *
 * Esc order: close the fly-out, then the panel, then clear the strip; one press
 * does one thing.
 *   - A status fly-out (EqxStatusFlyout) stops Esc itself at the window capture
 *     phase, so nothing below sees that press.
 *   - Placement and a fleet map pick cancel first (App.tsx marks the key
 *     handled), and an open panel closes itself (EqxPanel `closeOnEscape`).
 *   - Only when none of those is up does Esc clear the selection (`escClearsStrip`).
 */
import { selectControlMode } from '../state/store';
import type { UIStore } from '../state/storeTypes';
import { stripIdentity } from '../layout/LeftStripHost';
import { buildMenuKeysOpen } from './buildMenuKeys';

type EscState = Pick<UIStore, 'placementKind' | 'fleetPick' | 'rightPanel' | 'contactsOpen' | 'selection'>
  & Parameters<typeof selectControlMode>[0];

/** Pure: does this Esc press clear the strip (deselect)? `buildOpen` is the
 *  Build sidebar's open flag (`buildMenuKeysOpen`). */
export function escClearsStrip(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'target'>, s: EscState, buildOpen: boolean): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const t = e.target as HTMLElement | null;
  if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
  if (s.placementKind !== null || s.fleetPick !== null || s.rightPanel !== null || buildOpen) return false;
  if (s.contactsOpen && selectControlMode(s) === 'fly') return false;
  return stripIdentity(s.selection) !== null;
}

/** App.tsx keydown: Esc clears the strip through the renderer, which owns the selection. */
export function handleStripEscape(e: KeyboardEvent, s: EscState, clear: () => void): void {
  if (escClearsStrip(e, s, buildMenuKeysOpen())) { clear(); e.preventDefault(); }
}
