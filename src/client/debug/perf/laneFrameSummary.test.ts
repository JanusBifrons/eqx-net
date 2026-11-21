import { describe, it, expect, beforeEach } from 'vitest';
import type { Room } from 'colyseus.js';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import {
  buildLanePerfSummary, readLaneNetGapCounters, LANE_HITCH_MS,
  type LaneSummaryInputs, type LanePerfSummary, type LaneNetGapCounters,
} from './laneFrameSummary';
import {
  createSnapshotDataChannel, getActiveSnapshotTransport, registerRoomLifecycle, type SnapshotSink,
} from '../../net/connection/roomConnection.js';
import { resetSwarmTickClock } from '../../net/swarmInterpolation.js';
import { resetAnchorHardSnapCount } from '../../net/clockAnchor.js';
import { resetRenderDueSnapCount } from '../../net/renderTickPhase.js';

const NET = { rttMs: 80, rttMeanMs: 75.4321, snapshotJitterMs: 12.345, significantCorrectionCount: 40, rollingCorrRate: 0.3, maxDriftUnits: 4.56789 };

function inputs(over: Partial<LaneSummaryInputs> = {}): LaneSummaryInputs {
  return {
    windowMs: 10_000, viewHalf: 1834.567, counts: { ships: 3, drones: 120, structures: 45, projectiles: 7 },
    net: NET, correctionsBefore: 25, ...over,
  };
}

const GAP_KEYS: readonly (keyof LaneNetGapCounters)[] = [
  'dcLastArrivalMs', 'dcLastDrainReplaced', 'dcReplacedTotal',
  'swarmLateLastMs', 'swarmLateMaxMs', 'swarmLateSumMs', 'swarmLateCount',
  'swarmOverwriteUnread', 'swarmOldEndClamp', 'swarmGlideLimit',
  'anchorHardSnaps', 'renderDueSnaps',
];

/** A room stub: only what `createSnapshotDataChannel` / `registerRoomLifecycle` touch. */
function fakeRoom(): { room: Room; leave(code: number): void } {
  let onLeave: ((code: number) => void) | null = null;
  const room = {
    send: (): void => undefined,
    onLeave: (cb: (code: number) => void): void => { onLeave = cb; },
    onError: (): void => undefined,
  } as unknown as Room;
  return { room, leave: (code) => onLeave?.(code) };
}

const SINK = {
  snapshotCoalescer: { isEnabled: () => false, enqueue: () => undefined },
  logSnapshotRecvTelemetry: () => undefined,
  applySnapshotNow: () => undefined,
} as unknown as SnapshotSink;

describe('phone-lane perf summary', () => {
  it('reports frame-time percentiles, >50 ms hitches and the longest frame', () => {
    const ring = new FrameTimeRing(2048);
    for (let i = 0; i < 97; i++) ring.push(11);
    ring.push(45); // a stutter, under the 50 ms hitch line
    ring.push(60);
    ring.push(140);
    const s = buildLanePerfSummary(ring, inputs());
    expect(LANE_HITCH_MS).toBe(50);
    expect(s).toMatchObject({ frames: 100, p50: 11, p95: 11, p99: 140, maxMs: 140, hitches: 2 });
  });

  it('carries zoom, entity counts, RTT and the corrections made in this window', () => {
    const ring = new FrameTimeRing(64);
    ring.push(16);
    const s = buildLanePerfSummary(ring, inputs());
    expect(s).toMatchObject({
      windowMs: 10_000, viewHalf: 1835, ships: 3, drones: 120, structures: 45, projectiles: 7,
      rttMs: 80, rttMeanMs: 75.4, jitterMs: 12.3, corrections: 15, corrRate: 0.3, maxDrift: 4.57,
    });
  });

  it('a counter that went backwards (new room / client) counts from zero', () => {
    const s = buildLanePerfSummary(new FrameTimeRing(8), inputs({ correctionsBefore: 90 }));
    expect(s.corrections).toBe(40);
  });

  it('no client yet: frame numbers only, the rest null; nothing identifying', () => {
    const s = buildLanePerfSummary(new FrameTimeRing(8), inputs({ viewHalf: null, counts: null, net: null }));
    expect(s).toMatchObject({ frames: 0, maxMs: 0, hitches: 0, viewHalf: null, ships: null, rttMs: null, corrections: null });
    // Numbers and nulls only: no ids, names, user agent or position.
    for (const v of Object.values(s)) expect(v === null || typeof v === 'number').toBe(true);
  });
});

describe('perf_summary netcode gap counters (S0-4)', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    resetAnchorHardSnapCount();
    resetRenderDueSnapCount();
  });

  it('a summary written with the gap counters reads back with them', () => {
    const gap: LaneNetGapCounters = {
      dcLastArrivalMs: 12_345.6, dcLastDrainReplaced: 2, dcReplacedTotal: 17,
      swarmLateLastMs: 41.2, swarmLateMaxMs: 380.5, swarmLateSumMs: 9_001.3, swarmLateCount: 240,
      swarmOverwriteUnread: 3, swarmOldEndClamp: 5, swarmGlideLimit: 1, anchorHardSnaps: 2, renderDueSnaps: 4,
    };
    const s = buildLanePerfSummary(new FrameTimeRing(8), inputs({ gap }));
    const back = JSON.parse(JSON.stringify(s)) as LanePerfSummary;
    expect(back).toEqual(s);
    expect(back).toMatchObject(gap);
    for (const v of Object.values(back)) expect(v === null || typeof v === 'number').toBe(true);
  });

  it('an old perf_summary line without the gap counters still reads', () => {
    const old = buildLanePerfSummary(new FrameTimeRing(8), inputs());
    for (const k of GAP_KEYS) expect(k in old).toBe(false);
    const back = JSON.parse(JSON.stringify(old)) as LanePerfSummary;
    expect(back.rttMs).toBe(80);
    expect(back.anchorHardSnaps ?? null).toBeNull();
    expect(back.dcReplacedTotal ?? null).toBeNull();
  });

  it('samples every counter; DataChannel fields are null with no live transport', () => {
    expect(getActiveSnapshotTransport()).toBeNull();
    const g = readLaneNetGapCounters();
    for (const k of GAP_KEYS) expect(k in g).toBe(true);
    expect(g).toMatchObject({
      dcLastArrivalMs: null, dcLastDrainReplaced: null, dcReplacedTotal: null,
      swarmLateCount: 0, swarmOverwriteUnread: 0, anchorHardSnaps: 0, renderDueSnaps: 0,
    });
  });

  it('reads the DataChannel transport while it lives; the slot reads null once it closes', () => {
    const { room } = fakeRoom();
    const t = createSnapshotDataChannel(room, SINK);
    expect(getActiveSnapshotTransport()).toBe(t);
    expect(readLaneNetGapCounters()).toMatchObject({ dcLastArrivalMs: 0, dcLastDrainReplaced: 0, dcReplacedTotal: 0 });
    t.close('sector-handoff'); // a close path outside roomConnection.ts
    expect(getActiveSnapshotTransport()).toBeNull();
    expect(readLaneNetGapCounters().dcReplacedTotal).toBeNull();
  });

  it('room leave clears the slot', () => {
    const { room, leave } = fakeRoom();
    const ctx = { dataChannelTransport: createSnapshotDataChannel(room, SINK), detachInput: (): void => undefined };
    registerRoomLifecycle(room, ctx, { onConnectionStatus: () => undefined });
    expect(getActiveSnapshotTransport()).not.toBeNull();
    leave(1000);
    expect(ctx.dataChannelTransport).toBeNull();
    expect(getActiveSnapshotTransport()).toBeNull();
  });
});
