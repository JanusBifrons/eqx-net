/**
 * U1-9: Alt + 1–8 open the rail items in order; Esc closes the fly-out, then
 * the panel, then clears the strip. One press does one thing.
 */
import { describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../state/store';
import { escClearsStrip, handleRailKeys, railKeyIndex } from './railKeys';

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
  it('handleRailKeys clears through the given callback and marks the key handled', () => {
    const clear = vi.fn();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handleRailKeys(e, base(), clear);
    expect(clear).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });
});

const alt = (code: string, over: Partial<KeyboardEvent> = {}) => ({ code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, target: null, ...over }) as KeyboardEvent;

describe('Alt + 1–8: the rail in order (Shift + number stays the weapon auto/manual switch)', () => {
  it('maps Alt + Digit1–8 to slots 0–7 and nothing else', () => {
    expect(railKeyIndex(alt('Digit1'))).toBe(0);
    expect(railKeyIndex(alt('Digit8'))).toBe(7);
    expect(railKeyIndex(alt('Digit9'))).toBeNull();
    expect(railKeyIndex(alt('Digit1', { altKey: false }))).toBeNull();
    expect(railKeyIndex(alt('Digit1', { shiftKey: true }))).toBeNull();
    expect(railKeyIndex(alt('Digit1', { repeat: true }))).toBeNull();
    expect(railKeyIndex(alt('Digit1', { target: document.createElement('textarea') }))).toBeNull();
  });
  it('opens the Nth rail item like a tap, and again closes it', () => {
    useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy', selection: { ...SHIP, ids: [] } });
    // Command mode rail: Fleet, Galaxy, Jobs, Trade, Faction, cog.
    const mode = { pilotMode: 'spectator' } as never;
    useUIStore.setState(mode);
    const press = (code: string) => { const e = new KeyboardEvent('keydown', { code, altKey: true, cancelable: true }); handleRailKeys(e, useUIStore.getState(), vi.fn()); return e; };
    const e = press('Digit4');
    expect(e.defaultPrevented).toBe(true);
    expect(useUIStore.getState().rightPanel).toBe('trade');
    press('Digit4');
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(press('Digit8').defaultPrevented).toBe(false); // no 8th item: the key is left alone
  });
});
