/**
 * Scenario runner — Stage 4.5 of the network-feel roadmap.
 *
 * Composes the production pure modules (Welford, lookaheadController,
 * snapshotDropDetector, inputTickRecovery, clockAnchor) into a state
 * machine matching `ColyseusClient.handleSnapshot` and `tickPhysics`,
 * minus physics + DOM + Colyseus surface.
 *
 * Mirrors the `MAX_CATCH_UP_TICKS` and `RTT_SAMPLE_CLAMP_MS` constants
 * from `ColyseusClient.ts` directly — keep these in sync if the
 * production values change. (Importing them from ColyseusClient would
 * pull in the entire client-side dependency graph including Pixi and
 * Colyseus, which the scenario harness is intentionally avoiding.)
 */
import { createWelford, welfordPush, welfordMean, welfordStdDev } from '../../src/core/math/Welford';
import { createLookaheadController, computeDesiredLead, updateLookahead } from '../../src/client/net/lookaheadController';
import { createDropDetector, observeSnapshotTick } from '../../src/client/net/snapshotDropDetector';
import { recoverInputTickFromStarvation } from '../../src/client/net/inputTickRecovery';
import { updateAnchor, CLOCK_ANCHOR_HARD_SNAP_MS } from '../../src/client/net/clockAnchor';
import type {
  Delivery,
  Event,
  GapSpec,
  JitterSpec,
  NetStream,
  NetworkProfile,
  Observation,
  SimulatedClientState,
} from './types';

/** Mirrors `ColyseusClient.tickPhysics` MAX_CATCH_UP_TICKS. */
const MAX_CATCH_UP_TICKS = 4;
/** Mirrors `ColyseusClient.handleSnapshot` RTT_SAMPLE_CLAMP_MS (Stage 4 hotfix #1). */
const RTT_SAMPLE_CLAMP_MS = 250;
/** Physics fixed-step. */
const FIXED_MS = 1000 / 60;

export function createInitialClientState(opts?: {
  inputTick?: number;
  leadTicks?: number;
}): SimulatedClientState {
  const initialLead = opts?.leadTicks ?? 5;
  return {
    inputTick: opts?.inputTick ?? 0,
    clockAnchorServerTick: 0,
    clockAnchorPerfNow: 0,
    anchorInitialised: false,
    rttWelford: createWelford(),
    lookaheadCtrl: createLookaheadController(initialLead),
    dropDetector: createDropDetector(),
    leadTicks: initialLead,
    lastFrameMs: 16.67,
    lastSnapshotAtMs: -1,
  };
}

/** Steady-state snapshot cadence band (ms). Server broadcasts every 3
 *  server ticks at 60 Hz physics = 50 ms nominal. Real-world wall-clock
 *  jitter pushes this to roughly 35–75 ms range. Outside that range,
 *  the snapshot is part of a Pattern A gap (huge interval) or a
 *  burst-recovery cluster (tiny interval) — its `lastRtt` is
 *  contaminated by snapshot-delay and shouldn't be pushed into Welford.
 *  Hotfix #3 (2026-05-08 third diagnostic). */
const STEADY_STATE_INTERVAL_MIN_MS = 35;
const STEADY_STATE_INTERVAL_MAX_MS = 75;

/**
 * Process a single rafTick event. Mirrors `ColyseusClient.tickPhysics`'s
 * input-loop logic — advance `inputTick` toward the wall-clock-anchored
 * `targetTick`, bounded by `MAX_CATCH_UP_TICKS`.
 */
function applyRafTick(
  state: SimulatedClientState,
  ev: Extract<Event, { type: 'rafTick' }>,
): void {
  state.lastFrameMs = ev.dtMs;
  if (!state.anchorInitialised) {
    // No snapshot yet — input loop hasn't been initialised. Skip the
    // tickPhysics body but record lastFrameMs.
    return;
  }
  const ticksSinceAnchor = Math.floor((ev.atMs - state.clockAnchorPerfNow) / FIXED_MS);
  const targetTick = state.clockAnchorServerTick + ticksSinceAnchor + state.leadTicks;
  let stepsThisFrame = 0;
  while (state.inputTick < targetTick && stepsThisFrame < MAX_CATCH_UP_TICKS) {
    state.inputTick++;
    stepsThisFrame++;
  }
}

