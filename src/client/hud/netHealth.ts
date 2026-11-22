/**
 * Net-health HUD logic (pure, no DOM, no store): turns the client's existing
 * counters into "something is wrong, and whose fault it is" indicators.
 *
 * Three sources, each judged on its own clock:
 *   - network: the server sent on time but the update arrived late or with a
 *     gap (arrival time against the server's send stamp), or the RTT is high.
 *   - server: the server itself sent late (consecutive send-stamp gaps) or is
 *     running in time dilation (`clockRate` < 1).
 *   - device: frames took too long to draw (frame hitches, long tasks).
 * Own-ship corrections and drone misses stay as consequence indicators, plus
 * the link state (disconnected / WebSocket fallback).
 *
 * Inputs are counters the game already keeps, sampled by `NetHealthCluster`
 * on a 10 Hz timer. Metrics are averaged / counted over a rolling 1 s window
 * (network gaps over 60 s: the owner's tier is per minute). Each indicator
 * has show / hide hysteresis (`netHealthWindow.ts`). Allocation: everything
 * is built once; `sample` allocates nothing (#14). Thresholds and the tiers
 * they come from: docs/architecture/prediction-and-correction.md
 * "Net-health HUD".
 */
import {
  HysteresisGate, NET_HEALTH_WINDOW_MS, RollingWindow, TieredGate, ringCapacityFor, type NetLevel,
} from './netHealthWindow';
import { NET_GAP_SEVERE_MS, SERVER_SEND_GAP_MS } from '../net/snapshotArrivalStats.js';

export {
  HysteresisGate, NET_HEALTH_HIDE_HOLD_MS, NET_HEALTH_HIDE_RATIO, NET_HEALTH_SAMPLE_MS, NET_HEALTH_WINDOW_MS,
  RollingWindow, TieredGate, type NetLevel,
} from './netHealthWindow';

/** How often, at most, the cluster re-renders with new values (ms). */
export const NET_HEALTH_PUBLISH_MS = 250;
/** Network gaps are counted over this window: the owner's tier is per minute (ms). */
export const NET_GAP_WINDOW_MS = 60_000;

// Network tiers (owner): Good = RTT p99 < 100, lateness p95 < 30, < 2 gaps
// over 200 ms / min. Playable = RTT p99 < 250, lateness p95 < 150, < 10 gaps
// / min and none over 1 s. Amber = past Good, red = past Playable.
/** RTT p99 (the max of the window's ~10 samples) amber / red bounds (ms). */
export const NET_RTT_WARN_MS = 100;
export const NET_RTT_BAD_MS = 250;
/** Lateness is a p95: past its bound when more than this share of arrivals is. */
export const NET_LATE_TAIL_FRACTION = 0.05;
/** Network gaps (over `NET_GAP_MS`) per minute: amber / red. */
export const NET_GAPS_WARN_PER_MIN = 2;
export const NET_GAPS_BAD_PER_MIN = 10;
/** An ongoing wait for any snapshot this long shows red on the network item
 *  before its cause is known (the arrival that ends it decides; ms). */
export const NET_WAIT_BAD_MS = NET_GAP_SEVERE_MS;

/** Largest consecutive send-stamp gap: amber at `SERVER_SEND_GAP_MS`, red here (ms). */
export const SERVER_SEND_GAP_BAD_MS = 1000;
/** Server clock rate (time dilation): amber under this ... */
export const SERVER_CLOCK_RATE_WARN = 0.99;
/** ... red under this. */
export const SERVER_CLOCK_RATE_BAD = 0.75;

/** Device stalls (max of frame hitches and long tasks) per second: amber / red.
 *  Any severe hitch (`FRAME_SEVERE_HITCH_MS`) in the window is red. */
export const DEVICE_STALLS_WARN_PER_S = 2;
export const DEVICE_STALLS_BAD_PER_S = 5;

/** Own-ship reconciliation corrections (drift > 0.05 u) per second. */
export const OWN_CORRECTIONS_PER_S = 5;
/** Drone interpolation misses (frozen at the glide limit or clamped to the
 *  ring's old end) per drone per second: ~5% of a 60 fps budget. */
export const DRONE_MISSES_PER_DRONE_S = 3;

