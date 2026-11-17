import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { LootWindow, PodOpen } from './LootWindow';
import { GRID_SLOTS } from './CargoPanel';
import { useUIStore } from '../state/store';
import type { CargoState } from '../../shared-types/messages/cargoMessages';

const pod = (over: Partial<CargoState> = {}): CargoState => ({
  type: 'cargo_state', entityId: 4, open: true,
  hold: { goods: { salvage: 9, alloy: 3 }, blueprints: [] }, used: 12, capacity: 0,
  ship: { goods: {}, blueprints: [] }, shipCapacity: 500, ...over,
});

describe('LootWindow (cargo pods)', () => {
  afterEach(() => {
    send.mockReset();
    act(() => useUIStore.getState().setCargoState(null));
  });

  it('is a dialog holding the cargo panel, titled with what is looted', () => {
    render(<LootWindow open title="Cargo pod" subtitle="Huge" entityId={4} onClose={() => {}} />);
    expect(screen.getByRole('dialog').textContent).toContain('Cargo pod');
    expect(screen.getByRole('dialog').textContent).toContain('Huge');
    expect(screen.getByTestId('cargo-panel')).toBeTruthy();
  });

  it('reserves its space: each grid always shows the same number of slots', () => {
    render(<LootWindow open title="Cargo pod" entityId={4} onClose={() => {}} />);
    act(() => useUIStore.getState().setCargoState(pod({ hidden: 1, revealInMs: 500 })));
    const slotsIn = (id: string): number => screen.getByTestId(id).children.length;
    expect(slotsIn('cargo-here-grid')).toBe(GRID_SLOTS);
    expect(slotsIn('cargo-aboard-grid')).toBe(GRID_SLOTS);
    act(() => useUIStore.getState().setCargoState(pod({ hold: { goods: { salvage: 9, alloy: 3, core: 1 }, blueprints: [] } })));
    expect(slotsIn('cargo-here-grid')).toBe(GRID_SLOTS);
  });

  it("a pod's Open button opens the window; Close shuts it", async () => {
    render(<PodOpen entityId={4} inReach subtitle="Huge" />);
    expect(screen.queryByTestId('loot-window')).toBeNull();
    fireEvent.click(screen.getByTestId('pod-open'));
    expect(screen.getByTestId('loot-window')).toBeTruthy();
    fireEvent.click(screen.getByTestId('loot-window-close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // after MUI's exit fade
  });
});
