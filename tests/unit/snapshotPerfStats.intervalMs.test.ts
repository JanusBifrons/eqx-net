/**
 * Phase 4 iteration 3 swift-otter (2026-05-30) — unit lock for
 * `applySnapshotPerfStats` computing `intervalMs` from WIRE arrival
 * time, NOT the RAF `now`.
 *
 * Background: the snapshot coalescer + deferred-syncMirror push
 * snapshot APPLY to RAF boundaries. Pre-fix, `applySnapshotPerfStats`
 * used `now - lastSnapshotAt` for the interval — apply-to-apply
 * cadence (RAF-bound, ~16-33 ms). Downstream RTT updater
 * (`rttLookaheadUpdater.ts`) rejects samples outside the 35-75 ms
 * steady-state band → Welford stale → leadTicks inflates →
 * `ticksAhead` netgate regression (74 vs baseline 30).
 *
 * Fix: take a separate `wireArrivalAtMs` arg, use it for the interval
 * computation, leave `now` for everything else (rolling RAF stats etc).
 * Wire-arrival cadence is ~50 ms at 20 Hz, inside the steady-state band.
 */

import { describe, expect, it } from 'vitest';
import { applySnapshotPerfStats } from '../../src/client/net/snapshotPerfStats.js';
import { createDropDetector } from '../../src/client/net/snapshotDropDetector.js';
import {
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  resetSwarmTickClock,
  DISPLAY_DELAY_MS,
} from '../../src/client/net/swarmInterpolation.js';
import type { SnapshotMessage } from '../../src/shared-types/messages.js';

function makeSnap(serverTick: number): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick,
    states: {},
    ackedTick: 0,
  } as SnapshotMessage;
}

function makeCtx(): Parameters<typeof applySnapshotPerfStats>[4] {
  return {
    stats: {
      snapshotCount: 0,
      snapshotIntervalMs: 0,
      lastServerTick: 0,
      snapshotJitterMs: 0,
      rafP50Ms: 0,
      rafP99Ms: 0,
      longtaskCount30s: 0,
      rafGapCount30s: 0,
      heapUsedMb: undefined,
    } as unknown as Parameters<typeof applySnapshotPerfStats>[4]['stats'],
    recentIntervals: [],
    collisionGuard: { lastSnapshotServerTick: 0 } as unknown as Parameters<typeof applySnapshotPerfStats>[4]['collisionGuard'],
    dropDetector: createDropDetector(),
    swarmBinaryEwma: 50,
  };
}

describe('applySnapshotPerfStats — intervalMs from wire-arrival time', () => {
  it('intervalMs uses wireArrivalAtMs not RAF now', () => {
    const ctx = makeCtx();
    // 1st apply at RAF=110, wire-recv=100.
    const i0 = applySnapshotPerfStats(makeSnap(1), 110, 0, 100, ctx);
    // First sample: lastSnapshotAt=0 → intervalMs=0 (no prior).
    expect(i0).toBe(0);
    // 2nd apply at RAF=170 (60 ms RAF gap), wire-recv=150 (50 ms WIRE gap).
    // Caller passes lastSnapshotAt = wireArrivalAtMs of last apply (=100).
    const i1 = applySnapshotPerfStats(makeSnap(2), 170, 100, 150, ctx);
    expect(i1, 'intervalMs reflects WIRE gap 150-100=50, not RAF gap 170-110=60').toBe(50);
  });

  it('coalesced burst: latest wire-recv defines the interval, even when RAF apply is delayed', () => {
    const ctx = makeCtx();
    // Steady-state ramp.
    applySnapshotPerfStats(makeSnap(1), 60, 0, 50, ctx);
    applySnapshotPerfStats(makeSnap(2), 110, 50, 100, ctx);
    // Burst recovery: 3 snaps arrived wire 200/210/220, coalescer keeps 220.
    // RAF applies the latest at RAF=240. Caller passes wireArrivalAtMs=220.
    const iBurst = applySnapshotPerfStats(makeSnap(5), 240, 100, 220, ctx);
    expect(iBurst, 'interval reflects 100→220 wire gap of 120 ms, NOT 240→110 RAF gap').toBe(120);
  });

  it('RAF jitter has no effect on intervalMs when wire timing is steady', () => {
    const ctx = makeCtx();
    // Snap A: wire=100, RAF=110 (10 ms delay).
    applySnapshotPerfStats(makeSnap(1), 110, 0, 100, ctx);
    // Snap B: wire=150, RAF=180 (30 ms delay — RAF jittered later).
    const i = applySnapshotPerfStats(makeSnap(2), 180, 100, 150, ctx);
    expect(i, 'wire gap is the source of truth despite RAF jitter').toBe(50);
  });
});

/** JSON snapshots go out every 3 server ticks. */
const JSON_EVERY_TICKS = 3;
/** Snapshots skipped in the drop test (one 12-tick hole = 3 drops). */
const SKIPPED_SNAPSHOTS = 3;
const WIRE_STEP_MS = 50;
/** A binary EWMA that the old feed (x 1.5) would have sized to 225 ms. */
const SLOW_SWARM_EWMA_MS = 150;

describe('applySnapshotPerfStats — drop detector, no display-delay feed (S3-3)', () => {
  it('still counts dropped JSON snapshots (droppedSnapshotsRecent source)', () => {
    const ctx = makeCtx();
    let wire = WIRE_STEP_MS;
    let tick = JSON_EVERY_TICKS;
    applySnapshotPerfStats(makeSnap(tick), wire, 0, wire, ctx);
    for (let i = 0; i < 2; i++) {
      tick += JSON_EVERY_TICKS;
      applySnapshotPerfStats(makeSnap(tick), wire + WIRE_STEP_MS, wire, wire + WIRE_STEP_MS, ctx);
      wire += WIRE_STEP_MS;
    }
    expect(ctx.dropDetector.dropCount).toBe(0);
    tick += JSON_EVERY_TICKS * (SKIPPED_SNAPSHOTS + 1);
    applySnapshotPerfStats(makeSnap(tick), wire + WIRE_STEP_MS, wire, wire + WIRE_STEP_MS, ctx);
    expect(ctx.dropDetector.dropCount).toBe(SKIPPED_SNAPSHOTS);
  });

  it('no longer moves the drone display delay (sized from packet lateness instead)', () => {
    resetSwarmTickClock();
    const ctx = { ...makeCtx(), swarmBinaryEwma: SLOW_SWARM_EWMA_MS };
    applySnapshotPerfStats(makeSnap(3), WIRE_STEP_MS, 0, WIRE_STEP_MS, ctx);
    applySnapshotPerfStats(makeSnap(30), 2 * WIRE_STEP_MS, WIRE_STEP_MS, 2 * WIRE_STEP_MS, ctx);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
  });
});
