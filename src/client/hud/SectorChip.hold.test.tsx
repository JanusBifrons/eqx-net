/**
 * Sector chip during a gate swap (teleporter redesign, take 18 review): the
 * new sector's name arrives while the picture still holds the old room, so the
 * own ship's pose is still the far side's. The chip must not pair the new
 * name with the old grid square ("VEGA REACH 340,0" for half a second); it
 * shows "—" until the hold lands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const ships = new Map<string, { x: number; y: number }>();
let holding = false;
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { ships, localPlayerId: 'me' }, holdingPicture: () => holding }),
}));

import { SectorChip } from './widgets.js';
import { useUIStore } from '../state/store.js';

const grid = (): string => screen.getByTestId('hud-sector').textContent ?? '';

describe('SectorChip across a gate swap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ships.clear();
    holding = false;
    useUIStore.setState({ sectorName: 'Sol Prime' });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the grid square normally, a dash while the picture holds, then the new square', () => {
    ships.set('me', { x: 170_000, y: 0 });
    render(<SectorChip />);
    expect(grid()).toContain('340,0');

    holding = true; // swap: new name, old held pose
    act(() => useUIStore.setState({ sectorName: 'Vega Reach' }));
    expect(grid()).not.toContain('340,0'); // not even until the next 250 ms tick
    act(() => { vi.advanceTimersByTime(250); });
    expect(grid()).toContain('Vega Reach');
    expect(grid()).not.toContain('340,0');
    expect(grid()).toContain('—');

    holding = false; // landed on the far side
    ships.set('me', { x: -170_000, y: 0 });
    act(() => { vi.advanceTimersByTime(250); });
    expect(grid()).toContain('-340,0');
  });
});
