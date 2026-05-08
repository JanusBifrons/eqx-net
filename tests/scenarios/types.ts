/**
 * Scenario harness types — Stage 4.5 of the network-feel roadmap.
 *
 * The harness simulates the client's input-clock state machine through a
 * synthetic timeline of `Event`s. Each event is one of:
 *
 *   - `rafTick` — the client's render loop fires; the input-loop step
 *     advances `inputTick` toward the wall-clock-anchored `targetTick`,
 *     bounded by `MAX_CATCH_UP_TICKS`.
 *   - `snapshot` — the server's snapshot arrives at the client; the
 *     handler updates `clockAnchor`, pushes RTT into Welford, recomputes
 *     `leadTicks` via the lookahead controller, runs starvation recovery,
 *     and observes drop-detection.
 *
 * The harness uses the **real production pure modules** (`Welford`,
 * `lookaheadController`, `snapshotDropDetector`, `inputTickRecovery`,
 * `clockAnchor`). It does NOT simulate Rapier physics — the focus is the
 * input-clock and prediction-window state, which is where every Stage
 * 0–4 emergent bug lived.
 *
 * Each scenario returns an array of `Observation`s — one per event step —
 * which can be asserted against using the helpers in `assertions.ts`.
 */
import type { WelfordState } from '../../src/core/math/Welford';
import type { LookaheadController } from '../../src/client/net/lookaheadController';
import type { DropDetector } from '../../src/client/net/snapshotDropDetector';

/** A single event in the simulated timeline. */
export type Event =
  | {
      type: 'rafTick';
      /** Wall-clock time of the rafTick fire (ms since scenario start). */
      atMs: number;
      /** Per-frame delta passed to the input loop's spring stepper.
       *  Typically the difference between successive rafTicks. */
      dtMs: number;
    }
  | {
      type: 'snapshot';
      /** Wall-clock time the snapshot arrives at the client. */
      atMs: number;
      /** Server's tick at the moment it broadcast the snapshot. */
      serverTick: number;
      /** Server's view of the latest client input tick it has applied
       *  (with `inputQueue.ts` held-ack-advance synthesis included).
       *  Advances at the server's tick rate regardless of how fast the
       *  client actually sends inputs. */
      ackedTick: number;
      /** The value `Reconciler.lastRtt` would compute for this snapshot —
       *  i.e. (atMs - the_send_time_of_the_input_being_acked). May be
       *  contaminated by snapshot-delay during a network gap. */
      lastRtt: number;
    };

/** Snapshot of the client clock state after each event step. */
export interface Observation {
  atMs: number;
  /** Which event triggered this observation. */
  event: Event['type'];
  inputTick: number;
  ackedTick: number;
  /** `inputTick - ackedTick`. The Stage 4 hotfix #2 property:
   *  this should never go negative under any scenario the harness can
   *  generate (slow rafTick, long gaps, server burst-recovery). */
  ticksAhead: number;
  leadTicks: number;
  rttMean: number;
  rttStdDev: number;
  droppedSnapshotsRecent: number;
  /** Whether the starvation recovery snapped this tick. Useful for asserting
   *  the recovery fired only when expected. */
  starvationSnapTriggered: boolean;
}

export interface SimulatedClientState {
  inputTick: number;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  /** Set true after the first snapshot — until then `clockAnchor` runs
   *  the initial-snap path rather than the EWMA path. */
  anchorInitialised: boolean;
  rttWelford: WelfordState;
  lookaheadCtrl: LookaheadController;
  dropDetector: DropDetector;
  leadTicks: number;
  lastFrameMs: number;
}
