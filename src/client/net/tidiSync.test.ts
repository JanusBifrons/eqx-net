import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Room } from 'colyseus.js';
import { useUIStore } from '../state/store.js';
import { syncTidiFromRoom } from './tidiSync.js';

/** Perf lock — K identical snapshots at a steady clock rate cause no store
 *  notifications (each one used to re-notify every subscriber). */
describe('syncTidiFromRoom — unchanged rate', () => {
  beforeEach(() => {
    useUIStore.setState({ clockRate: 1, sectorAlert: null });
  });

  it('K identical snapshots notify subscribers zero times', () => {
    const room = { state: { clockRate: 1 } } as unknown as Room;
    const listener = vi.fn();
    const unsub = useUIStore.subscribe(listener);
    for (let i = 0; i < 20; i++) syncTidiFromRoom(room, null);
    unsub();
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('a changed rate notifies once, then identical snapshots stay silent', () => {
    const room = { state: { clockRate: 0.5 } } as unknown as Room;
    const listener = vi.fn();
    const unsub = useUIStore.subscribe(listener);
    for (let i = 0; i < 20; i++) syncTidiFromRoom(room, null);
    unsub();
    // clockRate 1→0.5 plus the 'Temporal Anomaly' banner: two writes, once.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(useUIStore.getState().clockRate).toBe(0.5);
  });
});

/** Base-platforms room flag: the per-snapshot state read mirrors `state.deck`. */
describe('syncTidiFromRoom — deck room flag', () => {
  beforeEach(() => {
    useUIStore.setState({ clockRate: 1, sectorAlert: null, deck: false });
  });

  it('mirrors state.deck into the store, absent = false', () => {
    syncTidiFromRoom({ state: { clockRate: 1, deck: true } } as unknown as Room, null);
    expect(useUIStore.getState().deck).toBe(true);
    syncTidiFromRoom({ state: { clockRate: 1 } } as unknown as Room, null);
    expect(useUIStore.getState().deck).toBe(false);
  });

  it('mirrors state.freeBuilds (sandbox) the same way', () => {
    syncTidiFromRoom({ state: { clockRate: 1, freeBuilds: true } } as unknown as Room, null);
    expect(useUIStore.getState().freeBuilds).toBe(true);
    expect(useUIStore.getState().deck).toBe(false);
    syncTidiFromRoom({ state: { clockRate: 1 } } as unknown as Room, null);
    expect(useUIStore.getState().freeBuilds).toBe(false);
  });
});
