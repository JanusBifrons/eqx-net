/**
 * A right panel docks over the right edge as glass: the right-thumb Fly
 * controls behind it (lock stick, BOOST) must not show through or take
 * touches while any right panel is open (the `rightPanel` flag, or the
 * building-settings panel), and come back when it closes. The left move stick
 * stays (the panel never covers it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';

vi.mock('../components/BuildSidebarHost', () => ({ BuildSidebarHost: () => null }));
vi.mock('../components/FleetPanel', () => ({ FleetPanel: () => null }));
vi.mock('../components/FleetStrip', () => ({ FleetStrip: () => null }));
vi.mock('./WeaponStrip', () => ({ WeaponStrip: () => <div data-testid="stub-weapon-strip" /> }));
vi.mock('./LockStatusBand', () => ({ LockStatusBand: () => null }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

import { GameHud } from './GameHud.js';
import { LayoutContext } from '../layout/useLayout.js';
import { useUIStore } from '../state/store.js';
import type { TouchInput } from '../input/TouchInput';

function hosts(): Record<string, HTMLElement> {
  const made: Record<string, HTMLElement> = {};
  return new Proxy(made, {
    get(t, k: string) {
      if (!(k in t)) { t[k] = document.createElement('div'); document.body.appendChild(t[k]!); }
      return t[k];
    },
  });
}

const touchInput = {
  setJoystick: vi.fn(), setJoystickIdle: vi.fn(), setBoostHeld: vi.fn(),
} as unknown as TouchInput;

const RIGHT_THUMB_IDS = ['hud-lock-zone', 'hud-lock-home', 'hud-boost'];
const shown = (id: string): boolean => document.querySelector(`[data-testid="${id}"]`) !== null;

describe('GameHud right-thumb controls under a right panel', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    useUIStore.setState({
      phase: 'galaxy-map', pilotMode: 'pilot', isDead: false, placementKind: null, buildMode: false,
      rightPanel: null,
    });
  });

  it('hides the lock stick and BOOST while a rail panel is open, and restores them on close', () => {
    render(
      <LayoutContext.Provider value={hosts() as never}>
        <GameHud touchInput={touchInput} />
      </LayoutContext.Provider>,
    );
    for (const id of RIGHT_THUMB_IDS) expect(shown(id), id).toBe(true);

    act(() => useUIStore.getState().setRightPanel('contacts'));
    for (const id of RIGHT_THUMB_IDS) expect(shown(id), id).toBe(false);
    expect(shown('hud-move-zone')).toBe(true);

    act(() => useUIStore.getState().setRightPanel(null));
    for (const id of RIGHT_THUMB_IDS) expect(shown(id), id).toBe(true);
  });

  it('the Details panel (where building settings live) hides them too', () => {
    useUIStore.setState({ rightPanel: 'details' });
    render(
      <LayoutContext.Provider value={hosts() as never}>
        <GameHud touchInput={touchInput} />
      </LayoutContext.Provider>,
    );
    for (const id of RIGHT_THUMB_IDS) expect(shown(id), id).toBe(false);
  });
});
