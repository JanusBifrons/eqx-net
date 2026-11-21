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
import type { Event, Observation, SimulatedClientState } from './types';

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