/**
 * Process a snapshot arrival. Mirrors `ColyseusClient.handleSnapshot`'s
 * pre-reconcile logic — clockAnchor update, RTT into Welford, lookahead
 * recompute, starvation recovery, drop detection. Skips reconcile/replay
 * (no physics in the harness).
 */
function applySnapshot(
  state: SimulatedClientState,
  ev: Extract<Event, { type: 'snapshot' }>,
  flags: {
    recoveryEnabled: boolean;
    rttClampEnabled: boolean;
    rttGapFilterEnabled: boolean;
    rttLeadSubtractEnabled: boolean;
  } = {
    recoveryEnabled: true,
    rttClampEnabled: true,
    rttGapFilterEnabled: true,
    rttLeadSubtractEnabled: true,
  },
): { starvationSnapTriggered: boolean } {
  // ── clockAnchor update (mirrors ColyseusClient.handleSnapshot lines around 1004) ──
  if (state.anchorInitialised) {
    const next = updateAnchor(
      { anchorServerTick: state.clockAnchorServerTick, anchorPerfNow: state.clockAnchorPerfNow },
      ev.serverTick,
      ev.atMs,
    );
    state.clockAnchorServerTick = next.anchorServerTick;
    state.clockAnchorPerfNow = next.anchorPerfNow;
  } else {
    state.clockAnchorServerTick = ev.serverTick;
    state.clockAnchorPerfNow = ev.atMs;
    state.anchorInitialised = true;
    // First snapshot — seed inputTick at `ackedTick + leadTicks` so the
    // input loop starts ahead of the server (mirrors the welcome handshake's
    // behaviour, where the client immediately runs leadTicks ahead). Seeding
    // at `ackedTick` would trigger the starvation recovery on the very first
    // snapshot via the boundary-equals case (`inputTick === ackedTick`).
    state.inputTick = ev.ackedTick + state.leadTicks;
  }

  // ── Stage 4 drop detection (independent signal, used for swarm-interp bias) ──
  observeSnapshotTick(state.dropDetector, ev.serverTick);

  // ── Stage 4 jitter-aware lookahead ──
  // Hotfix #3: skip the Welford push if this snapshot's `intervalMs`
  // is outside the steady-state cadence band [35, 75] ms. Snapshots
  // outside this band are part of a Pattern A gap (intervalMs >> 50)
  // or a burst-recovery cluster (intervalMs << 50) — their `lastRtt`
  // is contaminated because Reconciler.lastRtt = now - ackedRec.sentAt
  // for an input sent before the gap. Even when the σ-clamp from
  // hotfix #1 caps the sample, it still inflates the running mean.
  // Skipping these samples altogether keeps Welford's mean tracking
  // the actual steady-state RTT, which keeps leadTicks sized for
  // steady-state network — critical for combat where collision drift
  // scales with leadTicks × velocity-change-per-tick.
  const intervalMs = state.lastSnapshotAtMs >= 0 ? ev.atMs - state.lastSnapshotAtMs : -1;
  const isGapRelated =
    intervalMs > 0 &&
    (intervalMs < STEADY_STATE_INTERVAL_MIN_MS || intervalMs > STEADY_STATE_INTERVAL_MAX_MS);
  if (ev.lastRtt > 0 && (!flags.rttGapFilterEnabled || !isGapRelated)) {
    // Stage 4 hotfix #5 — strip the gate-induced server-side hold time
    // from the RTT sample before pushing. See ColyseusClient.handleSnapshot
    // for the full rationale; the short version is that the input-queue
    // gate (`tickInputQueue`) holds each input claim X for ~leadTicks
    // ticks, which is included in `Reconciler.lastRtt` and creates a
    // positive feedback loop on welford → leadTicks if pushed raw.
    const rttForWelford = flags.rttLeadSubtractEnabled
      ? Math.max(0, ev.lastRtt - state.leadTicks * FIXED_MS)
      : ev.lastRtt;
    const rttSample = flags.rttClampEnabled
      ? Math.min(rttForWelford, RTT_SAMPLE_CLAMP_MS)
      : rttForWelford;
    welfordPush(state.rttWelford, rttSample);
    const mean = welfordMean(state.rttWelford);
    const stdDev = welfordStdDev(state.rttWelford);
    const desiredLead = computeDesiredLead(mean, stdDev);
    state.leadTicks = updateLookahead(state.lookaheadCtrl, desiredLead, state.lastFrameMs);
  }
  state.lastSnapshotAtMs = ev.atMs;

  // ── Stage 4 hotfix #2 — inputTick starvation recovery ──
  let starvationSnapTriggered = false;
  if (flags.recoveryEnabled) {
    const recovered = recoverInputTickFromStarvation(state.inputTick, ev.ackedTick, state.leadTicks);
    if (recovered !== state.inputTick) {
      state.inputTick = recovered;
      state.clockAnchorServerTick = ev.serverTick;
      state.clockAnchorPerfNow = ev.atMs;
      starvationSnapTriggered = true;
    }
  }

  return { starvationSnapTriggered };
}

