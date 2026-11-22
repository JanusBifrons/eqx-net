/**
 * Desktop keys for the right rail and the left strip (UI language plan A5, U1-9).
 *
 * Alt + 1–8 open the rail items in order, top to bottom (owner 2026-11-22: Shift +
 * number stays the weapon group auto/manual switch, MouseLock.ts). The same pick
 * as tapping the item (`pickRailItem`).
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
import { pickRailItem } from '../layout/RightPanelHost';
import { railItemsFor } from '../layout/railItems';

type EscState = Pick<UIStore, 'placementKind' | 'fleetPick' | 'rightPanel' | 'contactsOpen' | 'selection'
  | 'drawerTab' | 'setRightPanel' | 'setDrawerTab' | 'setContactsOpen'>
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

/** Pure: the rail slot (0-based) an Alt + 1–8 press picks, else null. Uses the
 *  key's `code` (Alt changes `key` on some layouts). */
export function railKeyIndex(e: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'repeat' | 'target'>): number | null {
  if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return null;
  const t = e.target as HTMLElement | null;
  if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return null;
  const m = /^Digit([1-8])$/.exec(e.code);
  return m ? Number(m[1]) - 1 : null;
}

/** App.tsx keydown: Alt + 1–8 pick a rail item; Esc clears the strip through
 *  the renderer, which owns the selection. */
export function handleRailKeys(e: KeyboardEvent, s: EscState, clear: () => void): void {
  const i = railKeyIndex(e);
  if (i !== null) {
    const item = railItemsFor(selectControlMode(s))[i];
    if (item !== undefined) { pickRailItem(item.id, s); e.preventDefault(); }
    return;
  }
  if (escClearsStrip(e, s, buildMenuKeysOpen())) { clear(); e.preventDefault(); }
}
