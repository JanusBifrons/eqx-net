import { describe, expect, it } from 'vitest';
import {
  DRONE_MISSES_PER_DRONE_S,
  HysteresisGate,
  NET_HEALTH_HIDE_HOLD_MS,
  NET_HEALTH_SAMPLE_MS,
  NET_HEALTH_WINDOW_MS,
  NetHealthMonitor,
  OWN_CORRECTIONS_PER_S,
  PING_BAD_MS,
  PING_WARN_MS,
  RollingWindow,
  SNAPSHOT_STALL_MS,
  formatNetMs,
  netHealthDisplayKey,
  type NetHealthSample,
} from './netHealth';

function healthy(nowMs: number): NetHealthSample {
  return {
    active: true, connected: true, transportFellBack: false, rttMs: 60,
    lastSnapshotRecvAtMs: nowMs - 20, timelineSnaps: 0, ownCorrections: 0, droneMisses: 0, droneCount: 10,
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

describe('NetHealthMonitor', () => {
  it('shows nothing on a healthy link', () => {
    const m = new NetHealthMonitor();
    run(m, 0, 5000, () => {});
    expect(m.anyShown).toBe(false);
    expect(netHealthDisplayKey(m.view)).toBe('');
  });

  it('ignores a single ping spike (1 s average) but shows sustained high ping', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    t = run(m, t, NET_HEALTH_SAMPLE_MS, (s) => { s.rttMs = 600; });
    expect(m.view.ping.shown).toBe(false);
    t = run(m, t, NET_HEALTH_WINDOW_MS, (s) => { s.rttMs = 200; });
    expect(m.view.ping.shown).toBe(true);
    expect(m.view.ping.level).toBe('warn');
    run(m, t, NET_HEALTH_WINDOW_MS, (s) => { s.rttMs = PING_BAD_MS + 50; });
    expect(m.view.ping.level).toBe('bad');
  });

  it('keeps the ping shown for the hold after it recovers, then hides', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, (s) => { s.rttMs = PING_WARN_MS + 100; });
    expect(m.view.ping.shown).toBe(true);
    // The 1 s mean falls under 0.8x within the first window; the hold keeps it up after.
    t = run(m, t, NET_HEALTH_HIDE_HOLD_MS, () => {});
    expect(m.view.ping.shown).toBe(true);
    run(m, t, NET_HEALTH_WINDOW_MS, () => {});
    expect(m.view.ping.shown).toBe(false);
  });

  it('flags a snapshot stall and a timeline hard snap', () => {
    const m = new NetHealthMonitor();
    let t = run(m, 0, 2000, () => {});
    const stalledAt = t;
    t = run(m, t, SNAPSHOT_STALL_MS + 100, (s) => { s.lastSnapshotRecvAtMs = stalledAt; });
    expect(m.view.stall.shown).toBe(true);
    expect(m.view.stall.ms).toBeGreaterThanOrEqual(SNAPSHOT_STALL_MS);

    const m2 = new NetHealthMonitor();
    t = run(m2, 0, 1000, () => {});
    run(m2, t, NET_HEALTH_SAMPLE_MS, (s) => { s.timelineSnaps = 1; });
    expect(m2.view.stall.shown).toBe(true);
    expect(m2.view.stall.gaps).toBe(1);
  });

  it('never reads a snapshot stamp from before activation as a stall', () => {
    const m = new NetHealthMonitor();
    m.sample({ ...healthy(10_000), active: false }, 10_000);
    run(m, 10_000, NET_HEALTH_SAMPLE_MS, (s) => { s.lastSnapshotRecvAtMs = 1_000; });
    expect(m.view.stall.shown).toBe(false);
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