const MS_PER_S = 1000;
/** Cause ranking: any red sub-metric outranks every amber one. */
const RED_RANK_BOOST = 10;

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
  /** Cumulative snapshot arrivals, and those later than the warn / bad bounds. */
  arrivals: number;
  lateWarn: number;
  lateBad: number;
  /** Cumulative network-attributed gaps (> 200 ms), and those over 1 s. */
  netGaps: number;
  netGapsSevere: number;
  /** Largest arrival lateness since the previous sample (ms). */
  latenessPeakMs: number;
  /** Largest consecutive server send-stamp gap since the previous sample (ms). */
  serverSendGapPeakMs: number;
  /** Server time-dilation rate (1 = real time). */
  serverClockRate: number;
  /** Cumulative frame hitches (> 50 ms), severe hitches, and long tasks. */
  frameHitches: number;
  frameSevereHitches: number;
  longtasks: number;
  /** Cumulative own-ship significant corrections. */
  ownCorrections: number;
  /** Cumulative drone interpolation misses (glide limit + old-end clamp). */
  droneMisses: number;
  droneCount: number;
}

export type NetCause = 'ping' | 'late' | 'gaps' | 'wait';
export type LinkState = 'down' | 'ws';

export interface NetHealthView {
  network: { shown: boolean; level: NetLevel; cause: NetCause; rttMs: number; latenessMs: number; gapsPerMin: number; waitMs: number };
  server: { shown: boolean; level: NetLevel; sendGapMs: number; clockRate: number };
  device: { shown: boolean; level: NetLevel; stallsPerS: number };
  corrections: { shown: boolean; perS: number };
  drones: { shown: boolean; perDroneS: number };
  link: { shown: boolean; state: LinkState };
}

/** Counter delta that reads a drop (counter restarted) as a restart from zero. */
function counterDelta(prev: number, cur: number): number {
  if (Number.isNaN(prev)) return 0;
  return cur >= prev ? cur - prev : cur;
}

/** p95-over-a-bound score for `late` of `n` arrivals past the bound: the
 *  nearest-rank p95 of n values exceeds the bound iff more than
 *  floor(n × 5%) do, so the score reaches 1 exactly there. */
export function tailScore(late: number, n: number): number {
  return n <= 0 ? 0 : late / (Math.floor(n * NET_LATE_TAIL_FRACTION) + 1);
}

/** Cumulative counter → per-sample delta pushed into a rolling window. */
class CounterWindow {
  readonly w: RollingWindow;
  private prev = NaN;
  constructor(windowMs: number = NET_HEALTH_WINDOW_MS) { this.w = new RollingWindow(windowMs, ringCapacityFor(windowMs)); }
  push(nowMs: number, cumulative: number): void { this.w.push(nowMs, counterDelta(this.prev, cumulative)); this.prev = cumulative; }
  clear(): void { this.w.clear(); this.prev = NaN; }
}

export class NetHealthMonitor {
  readonly view: NetHealthView = {
    network: { shown: false, level: 'warn', cause: 'ping', rttMs: 0, latenessMs: 0, gapsPerMin: 0, waitMs: 0 },
    server: { shown: false, level: 'warn', sendGapMs: 0, clockRate: 1 },
    device: { shown: false, level: 'warn', stallsPerS: 0 },
    corrections: { shown: false, perS: 0 },
    drones: { shown: false, perDroneS: 0 },
    link: { shown: false, state: 'down' },
  };

  private readonly rtt = new RollingWindow();
  private readonly latePeak = new RollingWindow();
  private readonly arrivals = new CounterWindow();
  private readonly lateWarn = new CounterWindow();
  private readonly lateBad = new CounterWindow();
  private readonly gaps = new CounterWindow(NET_GAP_WINDOW_MS);
  private readonly gapsSevere = new CounterWindow(NET_GAP_WINDOW_MS);
  private readonly sendGapPeak = new RollingWindow();
  private readonly hitches = new CounterWindow();
  private readonly severe = new CounterWindow();
  private readonly longtasks = new CounterWindow();
  private readonly corr = new CounterWindow();
  private readonly droneMiss = new CounterWindow();
  private readonly droneCount = new RollingWindow();

