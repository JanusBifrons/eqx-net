/**
 * Phone-lane frame-time summary (docs/ops/phone-link.md "Play evidence").
 *
 * Lane builds only (`VITE_PHONE_LANE=1`, with streaming autocapture on, so
 * never under automation or `?autocapture=0`): every processed frame's gap goes
 * into a `FrameTimeRing` (`recordLaneFrame`, called from
 * `RafStallDetector.detectGap`; one null check when off, an alloc-free push
 * when on). Every 10 s a timer, off the frame loop, logs one `perf_summary`
 * event: it rides the existing streaming capture (`streamingDiag.ts`) to the
 * server, which writes it to the session's `frames.ndjson`
 * (`diagRouter.ts` BUCKETS). Numbers only: no ids, names or positions.
 */
import type { IRenderer } from '@core/contracts/IRenderer';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import { isAutoCaptureEnabled, logEvent } from '../ClientLogger';
import { getGameClient } from '../../net/clientSingleton';
import type { PredictionStats } from '../../net/predictionStats';
import type { ControlMode } from '../../state/storeTypes';
import { applyLanePhases, installLanePhaseTiming, rollLanePhases } from './lanePhaseTiming';
import { getActiveSnapshotTransport } from '../../net/connection/roomConnection.js';
import {
  getSwarmLatenessLastMs, getSwarmLatenessMaxMs, getSwarmLatenessSumMs, getSwarmLatenessCount,
  getSwarmOverwriteUnreadCount, getSwarmOldEndClampCount, getSwarmGlideLimitCount,
} from '../../net/swarmInterpolation.js';
import { getAnchorHardSnapCount } from '../../net/clockAnchor.js';
import { getRenderDueSnapCount } from '../../net/renderTickPhase.js';

export const LANE_SUMMARY_INTERVAL_MS = 10_000;
/** A frame over this is a hitch the player sees (3+ refreshes at 60 Hz). */
export const LANE_HITCH_MS = 50;

export interface LaneSummaryInputs {
  windowMs: number;
  /** The camera's larger half-extent of the visible world (game units): the zoom. */
  viewHalf: number | null;
  counts: { ships: number; drones: number; structures: number; projectiles: number } | null;
  net: Pick<PredictionStats, 'rttMs' | 'rttMeanMs' | 'snapshotJitterMs' | 'significantCorrectionCount' | 'rollingCorrRate' | 'maxDriftUnits'> | null;
  /** `significantCorrectionCount` at the previous summary. */
  correctionsBefore: number;
  /** Netcode gap counters (S0); absent in callers that predate them. */
  gap?: LaneNetGapCounters;
}

/**
 * Netcode gap counters (gap-smoothing plan S0). Running values since the last
 * reset (rejoin / sector handoff), not per window. Optional on the summary: a
 * `perf_summary` written before them still reads; `null` = no source.
 */
export interface LaneNetGapCounters {
  /** `performance.now()` the last DataChannel frame truly arrived (same base as the line's `ts`). */
  dcLastArrivalMs?: number | null;
  /** DataChannel frames replaced unread before the last drain. */
  dcLastDrainReplaced?: number | null;
  /** DataChannel frames replaced unread, running total. */
  dcReplacedTotal?: number | null;
  /** How late drone (swarm) packets arrived after their tick stamp, ms: last, max, sum, count. */
  swarmLateLastMs?: number | null;
  swarmLateMaxMs?: number | null;
  swarmLateSumMs?: number | null;
  swarmLateCount?: number | null;
  /** Drone ring slots overwritten while still newer than the read point. */
  swarmOverwriteUnread?: number | null;
  /** Drone reads that fell before the oldest pose of a full ring. */
  swarmOldEndClamp?: number | null;
  /** Drone reads frozen at the glide (extrapolation) limit, per drone per frame. */
  swarmGlideLimit?: number | null;
  /** Clock anchor hard snaps (drift over 200 ms). */
  anchorHardSnaps?: number | null;
  /** Render due-time snaps (gap over 200 ms). */
  renderDueSnaps?: number | null;
}

