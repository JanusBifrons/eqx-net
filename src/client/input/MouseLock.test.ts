import { describe, it, expect, vi, afterEach } from 'vitest';

const lockSelected = vi.fn(() => true);
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ lockSelected, cancelLock: vi.fn(), setGroupMode: vi.fn() }),
}));

import { fcKeyAction, installFcKeys, mouseLockTakesPress } from './MouseLock';
import { useUIStore } from '../state/store';

describe('fcKeyAction', () => {
  it('digits select a group, shift+digit toggles its mode', () => {
    expect(fcKeyAction('1', 'Digit1', false)).toEqual({ kind: 'select', index: 0 });
    expect(fcKeyAction('!', 'Digit1', true)).toEqual({ kind: 'mode', index: 0 });
    expect(fcKeyAction('9', 'Digit9', false)).toEqual({ kind: 'select', index: 8 });
  });
  it('T locks the selection, X clears', () => {
    expect(fcKeyAction('t', 'KeyT', false)).toEqual({ kind: 'target' });
    expect(fcKeyAction('X', 'KeyX', true)).toEqual({ kind: 'clear' });
  });
  it('O toggles the contacts overview', () => {
    expect(fcKeyAction('o', 'KeyO', false)).toEqual({ kind: 'overview' });
    expect(fcKeyAction('O', 'KeyO', true)).toEqual({ kind: 'overview' });
  });
  it('stands down while the Build sidebar is open (its 1–9 pick tiles, not weapon groups)', () => {
    expect(fcKeyAction('1', 'Digit1', false, true)).toBeNull();
    expect(fcKeyAction('!', 'Digit1', true, true)).toBeNull();
    expect(fcKeyAction('t', 'KeyT', false, true)).toBeNull();
    expect(fcKeyAction('1', 'Digit1', false, false)).toEqual({ kind: 'select', index: 0 });
  });
  it('ignores other keys (0, WASD, space)', () => {
    expect(fcKeyAction('0', 'Digit0', false)).toBeNull();
    expect(fcKeyAction('w', 'KeyW', false)).toBeNull();
    expect(fcKeyAction(' ', 'Space', false)).toBeNull();
  });
});

describe('mouseLockTakesPress', () => {
  it('takes the press when not placing a structure', () => {
    expect(mouseLockTakesPress(null)).toBe(true);
  });
  it('leaves the press to structure placement while a kind is being placed', () => {
    // Placement owns left (place / drag the ghost) and right (cancel); the lock
    // line must not also start, nor right-click boost.
    expect(mouseLockTakesPress('capital')).toBe(false);
    expect(mouseLockTakesPress('turret')).toBe(false);
  });
});

/**
 * Tap rule T2 (UI plan D10): the T key mirrors the strip's ONE Lock. With my
 * ships selected and an attackable focus that is not mine, T orders the ships
 * to attack it (the renderer's `attackFocus`); otherwise it is today's
 * personal lock (`lockSelected`).
 */
describe('installFcKeys: T', () => {
  type KeyFn = (e: { key: string; code: string; shiftKey: boolean; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: null; preventDefault: () => void }) => void;
  let onKey: KeyFn | null = null;
  afterEach(() => { vi.unstubAllGlobals(); lockSelected.mockClear(); onKey = null; });

  function pressT(fleet: { attackFocus: () => void } | null): void {
    vi.stubGlobal('window', {
      addEventListener: (_t: string, fn: KeyFn) => { onKey = fn; },
      removeEventListener: () => {},
    });
    const dispose = installFcKeys(() => fleet);
    onKey!({ key: 't', code: 'KeyT', shiftKey: false, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault: () => {} });
    dispose();
  }

  it('ships selected + an enemy focused: the fleet Lock (attack), not the personal lock', () => {
    useUIStore.setState({ rightPanel: null, selection: { ids: ['a'], focusId: 'swarm-7', focusKind: 'structure' } });
    const attackFocus = vi.fn();
    pressT({ attackFocus });
    expect(attackFocus).toHaveBeenCalledOnce();
    expect(lockSelected).not.toHaveBeenCalled();
  });

  it('no ships selected, or a rock: the personal lock', () => {
    const attackFocus = vi.fn();
    useUIStore.setState({ rightPanel: null, selection: { ids: [], focusId: 'p2', focusKind: 'ship' } });
    pressT({ attackFocus });
    useUIStore.setState({ selection: { ids: ['a'], focusId: 'swarm-4', focusKind: 'asteroid' } });
    pressT({ attackFocus });
    expect(lockSelected).toHaveBeenCalledTimes(2);
    expect(attackFocus).not.toHaveBeenCalled();
  });
});
