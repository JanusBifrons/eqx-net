/**
 * Build mode (owner design 2026-11-20): in Build, the third control mode
 * (`buildMode`, with or without a ghost) the flight controls are gone (joystick, lock
 * stick, BOOST, weapon strip, lock band, helm bar), so the ghost owns the
 * screen. Panels unrelated to flying are stubbed: this locks the gate only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../components/SpeedDialMenu', () => ({ SpeedDialMenu: () => null }));
vi.mock('../components/BottomControlPanel', () => ({ BottomControlPanel: () => null }));
vi.mock('../components/FleetPanel', () => ({ FleetPanel: () => null }));
vi.mock('../components/FleetStrip', () => ({ FleetStrip: () => null }));
vi.mock('../components/ContactsOverview', () => ({ ContactsOverview: () => <div data-testid="stub-contacts" /> }));
vi.mock('./WeaponStrip', () => ({ WeaponStrip: () => <div data-testid="stub-weapon-strip" /> }));
vi.mock('./LockStatusBand', () => ({ LockStatusBand: () => <div data-testid="stub-lock-band" /> }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

import { GameHud } from './GameHud.js';
import { HelmPanel } from '../components/HelmPanel.js';
import { LayoutContext } from '../layout/useLayout.js';
import { useUIStore } from '../state/store.js';
import type { TouchInput } from '../input/TouchInput';

/** Every anchor gets a host (lazily), so each Slot renders. */
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

const FLIGHT_IDS = ['hud-move-zone', 'hud-lock-zone', 'hud-boost', 'stub-weapon-strip', 'stub-lock-band', 'stub-contacts'];

function renderHud() {
  return render(
    <LayoutContext.Provider value={hosts() as never}>
      <GameHud touchInput={touchInput} />
      <HelmPanel />
    </LayoutContext.Provider>,
  );
}

describe('GameHud in build mode', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    useUIStore.setState({ phase: 'galaxy-map', pilotMode: 'pilot', isDead: false, helmAvailable: true, placementKind: null, buildMode: false });
  });

  it('shows the flight controls while flying; the helm bar is Command-only (control)', () => {
    renderHud();
    for (const id of FLIGHT_IDS) expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    // Fly is manual only (#1092): the helm bar shows in Command, not Fly.
    expect(document.querySelector('[data-testid="helm-panel"]')).toBeNull();
  });

  it('renders no flight control and no helm bar in Build mode', () => {
    useUIStore.getState().setPlacementKind('battery'); // a pick enters Build
    renderHud();
    for (const id of FLIGHT_IDS) expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    expect(document.querySelector('[data-testid="helm-panel"]')).toBeNull();
    // The status capsule stays, in its build variant (no ship health).
    expect(document.querySelector('[data-testid="hud-status"]')?.getAttribute('data-mode')).toBe('build');
  });
});
