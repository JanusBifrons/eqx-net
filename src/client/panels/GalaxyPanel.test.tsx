/**
 * UI plan U2-2a: Galaxy is its own right panel. "Open full map" toggles the
 * map Window and folds the panel; the Nearby / Far rows (the only in-system
 * warp list) warp to a pocket's
 * target and show the held-warp chip; the rows hide mid-transit, outside a
 * solar-system build and with no current sector; the Arrival section clamps
 * typed X/Y on blur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const solar = vi.hoisted(() => ({ on: true }));
vi.mock('../../shared-types/sectorBounds', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared-types/sectorBounds')>();
  return { ...real, get SOLAR_SECTORS() { return solar.on; } };
});

const requestWarp = vi.fn();
let warping = false;
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'p1', ships: new Map([['p1', { x: 0, y: 0 }]]) },
    requestWarp: (x: number, y: number) => { requestWarp(x, y); warping = true; },
    cancelWarp: () => { warping = false; },
    hasWarpRequest: () => warping,
  }),
}));

import { GalaxyPanel, warpRowNote } from './GalaxyPanel';
import { WarpStatusChip } from '../components/WarpPicker';
import { warpDestinations } from '../components/warpDestinations';
import { useUIStore } from '../state/store';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds';

beforeEach(() => {
  solar.on = true;
  requestWarp.mockClear(); warping = false;
  useUIStore.setState({
    rightPanel: 'galaxy', drawerTab: 'galaxy', currentSectorKey: 'sol-prime', transitState: 'DOCKED',
    isGalaxyMapOpen: false, warpHeldTo: null, arrivalMode: 'same',
  });
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy', isGalaxyMapOpen: false, warpHeldTo: null });
});

describe('GalaxyPanel (U2-2a)', () => {
  it('opens on the Galaxy rail flag and closes on ✕', () => {
    render(<GalaxyPanel />);
    expect(screen.getByTestId('galaxy-panel')).toBeVisible();
    fireEvent.click(screen.getByTestId('galaxy-panel-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('"Open full map" opens the map Window and folds the panel', () => {
    render(<GalaxyPanel />);
    fireEvent.click(screen.getByTestId('galaxy-open-map'));
    expect(useUIStore.getState().isGalaxyMapOpen).toBe(true);
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('with the map up, the row closes it (a toggle) and the panel stays', () => {
    useUIStore.setState({ isGalaxyMapOpen: true });
    render(<GalaxyPanel />);
    const row = screen.getByTestId('galaxy-open-map');
    expect(row.textContent).toContain('Close full map');
    fireEvent.click(row);
    expect(useUIStore.getState().isGalaxyMapOpen).toBe(false);
    expect(useUIStore.getState().rightPanel).toBe('galaxy');
  });

  it('a Nearby / Far row warps to the pocket, folds the panel and shows the cancellable chip', () => {
    render(<><GalaxyPanel /><WarpStatusChip /></>);
    const target = warpDestinations('sol-prime', 0, 0).find((d) => !d.here && d.reachable)!;
    const section = target.far ? 'galaxy-far' : 'galaxy-nearby';
    const row = within(screen.getByTestId(section)).getByTestId(`galaxy-warp-${target.id}`);
    expect(row.getAttribute('data-warp-state')).toBe(target.state); // e2e reads these
    expect(row.getAttribute('data-km')).toBe(String(Math.round(target.distKm)));
    fireEvent.click(row);
    expect(requestWarp).toHaveBeenCalledWith(target.targetX, target.targetY);
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(screen.getByTestId('warp-status').textContent).toContain(target.label);
  });

  it("the pocket you're in is a readout, not a button", () => {
    render(<GalaxyPanel />);
    const home = warpDestinations('sol-prime', 0, 0).find((d) => d.here)!;
    const row = screen.getByTestId(`galaxy-warp-${home.id}`);
    expect(row.tagName).not.toBe('BUTTON');
    expect(row.textContent).toContain('here');
  });

  it('a pocket with a transit pad says where it goes (instant)', () => {
    const pad = warpDestinations('sol-prime', 0, 0).find((d) => d.padTo !== null)!;
    expect(warpRowNote(pad)).toContain('instant');
  });

  it('mid-transit the map and warp rows are hidden', () => {
    useUIStore.setState({ transitState: 'SPOOLING' });
    render(<GalaxyPanel />);
    expect(screen.queryByTestId('galaxy-open-map')).toBeNull();
    expect(screen.queryByTestId('galaxy-nearby')).toBeNull();
    expect(screen.getByTestId('galaxy-sector-name').textContent).toContain('Transit in progress');
  });

  it('no warp rows outside a solar-system build or with no current sector', () => {
    solar.on = false;
    render(<GalaxyPanel />);
    expect(screen.queryByTestId('galaxy-nearby')).toBeNull();
    cleanup();
    solar.on = true;
    useUIStore.setState({ currentSectorKey: null });
    render(<GalaxyPanel />);
    expect(screen.queryByTestId('galaxy-nearby')).toBeNull();
  });

  it('Arrival: X/Y past the bound clamps on blur and shows the note', () => {
    render(<GalaxyPanel />);
    act(() => { fireEvent.click(screen.getByTestId('arrival-mode-xy')); });
    expect(useUIStore.getState().arrivalMode).toBe('xy');
    const x = within(screen.getByTestId('arrival-x-input')).getByRole('textbox');
    fireEvent.change(x, { target: { value: String(SECTOR_PLAYABLE_HALF_EXTENT * 5) } });
    fireEvent.blur(x);
    expect(useUIStore.getState().arrivalTargetX).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect((x as HTMLInputElement).value).toBe(String(SECTOR_PLAYABLE_HALF_EXTENT));
    expect(screen.getByTestId('arrival-clamp-note').textContent).toMatch(/clamped/i);
  });

  it('Arrival: the inputs are read-only outside X/Y mode', () => {
    render(<GalaxyPanel />);
    expect(within(screen.getByTestId('arrival-x-input')).getByRole('textbox')).toBeDisabled();
    expect(screen.getByTestId('arrival-mode-same').getAttribute('aria-pressed')).toBe('true');
  });
});