export interface LanePerfSummary extends LaneNetGapCounters {
  windowMs: number;
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  /** Frames over `LANE_HITCH_MS`. */
  hitches: number;
  viewHalf: number | null;
  ships: number | null;
  drones: number | null;
  structures: number | null;
  projectiles: number | null;
  rttMs: number | null;
  rttMeanMs: number | null;
  jitterMs: number | null;
  /** Local-ship reconciliation corrections (drift > 0.05 u) in this window. */
  corrections: number | null;
  corrRate: number | null;
  /** Largest single correction this session (game units). */
  maxDrift: number | null;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function buildLanePerfSummary(ring: FrameTimeRing, inp: LaneSummaryInputs): LanePerfSummary {
  const f = ring.summary(undefined, LANE_HITCH_MS);
  const n = inp.net;
  const c = inp.counts;
  const corrNow = n?.significantCorrectionCount ?? 0;
  return {
    windowMs: Math.round(inp.windowMs),
    frames: f.frames, p50: f.p50, p95: f.p95, p99: f.p99, maxMs: f.max, hitches: f.hitches,
    viewHalf: inp.viewHalf === null ? null : Math.round(inp.viewHalf),
    ships: c?.ships ?? null, drones: c?.drones ?? null, structures: c?.structures ?? null, projectiles: c?.projectiles ?? null,
    rttMs: n ? Math.round(n.rttMs) : null,
    rttMeanMs: n ? r1(n.rttMeanMs) : null,
    jitterMs: n ? r1(n.snapshotJitterMs) : null,
    // A new client (remount) restarts the counter: count from zero then.
    corrections: n ? (corrNow >= inp.correctionsBefore ? corrNow - inp.correctionsBefore : corrNow) : null,
    corrRate: n ? r2(n.rollingCorrRate) : null,
    maxDrift: n ? r2(n.maxDriftUnits) : null,
    ...inp.gap,
  };
}

/** Sample the S0 netcode gap counters (10 s timer only, never per frame). */
export function readLaneNetGapCounters(): LaneNetGapCounters {
  const dc = getActiveSnapshotTransport();
  return {
    dcLastArrivalMs: dc ? r1(dc.lastArrivalMs()) : null,
    dcLastDrainReplaced: dc ? dc.lastDrainReplacedCount() : null,
    dcReplacedTotal: dc ? dc.totalReplacedCount() : null,
    swarmLateLastMs: r1(getSwarmLatenessLastMs()),
    swarmLateMaxMs: r1(getSwarmLatenessMaxMs()),
    swarmLateSumMs: r1(getSwarmLatenessSumMs()),
    swarmLateCount: getSwarmLatenessCount(),
    swarmOverwriteUnread: getSwarmOverwriteUnreadCount(),
    swarmOldEndClamp: getSwarmOldEndClampCount(),
    swarmGlideLimit: getSwarmGlideLimitCount(),
    anchorHardSnaps: getAnchorHardSnapCount(),
    renderDueSnaps: getRenderDueSnapCount(),
  };
}

/** The player-facing control mode (`selectControlMode`). */
export type LaneControlMode = ControlMode;

/**
 * Stamp a stall event's data (`raf_stutter`, `raf_gap`, `loaf`) with the zoom
 * (`viewHalf`, as in `perf_summary`) and the control mode at the moment it
 * fired, so a capture shows whether zooming out or command view goes with the
 * stalls. Mutates and returns `data`: no extra object.
 */
export function applyLaneStallContext<T extends object>(data: T, viewHalf: number | null | undefined, mode: LaneControlMode | null): T {
  const d = data as Record<string, unknown>;
  d['viewHalf'] = typeof viewHalf === 'number' && viewHalf > 0 ? Math.round(viewHalf) : null;
  d['mode'] = mode;
  return data;
}

let ring: FrameTimeRing | null = null;
let renderer: IRenderer | null = null;
let readMode: (() => LaneControlMode) | null = null;

/**
 * Lane builds: add zoom + control mode to a stall event's data. Called only
 * when a stall event fires (never per frame); off the lane, one null check.
 */
export function withLaneStallContext<T extends object>(data: T): T {
  if (ring === null) return data;
  // ...and the last stall frame's phase breakdown (lanePhaseTiming.ts).
  return applyLanePhases(applyLaneStallContext(data, renderer?.getFeedback().viewHalf, readMode?.() ?? null));
}

/** One processed frame's gap (ms). Hot path: a null check when off. */
export function recordLaneFrame(ms: number): void {
  if (ring !== null) { ring.push(ms); rollLanePhases(ms); }
}

export function lanePerfSummaryEnabled(): boolean {
  return import.meta.env['VITE_PHONE_LANE'] === '1' && isAutoCaptureEnabled();
}

/** Start the 10 s summaries (lane builds only). A remounted game surface re-points the renderer. */
export function installLanePerfSummary(rendererIn: IRenderer, controlMode: () => LaneControlMode): void {
  renderer = rendererIn;
  readMode = controlMode;
  if (ring !== null || !lanePerfSummaryEnabled()) return;
  const frames = (ring = new FrameTimeRing(4096));
  installLanePhaseTiming();
  // Real time: frame timing is wall time
  let windowStart = performance.now();
  let correctionsBefore = 0;
  // Real time: a wall-clock diagnostics cadence
  setInterval(() => {
    const client = getGameClient();
    const m = client?.mirror;
    const fb = renderer?.getFeedback();
    // Real time: frame timing is wall time
    const now = performance.now();
    const summary = buildLanePerfSummary(frames, {
      windowMs: now - windowStart,
      viewHalf: fb && fb.viewHalf > 0 ? fb.viewHalf : null,
      counts: m ? { ships: m.ships.size, drones: m.swarm?.size ?? 0, structures: m.structures?.size ?? 0, projectiles: m.projectiles?.size ?? 0 } : null,
      net: client?.stats ?? null,
      correctionsBefore,
      gap: readLaneNetGapCounters(),
    });
    correctionsBefore = client?.stats.significantCorrectionCount ?? 0;
    frames.reset();
    windowStart = now;
    logEvent('perf_summary', summary as unknown as Record<string, unknown>);
  }, LANE_SUMMARY_INTERVAL_MS);
}
