/**
 * Net-health HUD logic (pure, no DOM, no store): turns the client's existing
 * net counters into a small set of "something is wrong" indicators.
 *
 * Inputs are the counters the game already keeps (`ColyseusClient.stats`, the
 * swarm interpolation / clock-anchor / render-due snap counters, the
 * DataChannel transport) sampled by `NetHealthCluster` on a slow timer. Every
 * metric is averaged or counted over a rolling ~1 s window, and each indicator
 * has hysteresis: it shows when its metric reaches its threshold and hides only
 * after the metric has stayed under `NET_HEALTH_HIDE_RATIO` × threshold for
 * `NET_HEALTH_HIDE_HOLD_MS`, so nothing flickers.
 *
 * Allocation: all buffers and the view are built once; `sample` allocates
 * nothing (#14). Thresholds: docs/architecture/prediction-and-correction.md
 * "Net-health HUD".
 */

/** How often the cluster samples the counters (ms, wall time). */
export const NET_HEALTH_SAMPLE_MS = 100;
/** How often, at most, the cluster re-renders with new values (ms). */
export const NET_HEALTH_PUBLISH_MS = 250;
/** Rolling window every metric is averaged / counted over (ms). */
export const NET_HEALTH_WINDOW_MS = 1000;
/** An indicator hides only once its metric is under this × its threshold ... */
export const NET_HEALTH_HIDE_RATIO = 0.8;
/** ... continuously for this long (ms). */
export const NET_HEALTH_HIDE_HOLD_MS = 2000;

/** Ping (1 s mean RTT) shows amber at this (ms) ... */
export const PING_WARN_MS = 150;
/** ... and red at this (ms). */
export const PING_BAD_MS = 300;
/** Snapshot stall: the longest time without a server snapshot in the window (ms). */
export const SNAPSHOT_STALL_MS = 200;
/** Own-ship reconciliation corrections (drift > 0.05 u) per second. */
export const OWN_CORRECTIONS_PER_S = 5;
/** Drone interpolation misses (frozen at the glide limit or clamped to the
 *  ring's old end) per drone per second: ~5% of a 60 fps budget. */
export const DRONE_MISSES_PER_DRONE_S = 3;

/** Ring capacity: one window of samples plus slack for timer jitter. */
const RING_CAPACITY = Math.ceil(NET_HEALTH_WINDOW_MS / NET_HEALTH_SAMPLE_MS) * 2 + 4;
const MS_PER_S = 1000;

/** A fixed-capacity time-stamped ring: mean / max / per-second rate over the
 *  last `windowMs`. Allocates its two typed arrays once. */
export class RollingWindow {
  private readonly t: Float64Array;
  private readonly v: Float64Array;
  private head = 0;
  private n = 0;

  constructor(private readonly windowMs: number = NET_HEALTH_WINDOW_MS, capacity: number = RING_CAPACITY) {
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
  }

  get size(): number { return this.n; }

  push(nowMs: number, value: number): void {
    this.evict(nowMs);
    const cap = this.t.length;
    this.t[this.head] = nowMs;
    this.v[this.head] = value;
    this.head = (this.head + 1) % cap;
    if (this.n < cap) this.n++;
  }

  /** Drop samples older than the window. */
  evict(nowMs: number): void {
    const cap = this.t.length;
    while (this.n > 0) {
      const oldest = (this.head - this.n + cap) % cap;
      if ((this.t[oldest] ?? 0) > nowMs - this.windowMs) break;
      this.n--;
    }
  }

  /** Mean of the samples in the window; 0 when empty. */
  mean(): number { return this.n === 0 ? 0 : this.sum() / this.n; }

  /** Largest sample in the window; 0 when empty. */
  max(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const x = this.v[this.idx(i)] ?? 0;
      if (i === 0 || x > m) m = x;
    }
    return m;
  }

  sum(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.v[this.idx(i)] ?? 0;
    return s;
  }

  /** Sum of the window's samples expressed per second. */
  ratePerSecond(): number { return this.sum() * (MS_PER_S / this.windowMs); }

  clear(): void { this.head = 0; this.n = 0; }

  private idx(i: number): number {
    const cap = this.t.length;
    return (this.head - this.n + i + cap) % cap;
  }
}

