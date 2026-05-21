/**
 * On-device snapshot replay — Phase 1 of perf-floor session 3 (plan:
 * perf-floor). Streams a real diag/captures snapshots.ndjson through
 * the existing `runScenario()` harness in `runner.ts`, producing the
 * same `inputTick`, `ticksAhead`, `leadTicks`, `rttMean`, `rttStdDev`
 * observations the on-device client would have computed.
 *
 * Why this is the PRIMARY regression lock (above the E2E proxy variant):
 *  - Deterministic: same ndjson + same code → byte-identical observations
 *  - Fast: <200 ms per replay; runs in the vitest deterministic suite
 *  - Calibrated: uses the actual on-device load signature (no σ guess)
 *  - Bypasses Playwright / CDP / proxy entirely — falsifies whether the
 *    bug lives in `handleSnapshot` / lookahead math vs renderer / decode
 *    queue / something downstream of the prediction-stat pipeline.
 *
 * Synthesises `rafTick` events between consecutive snapshots at 60 Hz
 * (the same cadence the production client RAFs at). Each snapshot's
 * `data.intervalMs`, `data.ackedTick`, `data.serverTick`, `data.rttMs`,
 * `data.ticksAhead` come directly from the captured ndjson record.
 */
import { runScenario, createInitialClientState } from './runner';
import type { Event } from './types';

interface NdjsonSnapshotRecord {
  source?: string;
  ts?: number;
  tag?: string;
  data?: {
    n?: number;
    serverTick?: number;
    ackedTick?: number;
    ticksAhead?: number;
    intervalMs?: number;
    rttMs?: number;
    driftUnits?: number;
    angleDriftRad?: number;
    maxDriftUnits?: number;
    corrections?: number;
    angleCorrections?: number;
  };
}

export interface ReplayOptions {
  /** Discard observations whose `atMs` is before this offset from the
   *  first snapshot — used to skip the welcome teleport (snap 1's
   *  ticksAhead = 1997 is a one-time reset, not a spiral signature). */
  warmupMs?: number;
  /** Synthesised rafTick interval in ms. Default 1000/60 ≈ 16.67 ms. */
  rafIntervalMs?: number;
}

export interface ReplayStats {
  /** Number of snapshot events processed. */
  snapshotCount: number;
  /** Number of rafTick events synthesised. */
  rafCount: number;
  /** Total observations (snapshot + rafTick) in the post-warmup window. */
  postWarmupObservationCount: number;
  /** Max `ticksAhead` observed in the post-warmup window. */
  maxTicksAhead: number;
  /** Mean `ticksAhead` in the post-warmup window. */
  meanTicksAhead: number;
  /** Max `leadTicks` in the post-warmup window. */
  maxLeadTicks: number;
  /** Final Welford mean of RTT at end of replay. */
  finalRttMean: number;
  /** Final Welford σ of RTT at end of replay. */
  finalRttStdDev: number;
  /** Rolling correction-rate proxy: fraction of snapshots in post-warmup
   *  where `ticksAhead > LERP_RAW_TICKS_THRESHOLD`. Uses 10 ticks (~167 ms)
   *  as the "this would have caused a visible correction" threshold —
   *  same shape as the production stats.rollingCorrRate (which counts
   *  drift events > LERP_THRESHOLD). */
  rollingCorrRateProxy: number;
  /** Number of starvation-recovery snaps in the post-warmup window. */
  starvationSnaps: number;
}

const ROLLING_CORR_TICK_THRESHOLD = 10;

/** Parse an ndjson string into snapshot records. Skips non-snapshot lines
 *  and malformed JSON silently. */
