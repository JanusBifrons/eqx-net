/**
 * U1-9 Esc order: fly-out, then panel, then strip. One press does one thing.
 */
import { describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../state/store';
import { escClearsStrip, handleStripEscape } from './railKeys';

const SHIP = { ...useUIStore.getState().selection, ids: ['s1'] };
const base = () => ({ ...useUIStore.getState(), selection: SHIP, rightPanel: null, contactsOpen: false, placementKind: null, fleetPick: null });
const esc = (over: Partial<KeyboardEvent> = {}) => ({ key: 'Escape', defaultPrevented: false, target: null, ...over }) as KeyboardEvent;

describe('escClearsStrip', () => {
  it('clears the strip when nothing else is up', () => {
    expect(escClearsStrip(esc(), base(), false)).toBe(true);
  });
  it('an open panel closes first (the strip stays)', () => {
    expect(escClearsStrip(esc(), { ...base(), rightPanel: 'fleet' }, false)).toBe(false);
    expect(escClearsStrip(esc(), base(), true)).toBe(false); // Build sidebar open
  });
  it('a press someone else already handled (placement, fleet pick) does nothing more', () => {
    expect(escClearsStrip(esc({ defaultPrevented: true }), base(), false)).toBe(false);
    expect(escClearsStrip(esc(), { ...base(), placementKind: 'connector' as never }, false)).toBe(false);
  });
  it('nothing selected, another key, or typing in a field: no-op', () => {
    expect(escClearsStrip(esc(), { ...base(), selection: useUIStore.getState().selection }, false)).toBe(false);
    expect(escClearsStrip(esc({ key: 'a' }), base(), false)).toBe(false);
    const input = document.createElement('input');
    expect(escClearsStrip(esc({ target: input }), base(), false)).toBe(false);
  });
  it('handleStripEscape clears through the given callback and marks the key handled', () => {
    const clear = vi.fn();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handleStripEscape(e, base(), clear);
    expect(clear).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });
});