export interface RunOptions {
  /** Initial state. Default: createInitialClientState(). */
  initial?: SimulatedClientState;
  /** When false, the runner bypasses `recoverInputTickFromStarvation`
   *  on snapshot — used for the regression-demonstration tests in
   *  `regressions.test.ts` that prove the bug reproduces without the
   *  hotfix. Default true (production behaviour). */
  starvationRecoveryEnabled?: boolean;
  /** When false, the runner bypasses the RTT_SAMPLE_CLAMP_MS clamp on
   *  Welford-pushed RTT samples — same TDD demonstration purpose for
   *  hotfix #1. Default true. */
  rttClampEnabled?: boolean;
  /** When false, the runner pushes RTT samples even on snapshots that
   *  are part of a Pattern A gap or burst-recovery (drops detected in
   *  the recent window). Hotfix #3 demonstration flag. Default true:
   *  production gates the Welford push on `dropDetector.dropCount === 0`
   *  so gap-related samples never contaminate the running mean. */
  rttGapFilterEnabled?: boolean;
  /** When false, the runner pushes raw `lastRtt` into Welford without
   *  subtracting `leadTicks × FIXED_MS`. Hotfix #5 (2026-05-09)
   *  demonstration flag. Default true: production subtracts the gate-
   *  induced server-side hold from the sample so welford tracks
   *  network-only RTT and the gate doesn't create a positive-feedback
   *  loop on the lookahead controller. */
  rttLeadSubtractEnabled?: boolean;
}

/**
 * Run the scenario through the simulated client. Returns one observation
 * per event, in event order. Events are processed atomically and their
 * effects are visible in the next observation.
 */
export function runScenario(
  events: Event[],
  opts: RunOptions = {},
): Observation[] {
  const state = opts.initial ?? createInitialClientState();
  const recoveryEnabled = opts.starvationRecoveryEnabled !== false;
  const rttClampEnabled = opts.rttClampEnabled !== false;
  const rttGapFilterEnabled = opts.rttGapFilterEnabled !== false;
  const rttLeadSubtractEnabled = opts.rttLeadSubtractEnabled !== false;
  const observations: Observation[] = [];

  for (const ev of events) {
    let starvationSnapTriggered = false;
    if (ev.type === 'rafTick') {
      applyRafTick(state, ev);
    } else {
      ({ starvationSnapTriggered } = applySnapshot(state, ev, { recoveryEnabled, rttClampEnabled, rttGapFilterEnabled, rttLeadSubtractEnabled }));
    }
    observations.push({
      atMs: ev.atMs,
      event: ev.type,
      inputTick: state.inputTick,
      ackedTick: ev.type === 'snapshot' ? ev.ackedTick : observations[observations.length - 1]?.ackedTick ?? 0,
      ticksAhead: state.inputTick - (ev.type === 'snapshot' ? ev.ackedTick : observations[observations.length - 1]?.ackedTick ?? 0),
      leadTicks: state.leadTicks,
      rttMean: welfordMean(state.rttWelford),
      rttStdDev: welfordStdDev(state.rttWelford),
      droppedSnapshotsRecent: state.dropDetector.dropCount,
      starvationSnapTriggered,
    });
  }

  return observations;
}

