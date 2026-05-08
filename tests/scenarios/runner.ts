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
import type { Event, Observation, SimulatedClientState } from './types';

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
  flags: { recoveryEnabled: boolean; rttClampEnabled: boolean; rttGapFilterEnabled: boolean } = {
    recoveryEnabled: true,
    rttClampEnabled: true,
    rttGapFilterEnabled: true,
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
    const rttSample = flags.rttClampEnabled
      ? Math.min(ev.lastRtt, RTT_SAMPLE_CLAMP_MS)
      : ev.lastRtt;
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
  const observations: Observation[] = [];

  for (const ev of events) {
    let starvationSnapTriggered = false;
    if (ev.type === 'rafTick') {
      applyRafTick(state, ev);
    } else {
      ({ starvationSnapTriggered } = applySnapshot(state, ev, { recoveryEnabled, rttClampEnabled, rttGapFilterEnabled }));
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
