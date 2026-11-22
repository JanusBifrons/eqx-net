import { describe, expect, it } from 'vitest';
import {
  DEVICE_STALLS_BAD_PER_S,
  DRONE_MISSES_PER_DRONE_S,
  HysteresisGate,
  NET_GAP_WINDOW_MS,
  NET_HEALTH_HIDE_HOLD_MS,
  NET_HEALTH_SAMPLE_MS,
  NET_HEALTH_WINDOW_MS,
  NET_RTT_BAD_MS,
  NET_RTT_WARN_MS,
  NetHealthMonitor,
  OWN_CORRECTIONS_PER_S,
  RollingWindow,
  SERVER_SEND_GAP_BAD_MS,
  TieredGate,
  formatNetMs,
  netHealthDisplayKey,
  networkReadout,
  serverReadout,
  tailScore,
  type NetHealthSample,
} from './netHealth';
import { SERVER_SEND_GAP_MS } from '../net/snapshotArrivalStats.js';

/** Snapshots arrive every 50 ms on a healthy link (cumulative count at `nowMs`). */
const ARRIVAL_MS = 50;

function healthy(nowMs: number): NetHealthSample {
  return {
    active: true, connected: true, transportFellBack: false, rttMs: 60, lastSnapshotRecvAtMs: nowMs - 20,
    arrivals: Math.floor(nowMs / ARRIVAL_MS), lateWarn: 0, lateBad: 0, netGaps: 0, netGapsSevere: 0,
    latenessPeakMs: 5, serverSendGapPeakMs: 55, serverClockRate: 1,
    frameHitches: 0, frameSevereHitches: 0, longtasks: 0,
    ownCorrections: 0, droneMisses: 0, droneCount: 10,
  };
}
/** Run the monitor at the sample cadence from `t0` for `ms`, editing each sample. */
function run(m: NetHealthMonitor, t0: number, ms: number, edit: (s: NetHealthSample, t: number) => void): number {
  let t = t0;
  for (; t < t0 + ms; t += NET_HEALTH_SAMPLE_MS) {
    const s = healthy(t);
    edit(s, t);
    m.sample(s, t);
  }
  return t;
}

describe('RollingWindow', () => {
  it('averages only the samples inside the window', () => {
    const w = new RollingWindow(1000, 32);
    w.push(0, 100);
    w.push(500, 200);
    expect(w.mean()).toBe(150);
    w.push(1200, 300); // evicts t=0
    expect(w.mean()).toBe(250);
    expect(w.max()).toBe(300);
  });

  it('reports a per-second rate over the window', () => {
    const w = new RollingWindow(1000, 32);
    for (let t = 0; t < 1000; t += 100) w.push(t, 1);
    expect(w.ratePerSecond()).toBe(10);
  });

  it('overwrites the oldest sample when full and stays correct', () => {
    const w = new RollingWindow(1e9, 4);
    for (let i = 1; i <= 6; i++) w.push(i, i);
    expect(w.size).toBe(4);
    expect(w.sum()).toBe(3 + 4 + 5 + 6);
  });

  it('is empty-safe', () => {
    const w = new RollingWindow();
    expect(w.mean()).toBe(0);
    expect(w.max()).toBe(0);
  });
});

describe('HysteresisGate', () => {
  it('shows at the threshold and hides only after the hold below 0.8x', () => {
    const g = new HysteresisGate(0.8, 2000);
    expect(g.update(99, 100, 0)).toBe(false);
    expect(g.update(100, 100, 100)).toBe(true);
    // 85 is under the threshold but above 0.8x: stays shown indefinitely.
    expect(g.update(85, 100, 5000)).toBe(true);
    expect(g.update(70, 100, 6000)).toBe(true);
    expect(g.update(70, 100, 7999)).toBe(true);
    expect(g.update(70, 100, 8000)).toBe(false);
  });

  it('a spike back over 0.8x restarts the hold', () => {
    const g = new HysteresisGate(0.8, 2000);
    g.update(150, 100, 0);
    g.update(10, 100, 100);
    g.update(90, 100, 1500); // restart
    expect(g.update(10, 100, 2200)).toBe(true);
    expect(g.update(10, 100, 4199)).toBe(true);
    expect(g.update(10, 100, 4200)).toBe(false);
  });
});

describe('TieredGate', () => {
  it('shows amber at warn, red at bad, and each hides on its own hold', () => {
    const g = new TieredGate();
    g.update(0.9, 0.3, 0);
    expect(g.shown).toBe(false);
    g.update(1, 0.4, 100);
    expect(g).toMatchObject({ shown: true, level: 'warn' });
    g.update(3, 1.2, 200);
    expect(g).toMatchObject({ shown: true, level: 'bad' });
    // Back to amber-only: red holds for 2 s, then drops to amber.
    g.update(1.5, 0.5, 300);
    expect(g.level).toBe('bad');
    g.update(1.5, 0.5, 300 + NET_HEALTH_HIDE_HOLD_MS);
    expect(g).toMatchObject({ shown: true, level: 'warn' });
  });
});

