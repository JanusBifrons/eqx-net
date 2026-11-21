/**
 * Build-mode status capsule (owner 2026-11-20: "why show health when you have
 * no ship?"): in Build the capsule hides the ship's shield / hull ring and
 * energy bar and shows the base's stored power + credits instead; flying shows
 * the ship again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import type { StructureRenderState } from '@core/contracts/IRenderer';

const structures = new Map<number, StructureRenderState>();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { structures, localPlayerId: 'me' },
    getPredictedEnergy: () => 0,
  }),
}));

import { StatusCapsule } from './GameHud.js';
import { sumOwnStoredPower } from './BuildStatus.js';
import { useUIStore } from '../state/store.js';

function row(p: Partial<StructureRenderState>): StructureRenderState {
  return { built: true, owner: 'me', ...p } as StructureRenderState;
}

describe('StatusCapsule build variant', () => {
  beforeEach(() => {
    cleanup();
    structures.clear();
    useUIStore.setState({ pilotMode: 'pilot', buildMode: false, placementKind: null, wallet: 1234 });
  });

  it('shows hull, shield and energy while flying', () => {
    render(<StatusCapsule scale={1} />);
    expect(screen.getByTestId('hud-status').getAttribute('data-mode')).toBe('fly');
    expect(screen.queryByTestId('hud-hull')).not.toBeNull();
    expect(screen.queryByTestId('hud-shield')).not.toBeNull();
    expect(screen.queryByTestId('hud-energy')).not.toBeNull();
    expect(screen.getByTestId('wallet-chip').getAttribute('data-wallet')).toBe('1234');
  });

  it('hides hull, shield and energy in Build and keeps the credits', () => {
    useUIStore.setState({ buildMode: true });
    render(<StatusCapsule scale={1} />);
    const cap = screen.getByTestId('hud-status');
    expect(cap.getAttribute('data-mode')).toBe('build');
    expect(screen.queryByTestId('hud-hull')).toBeNull();
    expect(screen.queryByTestId('hud-shield')).toBeNull();
    expect(screen.queryByTestId('hud-energy')).toBeNull();
    expect(screen.getByTestId('wallet-chip').getAttribute('data-wallet')).toBe('1234');
    // No battery built: no stored-power readout.
    expect(screen.queryByTestId('hud-base-power')).toBeNull();
  });

  it('shows the base stored power in Build when you own a battery', () => {
    structures.set(1, row({ storedPower: 30, storedPowerMax: 100 }));
    useUIStore.setState({ buildMode: true });
    render(<StatusCapsule scale={1} />);
    const p = screen.getByTestId('hud-base-power');
    expect(p.getAttribute('data-stored')).toBe('30');
    expect(p.getAttribute('data-max')).toBe('100');
  });

  it('switches back to the ship readout when leaving Build', () => {
    useUIStore.setState({ buildMode: true });
    render(<StatusCapsule scale={1} />);
    expect(screen.queryByTestId('hud-hull')).toBeNull();
    act(() => useUIStore.setState({ buildMode: false }));
    expect(screen.queryByTestId('hud-hull')).not.toBeNull();
  });
});

describe('sumOwnStoredPower', () => {
  it('sums only your own built storage', () => {
    const m = new Map<number, StructureRenderState>([
      [1, row({ storedPower: 30, storedPowerMax: 100 })],
      [2, row({ storedPower: 50, storedPowerMax: 200 })],
      [3, row({ owner: 'them', storedPower: 999, storedPowerMax: 999 })],
      [4, row({ built: false, storedPower: 10, storedPowerMax: 100 })],
      [5, row({})], // a solar panel: no storage
    ]);
    expect(sumOwnStoredPower(m, 'me')).toEqual({ stored: 80, max: 300 });
  });

  it('is empty with no player or no structures', () => {
    expect(sumOwnStoredPower(undefined, 'me')).toEqual({ stored: 0, max: 0 });
    expect(sumOwnStoredPower(new Map(), null)).toEqual({ stored: 0, max: 0 });
  });
});
