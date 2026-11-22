/**
 * Per-arrival snapshot timing counters (net-health HUD, "whose fault").
 *
 * Fed from the one existing per-arrival hook, `logSnapshotRecvTelemetry`
 * (both transports, before the coalescer, so dropped-by-coalescing frames are
 * still counted), with the arrival time and the server's send stamp
 * (`serverSendPerfNow`, already on every snapshot). Splits a hiccup by clock:
 *
 *   - server send gap: the gap between consecutive SEND stamps, on the
 *     server's own clock, so the network cannot move it. Over
 *     `SERVER_SEND_GAP_MS` = the server itself sent late.
 *   - arrival lateness: one-way delay (recv - send) above its running floor
 *     (the least-delayed path, drifting up slowly), so the unknown clock skew
 *     cancels. Over `ARRIVAL_LATE_WARN_MS` / `_BAD_MS` = the network held it.
 *   - network gap: an arrival gap over `NET_GAP_MS` that the server's send
 *     gap does not explain (arrival gap - send gap over
 *     `NET_GAP_MS - SNAPSHOT_NOMINAL_INTERVAL_MS`).
 *
 * Read-only telemetry like the swarm lateness counters: scalars only, nothing
 * here feeds a pose, delay or clock, and nothing allocates. Counters are
 * cumulative (readers take deltas; a drop reads as a reset). The two peaks
 * are read-and-reset by their single reader, the HUD's 10 Hz sampler.
 */

/** JSON snapshots go out every 3 server ticks at 60 Hz. */
export const SNAPSHOT_NOMINAL_INTERVAL_MS = 50;
/** A consecutive send-stamp gap over this means the server sent late (ms). */
export const SERVER_SEND_GAP_MS = 150;
/** Arrival lateness bounds of the owner's network tiers (p95 Good / Playable, ms). */
export const ARRIVAL_LATE_WARN_MS = 30;
export const ARRIVAL_LATE_BAD_MS = 150;
/** An arrival gap over this is a "gap" in the owner's tiers (ms). */
export const NET_GAP_MS = 200;
/** No Playable link has a gap over this (ms). */
export const NET_GAP_SEVERE_MS = 1000;
/** Per-arrival pull of the delay floor toward a later delay, so a one-off
 *  early packet does not hold every later one "late" for good. */
const DELAY_FLOOR_DRIFT_UP = 0.01;
/** A delay this far above the floor is a new timeline (new server process
 *  after a sector handoff, its own `performance.now()` base): re-seed. */
const DELAY_FLOOR_RESYNC_MS = 5000;

let prevRecvMs = -1;
let prevSendMs = -1;
let delayFloorMs = Number.NaN;

let arrivals = 0;
let lateWarn = 0;
let lateBad = 0;
let netGaps = 0;
let netGapsSevere = 0;
let latenessPeakMs = 0;
let serverSendGapPeakMs = 0;

/** One snapshot arrived at `recvMs` (client `performance.now()` base);
 *  `sendMs` is its server send stamp (server base), absent on old servers. */
export function noteSnapshotArrival(recvMs: number, sendMs: number | undefined): void {
  arrivals++;
  const hasSend = typeof sendMs === 'number' && sendMs > 0;
  const sendGapMs = hasSend && prevSendMs > 0 ? sendMs - prevSendMs : SNAPSHOT_NOMINAL_INTERVAL_MS;
  if (hasSend && prevSendMs > 0 && sendGapMs > 0) {
    if (sendGapMs > serverSendGapPeakMs) serverSendGapPeakMs = sendGapMs;
  }
  if (prevRecvMs >= 0) {
    const recvGapMs = recvMs - prevRecvMs;
    if (recvGapMs > NET_GAP_MS && recvGapMs - sendGapMs > NET_GAP_MS - SNAPSHOT_NOMINAL_INTERVAL_MS) {
      netGaps++;
      if (recvGapMs > NET_GAP_SEVERE_MS) netGapsSevere++;
    }
  }
  if (hasSend) {
    const delayMs = recvMs - sendMs;
    if (Number.isNaN(delayFloorMs) || delayMs - delayFloorMs > DELAY_FLOOR_RESYNC_MS || delayMs < delayFloorMs) {
      delayFloorMs = delayMs;
    } else {
      delayFloorMs += (delayMs - delayFloorMs) * DELAY_FLOOR_DRIFT_UP;
    }
    const lateMs = delayMs - delayFloorMs;
    if (lateMs > latenessPeakMs) latenessPeakMs = lateMs;
    if (lateMs > ARRIVAL_LATE_WARN_MS) lateWarn++;
    if (lateMs > ARRIVAL_LATE_BAD_MS) lateBad++;
    prevSendMs = sendMs;
  }
  prevRecvMs = recvMs;
}

/** Forget the previous arrival and the delay floor (a new room: the welcome
 *  handler), and zero the counters. */
export function resetSnapshotArrivalStats(): void {
  prevRecvMs = -1;
  prevSendMs = -1;
  delayFloorMs = Number.NaN;
  arrivals = 0; lateWarn = 0; lateBad = 0;
  netGaps = 0; netGapsSevere = 0;
  latenessPeakMs = 0; serverSendGapPeakMs = 0;
}

export function getSnapshotArrivalCount(): number { return arrivals; }
/** Arrivals later than `ARRIVAL_LATE_WARN_MS` / `ARRIVAL_LATE_BAD_MS`. */
export function getArrivalLateWarnCount(): number { return lateWarn; }
export function getArrivalLateBadCount(): number { return lateBad; }
/** Network-attributed gaps over `NET_GAP_MS`, and those over `NET_GAP_SEVERE_MS`. */
export function getNetGapCount(): number { return netGaps; }
export function getNetGapSevereCount(): number { return netGapsSevere; }

/** Largest lateness since the last take (ms), then zero it. */
export function takeArrivalLatenessPeakMs(): number {
  const v = latenessPeakMs;
  latenessPeakMs = 0;
  return v;
}

/** Largest consecutive send-stamp gap since the last take (ms), then zero it. */
export function takeServerSendGapPeakMs(): number {
  const v = serverSendGapPeakMs;
  serverSendGapPeakMs = 0;
  return v;
}