  private readonly netGate = new TieredGate();
  private readonly serverGate = new TieredGate();
  private readonly deviceGate = new TieredGate();
  private readonly corrGate = new HysteresisGate();
  private readonly droneGate = new HysteresisGate();
  private readonly downGate = new HysteresisGate();
  private activeSinceMs = -1;
  // Network sub-metric fold scratch (no closure per sample).
  private netWarn = 0;
  private netBad = 0;
  private netRank = -1;

  /** True when any indicator is showing. */
  get anyShown(): boolean {
    const v = this.view;
    return v.network.shown || v.server.shown || v.device.shown || v.corrections.shown || v.drones.shown || v.link.shown;
  }

  sample(s: NetHealthSample, nowMs: number): void {
    if (!s.active) { this.reset(); return; }
    if (this.activeSinceMs < 0) this.activeSinceMs = nowMs;
    this.sampleNetwork(s, nowMs);
    this.sampleServer(s, nowMs);
    this.sampleDevice(s, nowMs);
    const v = this.view;

    this.corr.push(nowMs, s.ownCorrections);
    v.corrections.perS = this.corr.w.ratePerSecond();
    v.corrections.shown = this.corrGate.update(v.corrections.perS, OWN_CORRECTIONS_PER_S, nowMs);

    this.droneMiss.push(nowMs, s.droneMisses);
    this.droneCount.push(nowMs, s.droneCount);
    const drones = this.droneCount.mean();
    v.drones.perDroneS = drones >= 1 ? this.droneMiss.w.ratePerSecond() / drones : 0;
    v.drones.shown = this.droneGate.update(v.drones.perDroneS, DRONE_MISSES_PER_DRONE_S, nowMs);

    const down = this.downGate.update(s.connected ? 0 : 1, 1, nowMs);
    v.link.state = down ? 'down' : 'ws';
    v.link.shown = down || s.transportFellBack;
  }

  private sampleNetwork(s: NetHealthSample, nowMs: number): void {
    const n = this.view.network;
    if (s.rttMs > 0) this.rtt.push(nowMs, s.rttMs); else this.rtt.evict(nowMs);
    this.latePeak.push(nowMs, s.latenessPeakMs);
    this.arrivals.push(nowMs, s.arrivals);
    this.lateWarn.push(nowMs, s.lateWarn);
    this.lateBad.push(nowMs, s.lateBad);
    this.gaps.push(nowMs, s.netGaps);
    this.gapsSevere.push(nowMs, s.netGapsSevere);
    n.rttMs = this.rtt.max();
    n.latenessMs = this.latePeak.max();
    n.gapsPerMin = this.gaps.w.sum();
    // Measure the wait from activation at the earliest, so a stamp left over
    // from before a transit or menu never reads as a wait.
    n.waitMs = Math.max(0, nowMs - Math.max(s.lastSnapshotRecvAtMs, this.activeSinceMs));
    const arrivals = this.arrivals.w.sum();
    this.netWarn = 0; this.netBad = 0; this.netRank = -1;
    this.considerNet('ping', n.rttMs / NET_RTT_WARN_MS, n.rttMs / NET_RTT_BAD_MS);
    this.considerNet('late', tailScore(this.lateWarn.w.sum(), arrivals), tailScore(this.lateBad.w.sum(), arrivals));
    this.considerNet('gaps', n.gapsPerMin / NET_GAPS_WARN_PER_MIN,
      Math.max(n.gapsPerMin / NET_GAPS_BAD_PER_MIN, this.gapsSevere.w.sum()));
    this.considerNet('wait', n.waitMs / NET_WAIT_BAD_MS, n.waitMs / NET_WAIT_BAD_MS);
    this.netGate.update(this.netWarn, this.netBad, nowMs);
    n.shown = this.netGate.shown;
    n.level = this.netGate.level;
  }

  /** Fold one network sub-metric (scores = metric ÷ bound); the cause shown
   *  is the worst one, red before amber. */
  private considerNet(cause: NetCause, warn: number, bad: number): void {
    if (warn > this.netWarn) this.netWarn = warn;
    if (bad > this.netBad) this.netBad = bad;
    const rank = bad >= 1 ? RED_RANK_BOOST + bad : warn;
    if (rank > this.netRank) { this.netRank = rank; this.view.network.cause = cause; }
  }