/** Show-at-threshold, hide-after-hold hysteresis for one indicator. */
export class HysteresisGate {
  shown = false;
  private belowSinceMs = -1;

  constructor(
    private readonly hideRatio: number = NET_HEALTH_HIDE_RATIO,
    private readonly holdMs: number = NET_HEALTH_HIDE_HOLD_MS,
  ) {}

  update(value: number, threshold: number, nowMs: number): boolean {
    if (!this.shown) {
      if (value >= threshold) { this.shown = true; this.belowSinceMs = -1; }
      return this.shown;
    }
    if (value >= threshold * this.hideRatio) { this.belowSinceMs = -1; return true; }
    if (this.belowSinceMs < 0) this.belowSinceMs = nowMs;
    if (nowMs - this.belowSinceMs >= this.holdMs) { this.shown = false; this.belowSinceMs = -1; }
    return this.shown;
  }

  reset(): void { this.shown = false; this.belowSinceMs = -1; }
}

/** One sample of the existing counters. Cumulative counters may restart from
 *  zero (sector handoff, new client): a drop is read as a restart. */
export interface NetHealthSample {
  /** False outside a live sector room (transit, menus): everything resets and hides. */
  active: boolean;
  connected: boolean;
  /** The WebRTC DataChannel failed and snapshots fell back to the WebSocket. */
  transportFellBack: boolean;
  /** Latest RTT estimate (ms); 0 = none yet. */
  rttMs: number;
  /** Wall time (same base as `nowMs`) the last snapshot arrived; < 0 = none yet. */
  lastSnapshotRecvAtMs: number;
  /** Cumulative clock-anchor + render-due hard snaps (net freezes over 200 ms). */
  timelineSnaps: number;
  /** Cumulative own-ship significant corrections. */
  ownCorrections: number;
  /** Cumulative drone interpolation misses (glide limit + old-end clamp). */
  droneMisses: number;
  droneCount: number;
}

export type PingLevel = 'warn' | 'bad';
export type LinkState = 'down' | 'ws';

export interface NetHealthView {
  ping: { shown: boolean; ms: number; level: PingLevel };
  stall: { shown: boolean; ms: number; gaps: number };
  corrections: { shown: boolean; perS: number };
  drones: { shown: boolean; perDroneS: number };
  link: { shown: boolean; state: LinkState };
}

/** Counter delta that reads a drop (counter restarted) as a restart from zero. */
function counterDelta(prev: number, cur: number): number {
  if (Number.isNaN(prev)) return 0;
  return cur >= prev ? cur - prev : cur;
}

export class NetHealthMonitor {
  readonly view: NetHealthView = {
    ping: { shown: false, ms: 0, level: 'warn' },
    stall: { shown: false, ms: 0, gaps: 0 },
    corrections: { shown: false, perS: 0 },
    drones: { shown: false, perDroneS: 0 },
    link: { shown: false, state: 'down' },
  };

  private readonly rtt = new RollingWindow();
  private readonly sinceSnap = new RollingWindow();
  private readonly gaps = new RollingWindow();
  private readonly corr = new RollingWindow();
  private readonly droneMiss = new RollingWindow();
  private readonly droneCount = new RollingWindow();

  private readonly pingGate = new HysteresisGate();
  private readonly stallGate = new HysteresisGate();
  private readonly corrGate = new HysteresisGate();
  private readonly droneGate = new HysteresisGate();
  private readonly downGate = new HysteresisGate();

  private prevGaps = NaN;
  private prevCorr = NaN;
  private prevDrone = NaN;
  private activeSinceMs = -1;

  /** True when any indicator is showing. */
  get anyShown(): boolean {
    const v = this.view;
    return v.ping.shown || v.stall.shown || v.corrections.shown || v.drones.shown || v.link.shown;
  }

