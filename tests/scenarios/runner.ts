/**
 * Scenario runner — Stage 4.5 of the network-feel roadmap.
 *
 * Composes the production pure modules (rttLookaheadUpdater, Welford,
 * lookaheadController, snapshotDropDetector, inputTickRecovery,
 * clockAnchor) into a state machine matching `ColyseusClient.handleSnapshot`
 * and `tickPhysics`, minus physics + DOM + Colyseus surface.
 *
 * The input lead is sized by the client's own `updateRttAndLookahead`
 * from the server's per-input margin (`inputMargin`), which the runner
 * measures with the shared `inputLeadMargin` — never a copy of the
 * formula (`runnerLeadParity.test.ts` locks this).
 *
 * Mirrors the `MAX_CATCH_UP_TICKS` constant from `ColyseusClient.ts`
 * directly — keep it in sync if the production value changes. (Importing
 * it from ColyseusClient would pull in the entire client-side dependency
 * graph including Pixi and Colyseus, which the harness avoids.)
 */
import { createWelford, welfordMean, welfordStdDev } from '../../src/core/math/Welford';
import { createLookaheadController } from '../../src/client/net/lookaheadController';
import { updateRttAndLookahead } from '../../src/client/net/rttLookaheadUpdater';
import { inputLeadMargin } from '../../src/core/physics/inputQueue';
import type { PredictionStats } from '../../src/client/net/predictionStats';
import type { Reconciler } from '../../src/core/prediction/Reconciler';
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
    stats: { rttMeanMs: 0, rttStdDevMs: 0 } as PredictionStats,
    inputTickHistory: [],
  };
}

/** The reconciler is only a null-check in `updateRttAndLookahead` (a
 *  pilot with no reconciler keeps its lead); the harness always has one. */
const RECONCILER_PRESENT = {} as Reconciler;

/** The client's `inputTick` at wall time `atMs` (its claim for an input
 *  sent then), or undefined before the input loop started. */
function inputTickAt(state: SimulatedClientState, atMs: number): number | undefined {
  const h = state.inputTickHistory;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]!.atMs <= atMs) return h[i]!.inputTick;
  }
  return undefined;
}

/** The snapshot's `inputMargin`, measured the way the server does
 *  (`inputLeadMargin`): the claim of the latest input the server held when
 *  it broadcast, minus the broadcast tick. */
export function snapshotInputMargin(
  state: SimulatedClientState,
  ev: Extract<Event, { type: 'snapshot' }>,
): number | undefined {
  if (ev.inputSentAtMs === undefined) return undefined;
  const claimed = inputTickAt(state, ev.inputSentAtMs);
  return claimed === undefined ? undefined : inputLeadMargin(claimed, ev.serverTick);
}

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
  recoveryEnabled = true,
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

  // ── Stage 4 jitter-aware lookahead: the client's own updater ──
  const inputMargin = snapshotInputMargin(state, ev);
  const intervalMs = state.lastSnapshotAtMs >= 0 ? ev.atMs - state.lastSnapshotAtMs : -1;
  state.leadTicks = updateRttAndLookahead(intervalMs, {
    reconciler: RECONCILER_PRESENT,
    stats: state.stats,
    rttWelford: state.rttWelford,
    lookaheadCtrl: state.lookaheadCtrl,
    leadTicks: state.leadTicks,
    lastFrameMs: state.lastFrameMs,
    inputMargin,
    timeScale: 1,
  });
  state.lastSnapshotAtMs = ev.atMs;

  // ── Stage 4 hotfix #2 — inputTick starvation recovery ──
  let starvationSnapTriggered = false;
  if (recoveryEnabled) {
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
  const observations: Observation[] = [];

  for (const ev of events) {
    let starvationSnapTriggered = false;
    if (ev.type === 'rafTick') {
      applyRafTick(state, ev);
    } else {
      ({ starvationSnapTriggered } = applySnapshot(state, ev, recoveryEnabled));
    }
    if (state.anchorInitialised) state.inputTickHistory.push({ atMs: ev.atMs, inputTick: state.inputTick });
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