  private sampleServer(s: NetHealthSample, nowMs: number): void {
    const v = this.view.server;
    this.sendGapPeak.push(nowMs, s.serverSendGapPeakMs);
    v.sendGapMs = this.sendGapPeak.max();
    v.clockRate = s.serverClockRate;
    const deficit = Math.max(0, 1 - s.serverClockRate);
    const warn = Math.max(v.sendGapMs / SERVER_SEND_GAP_MS, deficit / (1 - SERVER_CLOCK_RATE_WARN));
    const bad = Math.max(v.sendGapMs / SERVER_SEND_GAP_BAD_MS, deficit / (1 - SERVER_CLOCK_RATE_BAD));
    this.serverGate.update(warn, bad, nowMs);
    v.shown = this.serverGate.shown;
    v.level = this.serverGate.level;
  }

  private sampleDevice(s: NetHealthSample, nowMs: number): void {
    const v = this.view.device;
    this.hitches.push(nowMs, s.frameHitches);
    this.severe.push(nowMs, s.frameSevereHitches);
    this.longtasks.push(nowMs, s.longtasks);
    v.stallsPerS = Math.max(this.hitches.w.ratePerSecond(), this.longtasks.w.ratePerSecond());
    this.deviceGate.update(v.stallsPerS / DEVICE_STALLS_WARN_PER_S,
      Math.max(v.stallsPerS / DEVICE_STALLS_BAD_PER_S, this.severe.w.sum()), nowMs);
    v.shown = this.deviceGate.shown;
    v.level = this.deviceGate.level;
  }

  reset(): void {
    this.rtt.clear(); this.latePeak.clear(); this.arrivals.clear(); this.lateWarn.clear();
    this.lateBad.clear(); this.gaps.clear(); this.gapsSevere.clear(); this.sendGapPeak.clear();
    this.hitches.clear(); this.severe.clear(); this.longtasks.clear();
    this.corr.clear(); this.droneMiss.clear(); this.droneCount.clear();
    this.netGate.reset(); this.serverGate.reset(); this.deviceGate.reset();
    this.corrGate.reset(); this.droneGate.reset(); this.downGate.reset();
    this.activeSinceMs = -1;
    const v = this.view;
    v.network.shown = false; v.server.shown = false; v.device.shown = false;
    v.corrections.shown = false; v.drones.shown = false; v.link.shown = false;
  }
}

/** Short readout for a duration: "450ms" under a second, "3.2s" above. */
export function formatNetMs(ms: number): string {
  return ms < MS_PER_S ? `${Math.round(ms)}ms` : `${(ms / MS_PER_S).toFixed(1)}s`;
}

/** The network item's readout for its current cause. */
export function networkReadout(n: NetHealthView['network']): string {
  switch (n.cause) {
    case 'ping': return `${Math.round(n.rttMs)}`;
    case 'late': return `+${formatNetMs(n.latenessMs)}`;
    case 'gaps': return `${Math.round(n.gapsPerMin)}/min`;
    case 'wait': return formatNetMs(n.waitMs);
  }
}

/** The server item's readout: the clock rate when dilated, else the send gap. */
export function serverReadout(v: NetHealthView['server']): string {
  return v.clockRate < SERVER_CLOCK_RATE_WARN ? `${Math.round(v.clockRate * 100)}%` : formatNetMs(v.sendGapMs);
}

/** Display key of the view: equal keys mean the cluster need not re-render.
 *  Readouts are rounded so sub-visible changes don't cause renders. */
export function netHealthDisplayKey(v: NetHealthView): string {
  if (!v.network.shown && !v.server.shown && !v.device.shown && !v.corrections.shown && !v.drones.shown && !v.link.shown) return '';
  const n = v.network;
  const sv = v.server;
  return `${n.shown ? `${n.level}${networkReadout(n)}` : '-'}|`
    + `${sv.shown ? `${sv.level}${serverReadout(sv)}` : '-'}|`
    + `${v.device.shown ? `${v.device.level}${Math.round(v.device.stallsPerS)}` : '-'}|`
    + `${v.corrections.shown ? Math.round(v.corrections.perS) : -1}|`
    + `${v.drones.shown ? Math.round(v.drones.perDroneS) : -1}|`
    + `${v.link.shown ? v.link.state : '-'}`;
}