describe('tailScore (p95 over a bound)', () => {
  it('reaches 1 exactly when the nearest-rank p95 passes the bound', () => {
    // 20 arrivals: p95 is the 19th value, so 1 late is fine and 2 are not.
    expect(tailScore(1, 20)).toBeLessThan(1);
    expect(tailScore(2, 20)).toBeGreaterThanOrEqual(1);
    // 10 arrivals: p95 is the max, so 1 late is enough.
    expect(tailScore(1, 10)).toBeGreaterThanOrEqual(1);
    expect(tailScore(0, 0)).toBe(0);
  });
});

describe('NetHealthMonitor', () => {
  it('shows nothing on a healthy link', () => {
    const m = new NetHealthMonitor();
    run(m, 0, 5000, () => {});
    expect(m.anyShown).toBe(false);
    expect(netHealthDisplayKey(m.view)).toBe('');
  });

  it('blames the network for ping: amber past Good, red past Playable', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    t = run(m, t, NET_HEALTH_WINDOW_MS, (s) => { s.rttMs = NET_RTT_WARN_MS + 20; });
    expect(m.view.network).toMatchObject({ shown: true, level: 'warn', cause: 'ping' });
    expect(m.view.server.shown).toBe(false);
    expect(m.view.device.shown).toBe(false);
    run(m, t, NET_HEALTH_WINDOW_MS, (s) => { s.rttMs = NET_RTT_BAD_MS + 50; });
    expect(m.view.network.level).toBe('bad');
    expect(networkReadout(m.view.network)).toBe(`${NET_RTT_BAD_MS + 50}`);
  });

  it('keeps the network item for the hold after it recovers, then hides', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, (s) => { s.rttMs = NET_RTT_WARN_MS + 100; });
    expect(m.view.network.shown).toBe(true);
    t = run(m, t, NET_HEALTH_HIDE_HOLD_MS, () => {});
    expect(m.view.network.shown).toBe(true);
    run(m, t, NET_HEALTH_WINDOW_MS, () => {});
    expect(m.view.network.shown).toBe(false);
  });

  it('blames the network for late arrivals (p95 lateness), not the server', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    // 3 of every 20 arrivals over 30 ms: amber; then 3 of 20 over 150 ms: red.
    let late = 0;
    t = run(m, t, NET_HEALTH_WINDOW_MS, (s) => { late += 0.3; s.lateWarn = Math.floor(late); s.latenessPeakMs = 80; });
    expect(m.view.network).toMatchObject({ shown: true, level: 'warn', cause: 'late' });
    expect(networkReadout(m.view.network)).toBe('+80ms');
    let bad = 0;
    run(m, t, NET_HEALTH_WINDOW_MS, (s) => {
      late += 0.3; bad += 0.3; s.lateWarn = Math.floor(late); s.lateBad = Math.floor(bad); s.latenessPeakMs = 400;
    });
    expect(m.view.network.level).toBe('bad');
    expect(m.view.server.shown).toBe(false);
  });

  it('counts network gaps per minute: 2 is amber, one over 1 s is red', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    t = run(m, t, 3000, (s, at) => { s.netGaps = at >= 3000 ? 2 : 1; });
    expect(m.view.network).toMatchObject({ shown: true, level: 'warn', cause: 'gaps' });
    expect(m.view.network.gapsPerMin).toBe(2);
    t = run(m, t, 1000, (s) => { s.netGaps = 3; s.netGapsSevere = 1; });
    expect(m.view.network.level).toBe('bad');
    // A gap stays counted for the whole minute.
    t = run(m, t, NET_GAP_WINDOW_MS - 5000, (s) => { s.netGaps = 3; s.netGapsSevere = 1; });
    expect(m.view.network.shown).toBe(true);
    run(m, t, 5000 + NET_HEALTH_HIDE_HOLD_MS + 500, (s) => { s.netGaps = 3; s.netGapsSevere = 1; });
    expect(m.view.network.shown).toBe(false);
  });

  it('shows an ongoing wait over 1 s red on the network item', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    const lastAt = t;
    t = run(m, t, 900, (s) => { s.lastSnapshotRecvAtMs = lastAt; });
    expect(m.view.network.shown).toBe(false);
    run(m, t, 300, (s) => { s.lastSnapshotRecvAtMs = lastAt; });
    expect(m.view.network).toMatchObject({ shown: true, level: 'bad', cause: 'wait' });
  });

  it('never reads a snapshot stamp from before activation as a wait', () => {
    const m = new NetHealthMonitor();
    m.sample({ ...healthy(10_000), active: false }, 10_000);
    run(m, 10_000, NET_HEALTH_SAMPLE_MS, (s) => { s.lastSnapshotRecvAtMs = 1_000; });
    expect(m.view.network.shown).toBe(false);
  });

  it('blames the server for a late send, not the network', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    t = run(m, t, NET_HEALTH_SAMPLE_MS, (s) => { s.serverSendGapPeakMs = SERVER_SEND_GAP_MS + 50; });
    expect(m.view.server).toMatchObject({ shown: true, level: 'warn' });
    expect(serverReadout(m.view.server)).toBe(`${SERVER_SEND_GAP_MS + 50}ms`);
    expect(m.view.network.shown).toBe(false);
    run(m, t, NET_HEALTH_SAMPLE_MS, (s) => { s.serverSendGapPeakMs = SERVER_SEND_GAP_BAD_MS + 200; });
    expect(m.view.server.level).toBe('bad');
  });

  it('blames the server for time dilation', () => {
    const m = new NetHealthMonitor();
    const t = run(m, 0, 1000, (s) => { s.serverClockRate = 0.9; });
    expect(m.view.server).toMatchObject({ shown: true, level: 'warn' });
    expect(serverReadout(m.view.server)).toBe('90%');
    run(m, t, 500, (s) => { s.serverClockRate = 0.5; });
    expect(m.view.server.level).toBe('bad');
  });

  it('blames the device for frame hitches and long tasks', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    let h = 0;
    t = run(m, t, NET_HEALTH_WINDOW_MS, (s) => { h += 0.3; s.frameHitches = Math.floor(h); }); // 3 / s
    expect(m.view.device).toMatchObject({ shown: true, level: 'warn' });
    expect(m.view.network.shown).toBe(false);
    expect(m.view.server.shown).toBe(false);
    let lt = 0;
    run(m, t, NET_HEALTH_WINDOW_MS, (s) => { s.frameHitches = Math.floor(h); lt += 0.6; s.longtasks = Math.floor(lt); });
    expect(m.view.device.stallsPerS).toBeGreaterThanOrEqual(DEVICE_STALLS_BAD_PER_S);
    expect(m.view.device.level).toBe('bad');

    const m2 = new NetHealthMonitor();
    t = run(m2, 0, 1000, () => {});
    run(m2, t, NET_HEALTH_SAMPLE_MS, (s) => { s.frameHitches = 1; s.frameSevereHitches = 1; });
    expect(m2.view.device).toMatchObject({ shown: true, level: 'bad' });
  });
  it('counts own-ship corrections per second', () => {
    const m = new NetHealthMonitor();
    let n = 0;
    run(m, 0, 3000, (s) => { n += 1; s.ownCorrections = n; }); // 10 / s
    expect(m.view.corrections.perS).toBeCloseTo(10, 0);
    expect(m.view.corrections.shown).toBe(true);
    const m2 = new NetHealthMonitor();
    let k = 0;
    run(m2, 0, 3000, (s, t) => { if (t % 500 === 0) k++; s.ownCorrections = k; }); // 2 / s
    expect(m2.view.corrections.perS).toBeLessThan(OWN_CORRECTIONS_PER_S);
    expect(m2.view.corrections.shown).toBe(false);
  });

  it('reads a restarted counter as a restart, not a huge negative or positive burst', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 1000, (s) => { s.ownCorrections = 1000; });
    t = run(m, t, 1000, (s) => { s.ownCorrections = 0; });
    expect(m.view.corrections.shown).toBe(false);
    expect(m.view.corrections.perS).toBe(0);
    void t;
  });

  it('normalises drone misses per drone', () => {
    const m = new NetHealthMonitor();
    let misses = 0;
    // 10 drones, 5 misses per sample = 50 / s = 5 per drone per second.
    run(m, 0, 2000, (s) => { misses += 5; s.droneMisses = misses; });
    expect(m.view.drones.perDroneS).toBeGreaterThanOrEqual(DRONE_MISSES_PER_DRONE_S);
    expect(m.view.drones.shown).toBe(true);
  });

  it('shows the link item when disconnected or on the WebSocket fallback', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 500, (s) => { s.connected = false; });
    expect(m.view.link).toMatchObject({ shown: true, state: 'down' });
    t = run(m, t, NET_HEALTH_HIDE_HOLD_MS + 200, () => {});
    expect(m.view.link.shown).toBe(false);
    run(m, t, 200, (s) => { s.transportFellBack = true; });
    expect(m.view.link).toMatchObject({ shown: true, state: 'ws' });
  });

  it('resets and hides everything when inactive', () => {
    const m = new NetHealthMonitor();
    const t = run(m, 0, 2000, (s) => { s.rttMs = 500; s.connected = false; });
    expect(m.anyShown).toBe(true);
    m.sample({ ...healthy(t), active: false }, t);
    expect(m.anyShown).toBe(false);
  });
});

describe('formatNetMs', () => {
  it('uses ms under a second and s above', () => {
    expect(formatNetMs(450.4)).toBe('450ms');
    expect(formatNetMs(3210)).toBe('3.2s');
  });
});
