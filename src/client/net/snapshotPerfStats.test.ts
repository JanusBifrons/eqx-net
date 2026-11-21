import { describe, it, expect, beforeEach, vi } from 'vitest';

const ringCalls = { n: 0 };
vi.mock('../debug/ClientLogger', () => ({
  getRingEntries: () => { ringCalls.n++; return []; },
}));

import type { SnapshotMessage } from '@shared-types/messages';
import { useUIStore } from '../state/store.js';
import { applySnapshotPerfStats, type SnapshotPerfStatsCtx } from './snapshotPerfStats.js';
import { createDropDetector } from './snapshotDropDetector.js';
import type { PredictionStats } from './predictionStats.js';

function makeCtx(): SnapshotPerfStatsCtx {
  return {
    stats: { snapshotCount: 0 } as unknown as PredictionStats,
    recentIntervals: [],
    collisionGuard: { lastSnapshotServerTick: 0 } as SnapshotPerfStatsCtx['collisionGuard'],
    dropDetector: createDropDetector(),
    swarmBinaryEwma: 50,
  };
}

/** Feed K snapshots on a 20 Hz wire (±1 ms jitter, so the raw EWMA never
 *  sits still) starting at `t0`. */
function feed(ctx: SnapshotPerfStatsCtx, k: number, t0: number): number {
  let last = t0;
  for (let i = 1; i <= k; i++) {
    const at = t0 + i * 50 + (i % 2 === 0 ? 1 : -1);
    applySnapshotPerfStats({ serverTick: i * 3 } as SnapshotMessage, at, last, at, ctx);
    last = at;
  }
  return last;
}

describe('applySnapshotPerfStats — steady play does no needless work', () => {
  beforeEach(() => {
    useUIStore.setState({ serverTickHz: 60 });
    ringCalls.n = 0;
  });

  it('a steady 60 Hz server notifies store subscribers zero times', () => {
    const ctx = makeCtx();
    const listener = vi.fn();
    const unsub = useUIStore.subscribe(listener);
    feed(ctx, 40, 1000);
    unsub();
    expect(listener).toHaveBeenCalledTimes(0);
    expect(useUIStore.getState().serverTickHz).toBe(60);
  });

  it('the HUD value still follows a real tick-rate change', () => {
    const ctx = makeCtx();
    let last = 1000;
    for (let i = 1; i <= 60; i++) {
      const at = last + 100; // 30 Hz server
      applySnapshotPerfStats({ serverTick: i * 3 } as SnapshotMessage, at, last, at, ctx);
      last = at;
    }
    expect(useUIStore.getState().serverTickHz).toBe(30);
  });

  it('scans the diag ring at most once per second, not per snapshot', () => {
    const ctx = makeCtx();
    feed(ctx, 19, 1000); // < 1 s of snapshots
    expect(ringCalls.n).toBe(1);
    feed(ctx, 20, 2000); // the next second
    expect(ringCalls.n).toBe(2);
  });
});
