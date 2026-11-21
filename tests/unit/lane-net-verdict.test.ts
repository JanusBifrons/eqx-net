/**
 * `scripts/dev/lane-net-verdict.mjs` (docs/ops/network-quality.md): the tier
 * classifier and the three-clock gap attribution, as pure functions. Reference
 * numbers are the phone captures the tiers were drawn from.
 */
import { describe, it, expect } from 'vitest';
import { attributeGap, classifyTier, latenessSeries, summarizeCapture, type CaptureEvent } from '../../scripts/dev/lane-net-verdict.mjs';

describe('classifyTier', () => {
  it('home Wi-Fi with only server gaps is Good', () => {
    expect(classifyTier({ rttP99Ms: 68, latenessP95Ms: 12, networkGapsPerMin: 0.1, maxNetworkGapMs: 355 }))
      .toEqual({ tier: 'Good', reasons: [] });
  });

  it('the 4G run (1volvr) is Poor on every bound', () => {
    const v = classifyTier({ rttP99Ms: 454, latenessP95Ms: 640, networkGapsPerMin: 22.5, maxNetworkGapMs: 5148 });
    expect(v.tier).toBe('Poor');
    expect(v.reasons).toHaveLength(4);
  });

  it('just over a Good bound is Playable, with the reason named', () => {
    const v = classifyTier({ rttP99Ms: 117, latenessP95Ms: 29, networkGapsPerMin: 0, maxNetworkGapMs: 0 });
    expect(v.tier).toBe('Playable');
    expect(v.reasons).toEqual(['RTT p99 117 >= 100 ms']);
  });

  it('bounds are strict', () => {
    expect(classifyTier({ rttP99Ms: 100, latenessP95Ms: 10, networkGapsPerMin: 0, maxNetworkGapMs: 0 }).tier).toBe('Playable');
    expect(classifyTier({ rttP99Ms: 50, latenessP95Ms: 10, networkGapsPerMin: 2, maxNetworkGapMs: 300 }).tier).toBe('Playable');
  });

  it('one network gap of a second or more is Poor however good the rest is', () => {
    expect(classifyTier({ rttP99Ms: 60, latenessP95Ms: 10, networkGapsPerMin: 1, maxNetworkGapMs: 1000 }).tier).toBe('Poor');
  });

  it('an unmeasured metric skips its bound; nothing measured is No data', () => {
    expect(classifyTier({ rttP99Ms: NaN, latenessP95Ms: 10, networkGapsPerMin: 0, maxNetworkGapMs: 0 }).tier).toBe('Good');
    expect(classifyTier({ rttP99Ms: NaN, latenessP95Ms: NaN, networkGapsPerMin: NaN, maxNetworkGapMs: 0 }).tier).toBe('No data');
  });
});

describe('attributeGap', () => {
  it('server: its own send stamps were already that far apart', () => {
    expect(attributeGap({ recvGapMs: 288, serverSendGapMs: 278, deviceStallMs: 0 })).toBe('server');
  });
  it('device: sent on time, but the main thread was blocked across the gap', () => {
    expect(attributeGap({ recvGapMs: 300, serverSendGapMs: 50, deviceStallMs: 200 })).toBe('device');
  });
  it('network: sent on time and the phone was free', () => {
    expect(attributeGap({ recvGapMs: 5148, serverSendGapMs: 50, deviceStallMs: 90 })).toBe('network');
  });
  it('unknown server gap (straddles a reconnect) is not blamed on the server', () => {
    expect(attributeGap({ recvGapMs: 900, serverSendGapMs: null, deviceStallMs: 0 })).toBe('network');
  });
});

describe('latenessSeries', () => {
  it('measures lateness above the best offset, whatever the clock offset', () => {
    const rx = [0, 50, 100, 150].map((s, i) => ({ serverSendPerfNow: 1e6 + s, clientRecvPerfNow: 5000 + s + (i === 2 ? 80 : 0) }));
    const late = latenessSeries(rx);
    expect(late[0]).toBe(0);
    expect(late[2]).toBeGreaterThan(75); // the baseline creeps 1 % toward each offset
  });
});

describe('summarizeCapture', () => {
  const rx = (ts: number, tick: number, send: number, gap: number): CaptureEvent => ({
    ts, tag: 'snapshot_received', data: { serverTick: tick, recvGapMs: gap, serverSendPerfNow: send, clientRecvPerfNow: ts },
  });

  it('splits gaps between server and network and judges only network gaps', () => {
    const snapshots: CaptureEvent[] = [];
    const OFFSET = 5000 - 500000; // unsynchronised clocks
    const HELD_MS = 350; // the network holds update 600 back; the next ones queue behind it
    let send = 500000, tick = 1000, prevRecv = -1;
    for (let i = 0; i < 1200; i++) { // one minute at 20 Hz
      const sendGap = i === 300 ? 400 : 50; // the server paused before update 300
      send += sendGap; tick += Math.round(sendGap / (1000 / 60));
      const held = i >= 600 ? Math.max(0, HELD_MS - (i - 600) * 50) : 0;
      const ts = send + OFFSET + held;
      snapshots.push(rx(ts, tick, send, prevRecv < 0 ? -1 : ts - prevRecv));
      prevRecv = ts;
      if (i % 20 === 0) snapshots.push({ ts, tag: 'snapshot', data: { rttMs: 60 } });
    }
    const v = summarizeCapture({ snapshots, perf: [], frames: [], lifecycle: [{ ts: 0, tag: 'welcome' }] });
    expect(v.gaps.total).toBe(2);
    expect(v.gaps.serverPct).toBe(50);
    expect(v.gaps.networkPct).toBe(50);
    expect(v.metrics.networkGapsPerMin).toBeCloseTo(1, 0);
    expect(v.tier).toBe('Good'); // one network gap a minute is under the Good rate; the server gap does not count
  });
});
