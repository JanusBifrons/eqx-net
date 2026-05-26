/**
 * @vitest-environment jsdom
 *
 * Probe 6 (mobile-perf-investigation, 2026-05-24) — snapshot coalescing
 * on receive. Lock the burst-collapse behaviour that breaks the
 * GC-driven RTT spiral.
 *
 * Evidence (capture `2kn41x`, galaxy sector, no firing, 67 s session):
 * heap climbed 41 → 81 MB then dropped 35 MB in a major GC pause. The
 * pause queued ~10 snapshots in the WebSocket event queue. When the
 * main thread freed, all 10 fired `onMessage` in burst, each measuring
 * `RTT = now - inputSentAt` with `now` being post-burst, inflating
 * Welford RTT by ~500 ms × 10 samples → ticksAhead grew → reconcile
 * cost grew → spiral.
 *
 * Coalescing breaks this: only the NEWEST queued snapshot is processed
 * per RAF; intermediates are discarded. Snapshots are full-state, so
 * the newest fully supersedes the older ones. Damage events fire on a
 * separate `onMessage('damage', ...)` channel and are unaffected.
 *
 * Lock cases:
 *   - Default coalesce=ON: 1 snapshot queues, processPendingSnapshot
 *     applies it, no `snapshot_coalesced` event (nothing dropped).
 *   - Default coalesce=ON: 5 snapshots queue, processPendingSnapshot
 *     applies ONLY THE NEWEST, fires `snapshot_coalesced` with
 *     dropped=4 + newestServerTick.
 *   - `?coalesce=0`: snapshots process immediately in onMessage
 *     (legacy path), processPendingSnapshot is a no-op.
 *   - tickPhysics calls processPendingSnapshot at top.
 *   - newestServerTick reflects the LAST queued snapshot, not the first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient';
import { SnapshotCoalescer } from './SnapshotCoalescer';
import { getRingEntries, __resetDiagCache } from '../debug/ClientLogger';
import type { SnapshotMessage } from '@shared-types/messages';

/**
 * Reach for the coalescer instance the client constructs in its
 * constructor. The coalescer state was previously inline on the client
 * (the `_pendingSnapshot` / `_coalescedSinceLastProcess` private fields
 * the original tests poked). Post-extraction the state lives in
 * `SnapshotCoalescer`; this accessor mirrors the old field-poking
 * pattern so the regression-lock cases keep their identity.
 */
function getCoalescer(c: ColyseusGameClient): SnapshotCoalescer {
  return (c as unknown as { snapshotCoalescer: SnapshotCoalescer }).snapshotCoalescer;
}

function setSearch(query: string): void {
  window.history.replaceState({}, '', `/?${query}`);
}

function makeSnapshot(serverTick: number): SnapshotMessage {
  return {
    serverTick,
    states: {},
    projectiles: [],
    wrecks: [],
  } as unknown as SnapshotMessage;
}

function getCoalescedEvents(): Array<{ dropped: number; newestServerTick: number }> {
  return getRingEntries()
    .filter((e) => e.tag === 'snapshot_coalesced')
    .map((e) => e.data as { dropped: number; newestServerTick: number });
}

function getAppliedEvents(): Array<{ serverTick: number }> {
  return getRingEntries()
    .filter((e) => e.tag === 'snapshot_applied')
    .map((e) => e.data as { serverTick: number });
}

beforeEach(() => {
  __resetDiagCache();
  getRingEntries().length = 0;
});

afterEach(() => {
  setSearch('');
  __resetDiagCache();
});

describe('Probe 6 — snapshot coalescing constructor + URL flag', () => {
  it('default: coalesce ENABLED (no URL flag)', () => {
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    expect(getCoalescer(c).isEnabled()).toBe(true);
    // Trigger pending queue manually (bypassing onMessage which needs a real room).
    getCoalescer(c).enqueue(makeSnapshot(100));
    c.processPendingSnapshot();
    // Drain processed the snapshot — second drain is a no-op (apply count stable).
    const before = getAppliedEvents().length;
    c.processPendingSnapshot();
    expect(getAppliedEvents().length).toBe(before);
  });

  it('?coalesce=0: coalesce DISABLED — processPendingSnapshot is a no-op', () => {
    setSearch('coalesce=0');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    expect(getCoalescer(c).isEnabled()).toBe(false);
    // enqueue() on a disabled coalescer is also a no-op (legacy path
    // would have invoked applySnapshotNow directly from onMessage).
    getCoalescer(c).enqueue(makeSnapshot(100));
    c.processPendingSnapshot();
    expect(getAppliedEvents().length).toBe(0);
  });

  it('?coalesce=1 (or any non-"0") explicit: ENABLED', () => {
    setSearch('coalesce=1');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    expect(getCoalescer(c).isEnabled()).toBe(true);
    getCoalescer(c).enqueue(makeSnapshot(100));
    c.processPendingSnapshot();
    expect(getAppliedEvents().length).toBe(1);
  });
});

describe('Probe 6 — snapshot_coalesced event', () => {
  it('one pending snapshot → no coalesce event (nothing dropped)', () => {
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    getCoalescer(c).enqueue(makeSnapshot(100));
    c.processPendingSnapshot();
    expect(getCoalescedEvents().length).toBe(0);
  });

  it('5 snapshots queued (burst) → 1 coalesce event with dropped=4', () => {
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    // Simulate 5 onMessage fires during a stall — each one calls
    // enqueue(). The coalescer bumps the dropped counter on every
    // subsequent enqueue while a previous pending exists.
    for (let i = 100; i <= 104; i++) {
      getCoalescer(c).enqueue(makeSnapshot(i));
    }
    c.processPendingSnapshot();
    const events = getCoalescedEvents();
    expect(events.length).toBe(1);
    expect(events[0].dropped).toBe(4);
    expect(events[0].newestServerTick).toBe(104);
  });

  it('processed snapshot is THE NEWEST (highest serverTick)', () => {
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    // 5 enqueues — the last one wins.
    for (let i = 95; i <= 99; i++) {
      getCoalescer(c).enqueue(makeSnapshot(i));
    }
    c.processPendingSnapshot();
    const applied = getAppliedEvents();
    expect(applied.length).toBe(1);
    expect(applied[0].serverTick).toBe(99);
  });

  it('processPendingSnapshot is idempotent — second call with no pending is a no-op', () => {
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    getCoalescer(c).enqueue(makeSnapshot(100));
    c.processPendingSnapshot(); // processes
    c.processPendingSnapshot(); // no-op (pending is null)
    const applied = getAppliedEvents();
    expect(applied.length).toBe(1);
  });

  it('REGRESSION-WATCH: 10-snapshot burst → 1 apply event (not 10) — the spiral break', () => {
    // Locks the load-bearing invariant: a 10-snapshot burst (= ~500 ms
    // GC pause at 20 Hz) produces exactly ONE handleSnapshot call, ONE
    // RTT sample fed into Welford, ONE reconcile pass. Pre-coalesce
    // this was 10 of each, inflating Welford by 10× the queue time.
    setSearch('');
    __resetDiagCache();
    const c = new ColyseusGameClient();
    for (let i = 100; i <= 109; i++) {
      getCoalescer(c).enqueue(makeSnapshot(i));
    }
    c.processPendingSnapshot();
    const events = getCoalescedEvents();
    expect(events.length).toBe(1);
    expect(events[0].dropped).toBe(9);
    expect(events[0].newestServerTick).toBe(109);
    expect(getAppliedEvents().length).toBe(1);
  });
});
