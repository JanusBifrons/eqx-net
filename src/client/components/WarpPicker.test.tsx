/**
 * In-sector warp helpers: the held-warp chip shows where the warp goes and
 * its Cancel stops it. The destination list itself is the Galaxy panel's
 * (`panels/GalaxyPanel.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const cancelWarp = vi.fn();
let warping = false;
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'p1', ships: new Map([['p1', { x: 0, y: 0 }]]) },
    cancelWarp: () => { cancelWarp(); warping = false; },
    hasWarpRequest: () => warping,
  }),
}));

import { WarpStatusChip, destinationsFrom } from './WarpPicker';
import { useUIStore } from '../state/store';
import { warpDestinations } from './warpDestinations';

beforeEach(() => {
  cancelWarp.mockClear(); warping = false;
  useUIStore.setState({ warpHeldTo: null });
});
afterEach(() => { useUIStore.setState({ warpHeldTo: null }); });

describe('WarpStatusChip', () => {
  it('shows nothing with no held warp', () => {
    render(<WarpStatusChip />);
    expect(screen.queryByTestId('warp-status')).toBeNull();
  });

  it('shows the held warp and Cancel stops it', () => {
    useUIStore.setState({ warpHeldTo: 'Belt A' });
    warping = true;
    render(<WarpStatusChip />);
    expect(screen.getByTestId('warp-status').textContent).toContain('Belt A');
    fireEvent.click(screen.getByTestId('warp-cancel'));
    expect(cancelWarp).toHaveBeenCalled();
    expect(useUIStore.getState().warpHeldTo).toBeNull();
  });
});

describe('destinationsFrom', () => {
  it('with nothing in the way, matches the plain destination list', () => {
    const out = destinationsFrom('sol-prime', { x: 0, y: 0, angle: 0 }, []);
    const plain = warpDestinations('sol-prime', 0, 0);
    expect(out.map((d) => [d.id, d.targetX, d.targetY])).toEqual(plain.map((d) => [d.id, d.targetX, d.targetY]));
  });
});
