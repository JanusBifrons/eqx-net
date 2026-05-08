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
  };
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
  flags: { recoveryEnabled: boolean; rttClampEnabled: boolean } = { recoveryEnabled: true, rttClampEnabled: true },
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

  // ── Stage 4 jitter-aware lookahead (with hotfix #1 RTT clamp) ──
  if (ev.lastRtt > 0) {
    const rttSample = flags.rttClampEnabled
      ? Math.min(ev.lastRtt, RTT_SAMPLE_CLAMP_MS)
      : ev.lastRtt;
    welfordPush(state.rttWelford, rttSample);
    const mean = welfordMean(state.rttWelford);
    const stdDev = welfordStdDev(state.rttWelford);
    const desiredLead = computeDesiredLead(mean, stdDev);
    state.leadTicks = updateLookahead(state.lookaheadCtrl, desiredLead, state.lastFrameMs);
  }

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

  // ── Stage 4 drop detection ──
  observeSnapshotTick(state.dropDetector, ev.serverTick);

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
  const observations: Observation[] = [];

  for (const ev of events) {
    let starvationSnapTriggered = false;
    if (ev.type === 'rafTick') {
      applyRafTick(state, ev);
    } else {
      ({ starvationSnapTriggered } = applySnapshot(state, ev, { recoveryEnabled, rttClampEnabled }));
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