function parseSnapshotNdjson(raw: string): NdjsonSnapshotRecord[] {
  const out: NdjsonSnapshotRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as NdjsonSnapshotRecord;
      if (rec.tag === 'snapshot' && rec.data && typeof rec.ts === 'number') {
        out.push(rec);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Convert parsed snapshot records into an interleaved event timeline:
 *  rafTicks at `rafIntervalMs` cadence between consecutive snapshots,
 *  with the snapshot event appended at its actual `ts`. */
function buildEventTimeline(
  records: NdjsonSnapshotRecord[],
  rafIntervalMs: number,
): Event[] {
  const events: Event[] = [];
  if (records.length === 0) return events;

  let prevTs = records[0]!.ts!;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const ts = rec.ts!;

    // Synthesise rafTicks between prevTs and ts (exclusive of ts).
    // Cap at a reasonable bound so a multi-second gap doesn't generate
    // millions of events — those gaps are the "Pattern A" hitches and
    // would be capped by MAX_CATCH_UP_TICKS=4 in the production loop
    // anyway. 100 rafTicks ≈ 1.67 s wall-clock cap.
    if (i > 0) {
      let t = prevTs + rafIntervalMs;
      let synthesised = 0;
      while (t < ts && synthesised < 100) {
        events.push({ type: 'rafTick', atMs: t, dtMs: rafIntervalMs });
        t += rafIntervalMs;
        synthesised++;
      }
    }

    const d = rec.data!;
    events.push({
      type: 'snapshot',
      atMs: ts,
      serverTick: d.serverTick ?? 0,
      ackedTick: d.ackedTick ?? 0,
      lastRtt: d.rttMs ?? 0,
    });
    prevTs = ts;
  }

  return events;
}

export function replayOndeviceSnapshots(
  ndjsonRaw: string,
  opts: ReplayOptions = {},
): ReplayStats {
  const warmupMs = opts.warmupMs ?? 5_000;
  const rafIntervalMs = opts.rafIntervalMs ?? 1000 / 60;

  const records = parseSnapshotNdjson(ndjsonRaw);
  if (records.length === 0) {
    return {
      snapshotCount: 0,
      rafCount: 0,
      postWarmupObservationCount: 0,
      maxTicksAhead: 0,
      meanTicksAhead: 0,
      maxLeadTicks: 0,
      finalRttMean: 0,
      finalRttStdDev: 0,
      rollingCorrRateProxy: 0,
      starvationSnaps: 0,
    };
  }

  const events = buildEventTimeline(records, rafIntervalMs);
  const snapshotCount = events.filter((e) => e.type === 'snapshot').length;
  const rafCount = events.filter((e) => e.type === 'rafTick').length;

  // The harness seeds `inputTick = ackedTick + leadTicks` on the FIRST
  // snapshot (mirroring welcome behaviour). With ers7xy's snap 1 having
  // ackedTick=0, inputTick starts at ~5 — then the subsequent snap 2 with
  // ackedTick=0 still gives ticksAhead=inputTick. Realistic.
  const initial = createInitialClientState({ leadTicks: 5 });
  const observations = runScenario(events, { initial });

  // Filter to post-warmup window. atMs is in ms-since-scenario-start
  // (the runner uses event.atMs directly, which is the ndjson `ts` field).
  const firstAtMs = records[0]!.ts!;
  const warmupEnd = firstAtMs + warmupMs;
  const postWarmup = observations.filter((o) => o.atMs >= warmupEnd);

  if (postWarmup.length === 0) {
    return {
      snapshotCount,
      rafCount,
      postWarmupObservationCount: 0,
      maxTicksAhead: 0,
      meanTicksAhead: 0,
      maxLeadTicks: 0,
      finalRttMean: observations[observations.length - 1]?.rttMean ?? 0,
      finalRttStdDev: observations[observations.length - 1]?.rttStdDev ?? 0,
      rollingCorrRateProxy: 0,
      starvationSnaps: 0,
    };
  }

  let maxTicksAhead = -Infinity;
  let sumTicksAhead = 0;
  let maxLeadTicks = -Infinity;
  let overThresholdSnaps = 0;
  let totalSnaps = 0;
  let starvationSnaps = 0;
  for (const o of postWarmup) {
    if (o.ticksAhead > maxTicksAhead) maxTicksAhead = o.ticksAhead;
    sumTicksAhead += o.ticksAhead;
    if (o.leadTicks > maxLeadTicks) maxLeadTicks = o.leadTicks;
    if (o.event === 'snapshot') {
      totalSnaps++;
      if (o.ticksAhead > ROLLING_CORR_TICK_THRESHOLD) overThresholdSnaps++;
      if (o.starvationSnapTriggered) starvationSnaps++;
    }
  }

  const last = observations[observations.length - 1]!;
  return {
    snapshotCount,
    rafCount,
    postWarmupObservationCount: postWarmup.length,
    maxTicksAhead,
    meanTicksAhead: sumTicksAhead / postWarmup.length,
    maxLeadTicks,
    finalRttMean: last.rttMean,
    finalRttStdDev: last.rttStdDev,
    rollingCorrRateProxy: totalSnaps > 0 ? overThresholdSnaps / totalSnaps : 0,
    starvationSnaps,
  };
}
