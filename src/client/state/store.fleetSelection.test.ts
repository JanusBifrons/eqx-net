import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';

/**
 * RTS command view (slice 13a): the store mirrors the renderer's fleet
 * selection as ids only (no spatial data, invariant #2).
 */
describe('store — fleetSelection', () => {
  beforeEach(() => {
    useUIStore.setState({ fleetSelection: [] });
  });

  it('defaults to empty', () => {
    expect(useUIStore.getState().fleetSelection).toEqual([]);
  });

  it('setFleetSelection stores a copy of the ids', () => {
    const ids = ['me', 'hull-1'];
    useUIStore.getState().setFleetSelection(ids);
    const stored = useUIStore.getState().fleetSelection;
    expect(stored).toEqual(['me', 'hull-1']);
    expect(stored).not.toBe(ids);
    useUIStore.getState().setFleetSelection([]);
    expect(useUIStore.getState().fleetSelection).toEqual([]);
  });
});
