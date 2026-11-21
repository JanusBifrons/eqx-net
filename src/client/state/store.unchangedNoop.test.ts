import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';

/**
 * Perf lock — the per-snapshot scalar setters (`setShipCount`,
 * `setSwarmCount`, `setClockRate`, `setServerTickHz`) are fed at snapshot
 * rate. A Zustand `set` notifies EVERY subscriber even when the value is
 * unchanged, so an identical value must be a no-op (the client rule "a
 * poller feeding a widely-subscribed store field skips unchanged replies").
 */
const K = 20;

describe('store — per-snapshot scalar setters skip unchanged values', () => {
  beforeEach(() => {
    useUIStore.setState({ shipCount: 0, swarmCount: 0, clockRate: 1, serverTickHz: 60 });
  });

  it.each([
    ['setShipCount', 7],
    ['setSwarmCount', 12],
    ['setClockRate', 0.5],
    ['setServerTickHz', 58],
  ] as const)('%s notifies once for K identical writes', (name, value) => {
    let notifications = 0;
    const unsub = useUIStore.subscribe(() => { notifications++; });
    const setter = useUIStore.getState()[name] as (n: number) => void;
    for (let i = 0; i < K; i++) setter(value);
    unsub();
    expect(notifications).toBe(1);
  });

  it('a write equal to the current value notifies nobody', () => {
    let notifications = 0;
    const unsub = useUIStore.subscribe(() => { notifications++; });
    for (let i = 0; i < K; i++) {
      const s = useUIStore.getState();
      s.setShipCount(0); s.setSwarmCount(0); s.setClockRate(1); s.setServerTickHz(60);
    }
    unsub();
    expect(notifications).toBe(0);
  });
});