  sample(s: NetHealthSample, nowMs: number): void {
    if (!s.active) { this.reset(); return; }
    const v = this.view;

    if (s.rttMs > 0) this.rtt.push(nowMs, s.rttMs); else this.rtt.evict(nowMs);
    v.ping.ms = this.rtt.mean();
    v.ping.level = v.ping.ms >= PING_BAD_MS ? 'bad' : 'warn';
    v.ping.shown = this.pingGate.update(v.ping.ms, PING_WARN_MS, nowMs);

    // Measure the wait from activation at the earliest, so a snapshot stamp
    // left over from before a transit or menu never reads as a stall.
    if (this.activeSinceMs < 0) this.activeSinceMs = nowMs;
    const lastRecv = Math.max(s.lastSnapshotRecvAtMs, this.activeSinceMs);
    this.sinceSnap.push(nowMs, Math.max(0, nowMs - lastRecv));
    this.gaps.push(nowMs, counterDelta(this.prevGaps, s.timelineSnaps));
    this.prevGaps = s.timelineSnaps;
    v.stall.ms = this.sinceSnap.max();
    v.stall.gaps = this.gaps.sum();
    const stallMetric = v.stall.gaps > 0 ? Math.max(v.stall.ms, SNAPSHOT_STALL_MS) : v.stall.ms;
    v.stall.shown = this.stallGate.update(stallMetric, SNAPSHOT_STALL_MS, nowMs);

    this.corr.push(nowMs, counterDelta(this.prevCorr, s.ownCorrections));
    this.prevCorr = s.ownCorrections;
    v.corrections.perS = this.corr.ratePerSecond();
    v.corrections.shown = this.corrGate.update(v.corrections.perS, OWN_CORRECTIONS_PER_S, nowMs);

    this.droneMiss.push(nowMs, counterDelta(this.prevDrone, s.droneMisses));
    this.prevDrone = s.droneMisses;
    this.droneCount.push(nowMs, s.droneCount);
    const drones = this.droneCount.mean();
    v.drones.perDroneS = drones >= 1 ? this.droneMiss.ratePerSecond() / drones : 0;
    v.drones.shown = this.droneGate.update(v.drones.perDroneS, DRONE_MISSES_PER_DRONE_S, nowMs);

    const down = this.downGate.update(s.connected ? 0 : 1, 1, nowMs);
    v.link.state = down ? 'down' : 'ws';
    v.link.shown = down || s.transportFellBack;
  }

  reset(): void {
    this.rtt.clear(); this.sinceSnap.clear(); this.gaps.clear();
    this.corr.clear(); this.droneMiss.clear(); this.droneCount.clear();
    this.pingGate.reset(); this.stallGate.reset(); this.corrGate.reset();
    this.droneGate.reset(); this.downGate.reset();
    this.prevGaps = NaN; this.prevCorr = NaN; this.prevDrone = NaN;
    this.activeSinceMs = -1;
    const v = this.view;
    v.ping.shown = false; v.stall.shown = false; v.corrections.shown = false;
    v.drones.shown = false; v.link.shown = false;
  }
}

/** Short readout for a duration: "450ms" under a second, "3.2s" above. */
export function formatNetMs(ms: number): string {
  return ms < MS_PER_S ? `${Math.round(ms)}ms` : `${(ms / MS_PER_S).toFixed(1)}s`;
}

/** Display key of the view: equal keys mean the cluster need not re-render.
 *  Values are bucketed so sub-visible changes don't cause renders. */
export function netHealthDisplayKey(v: NetHealthView): string {
  const PING_BUCKET_MS = 10;
  const STALL_BUCKET_MS = 50;
  if (!v.ping.shown && !v.stall.shown && !v.corrections.shown && !v.drones.shown && !v.link.shown) return '';
  return `${v.ping.shown ? Math.round(v.ping.ms / PING_BUCKET_MS) : -1}${v.ping.level}|`
    + `${v.stall.shown ? Math.round(v.stall.ms / STALL_BUCKET_MS) : -1}|`
    + `${v.corrections.shown ? Math.round(v.corrections.perS) : -1}|`
    + `${v.drones.shown ? Math.round(v.drones.perDroneS) : -1}|`
    + `${v.link.shown ? v.link.state : '-'}`;
}