// Re-export for assertion modules.
export { CLOCK_ANCHOR_HARD_SNAP_MS };

// ── Network model: gaps, bursts, jitter and frame stalls ─────────────────
//
// Models the real transport: both streams are reliable and ordered, so a
// stall holds every packet sent during it and releases them together, in
// send order, when it ends. Pure and seeded: no timers, same profile +
// duration → same delivery list.

/** Server sends one JSON snapshot every this many ticks; drone packets every tick. */
const JSON_EVERY_TICKS = 3;
/** Mirrors scenarios.ts — the tick numbering the existing fixtures use. */
const NET_START_SERVER_TICK = 100;
const NET_START_INPUT_TICK = 100;
/** Fraction of jitter draws that land in a burst (packets arriving bunched
 *  after a late one). Chosen so the long-run mean gap stays near the 50 ms
 *  send cadence while p50/p95/p99 match the profile. */
const JITTER_BURST_FRACTION = 0.36;
const JITTER_BURST_GAP_MS = 2;
const JITTER_BURST_EDGE_FRACTION = 0.03;
const JITTER_FLOOR_GAP_FRACTION = 0.77;
const JITTER_MAX_GAP_FACTOR = 1.2;
/** Cap on accumulated link lag, as a multiple of the p99 gap. */
const JITTER_MAX_LAG_FACTOR = 2;
/** Float tolerance so the frame landing exactly on `durationMs` is kept. */
const FRAME_EPSILON_MS = 1e-6;
const MS_PER_SECOND = 1000;
const TICK_HZ = 60;

/** mulberry32 — small seeded PRNG, uniform in [0, 1). */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Piecewise-linear quantile function for a JSON inter-arrival gap. */
function jitterGapQuantile(j: JitterSpec, u: number): number {
  const pts: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [JITTER_BURST_FRACTION, JITTER_BURST_GAP_MS],
    [JITTER_BURST_FRACTION + JITTER_BURST_EDGE_FRACTION, j.gapP50Ms * JITTER_FLOOR_GAP_FRACTION],
    [0.5, j.gapP50Ms],
    [0.95, j.gapP95Ms],
    [0.99, j.gapP99Ms],
    [1, j.gapP99Ms * JITTER_MAX_GAP_FACTOR],
  ];
  let prev: readonly [number, number] = [0, 0];
  for (const pt of pts) {
    const [u1, v1] = pt;
    if (u <= u1 && u1 > prev[0]) {
      const [u0, v0] = prev;
      return v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
    }
    prev = pt;
  }
  return prev[1];
}

/**
 * Link lag (ms, on top of the base delay) per JSON send slot. Shared by
 * both streams, since they ride the same connection. Each slot's arrival
 * is the previous arrival plus a drawn gap; lag stays in [0, 2 × p99].
 */
function buildJitterLag(j: JitterSpec | undefined, slots: number, slotMs: number, seed: number): number[] {
  const lag = new Array<number>(slots).fill(0);
  if (!j) return lag;
  const rand = createSeededRandom(seed);
  let prev = 0;
  for (let k = 1; k < slots; k++) {
    prev = Math.min(j.gapP99Ms * JITTER_MAX_LAG_FACTOR, Math.max(0, prev - slotMs + jitterGapQuantile(j, rand())));
    lag[k] = prev;
  }
  return lag;
}

