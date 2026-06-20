import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';

/**
 * Phase 4 WS-0 lock — `pilotMode` is a discrete, purity-clean enum flag
 * ('pilot' | 'spectator'). It carries NO spatial data (the free-roam camera
 * pose lives in the render mirror, never the store — Invariant #2). WS-0 lands
 * only the flag + setter with a `pilot` default; the death→spectate transition,
 * the free-roam camera/input, and the speed-dial toggle are WS-A1.
 */
describe('store — pilotMode (Phase 4 WS-0)', () => {
  beforeEach(() => {
    useUIStore.setState({ pilotMode: 'pilot' });
  });

  it('defaults to "pilot"', () => {
    expect(useUIStore.getState().pilotMode).toBe('pilot');
  });

  it('setPilotMode round-trips pilot↔spectator without touching isDead', () => {
    useUIStore.setState({ isDead: false });
    useUIStore.getState().setPilotMode('spectator');
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);
    useUIStore.getState().setPilotMode('pilot');
    expect(useUIStore.getState().pilotMode).toBe('pilot');
  });
});
