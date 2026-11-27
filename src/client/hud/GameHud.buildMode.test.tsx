/**
 * Build mode (owner design 2026-11-20): in Build, the third control mode
 * (`buildMode`, with or without a ghost) the flight controls are gone (joystick,
 * BOOST, weapon strip, lock band; the speed bar is Command-only), so the ghost owns the
 * screen. Panels unrelated to flying are stubbed: this locks the gate only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../components/BuildSidebarHost', () => ({ BuildSidebarHost: () => <div data-testid="stub-build-sidebar" /> }));
vi.mock('./WeaponStrip', () => ({ WeaponStrip: () => <div data-testid="stub-weapon-strip" /> }));
vi.mock('./LockStatusBand', () => ({ LockStatusBand: () => <div data-testid="stub-lock-band" /> }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

import { GameHud } from './GameHud.js';
import { OrdersPanel } from '../panels/OrdersPanel.js';
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

const FLIGHT_IDS = ['hud-move-zone', 'hud-boost', 'stub-weapon-strip', 'stub-lock-band'];

function renderHud() {
  return render(
    <LayoutContext.Provider value={hosts() as never}>
      <GameHud touchInput={touchInput} />
      <OrdersPanel />
    </LayoutContext.Provider>,
  );
}

describe('GameHud in build mode', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    useUIStore.setState({ phase: 'galaxy-map', pilotMode: 'pilot', isDead: false, helmAvailable: true, placementKind: null, buildMode: false, rightPanel: null });
  });

  it('shows the flight controls while flying, and no speed bar (Fly is manual)', () => {
    useUIStore.setState({ selection: { ids: ['me'], focusId: null, focusKind: null } });
    renderHud();
    for (const id of FLIGHT_IDS) expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(document.querySelector('[data-testid="helm-speed"]')).toBeNull();
  });

  it('renders no flight control and no helm bar in Build mode', () => {
    useUIStore.getState().setPlacementKind('battery'); // a pick enters Build
    renderHud();
    for (const id of FLIGHT_IDS) expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    expect(document.querySelector('[data-testid="helm-speed"]')).toBeNull();
    // The status capsule stays, in its build variant (no ship health).
    expect(document.querySelector('[data-testid="hud-status"]')?.getAttribute('data-mode')).toBe('build');
  });
});