function gapCovers(g: GapSpec, stream: NetStream, sendMs: number): boolean {
  const s = g.streams ?? 'both';
  return (s === 'both' || s === stream) && sendMs >= g.atMs && sendMs < g.atMs + g.durationMs;
}

/**
 * Every packet the server sends in `[0, durationMs]` on both streams, with
 * the time the client receives it. Packets arriving after `durationMs`
 * are dropped (matching scenarios.ts). Sorted by arrival; ties keep send
 * order, JSON before drone on the same tick.
 */
export function buildDeliveries(profile: NetworkProfile, durationMs: number): Delivery[] {
  const lastTick = Math.floor(durationMs / FIXED_MS + FRAME_EPSILON_MS);
  const slots = Math.floor(lastTick / JSON_EVERY_TICKS) + 1;
  const lag = buildJitterLag(profile.jitter, slots, JSON_EVERY_TICKS * FIXED_MS, profile.seed);
  const out: Delivery[] = [];
  const lastArrive: Record<NetStream, number> = { json: -Infinity, swarm: -Infinity };
  const seq: Record<NetStream, number> = { json: 0, swarm: 0 };
  const streams: ReadonlyArray<NetStream> = ['json', 'swarm'];
  for (let i = 0; i <= lastTick; i++) {
    const sendMs = (i * MS_PER_SECOND) / TICK_HZ; // exact on whole-ms ticks
    for (const stream of streams) {
      if (stream === 'json' && i % JSON_EVERY_TICKS !== 0) continue;
      let arriveMs = sendMs + profile.baseDelayMs + (lag[Math.floor(i / JSON_EVERY_TICKS)] ?? 0);
      for (const g of profile.gaps) {
        if (gapCovers(g, stream, sendMs)) arriveMs = Math.max(arriveMs, g.atMs + g.durationMs + profile.baseDelayMs);
      }
      arriveMs = Math.max(arriveMs, lastArrive[stream]); // reliable + ordered
      lastArrive[stream] = arriveMs;
      const d: Delivery = { stream, seq: seq[stream]++, serverTick: NET_START_SERVER_TICK + i, sendMs, arriveMs };
      if (arriveMs <= durationMs) out.push(d);
    }
  }
  out.sort((a, b) => a.arriveMs - b.arriveMs || a.sendMs - b.sendMs || (a.stream === 'json' ? -1 : 1) - (b.stream === 'json' ? -1 : 1));
  return out;
}

/** Client frame times at 60 frames/s with the profile's frame stalls: no
 *  frame fires inside a stall; the next one fires at its end. */
export function buildFrameTimes(profile: NetworkProfile, durationMs: number): number[] {
  const out: number[] = [];
  // origin + n × FIXED_MS (not repeated addition) so frame counts are exact.
  let origin = 0;
  let n = 1;
  for (;;) {
    let t = origin + n * FIXED_MS;
    const stall = profile.frameStalls.find((s) => t >= s.atMs && t < s.atMs + s.durationMs);
    if (stall) {
      origin = stall.atMs + stall.durationMs;
      n = 0;
      t = origin;
    }
    if (t > durationMs + FRAME_EPSILON_MS) break;
    out.push(t);
    n++;
  }
  return out;
}

/** The profile as `runScenario` events: one rafTick per frame and one
 *  snapshot per delivered JSON packet (ack and lastRtt as scenarios.ts). */
export function buildNetworkEvents(profile: NetworkProfile, durationMs: number): Event[] {
  const events: Event[] = [];
  let prev = 0;
  for (const t of buildFrameTimes(profile, durationMs)) {
    events.push({ type: 'rafTick', atMs: t, dtMs: t - prev });
    prev = t;
  }
  for (const d of buildDeliveries(profile, durationMs)) {
    if (d.stream !== 'json') continue;
    events.push({
      type: 'snapshot',
      atMs: d.arriveMs,
      serverTick: d.serverTick,
      ackedTick: NET_START_INPUT_TICK + (d.serverTick - NET_START_SERVER_TICK) - 1,
      lastRtt: d.arriveMs - d.sendMs,
    });
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}
