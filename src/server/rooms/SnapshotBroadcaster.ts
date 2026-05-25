/**
 * Snapshot broadcast state for SectorRoom.
 *
 * Step 11 of the hazy-pillow decomposition plan — relocates the 10
 * broadcast/cadence-tracking fields onto a focused owner.
 *
 * Fields are public readonly (Maps/Sets) or simple primitives with
 * getter/setter accessors so the call sites that read/write them today
 * can continue with a mechanical rename. `simClock` and
 * `lastSentClockRate` move here per the revised plan's "missing owner"
 * call-out: TiDi rate decide → `state.clockRate` write → CLOCK_RATE
 * worker post chain is broadcast-adjacent.
 *
 * Method bodies (per-client snapshot loop, idle-tracker update, swarm
 * encode + send, broadcast-grace short-circuit) remain in SectorRoom
 * for now — they consume shipPoseCache + state.ships + interest grid +
 * PlayerSlotMap + CombatSubsystem.liveProjectiles via direct iteration,
 * and migrating that monolithic block requires careful staging that's
 * beyond the storage-relocation pattern this commit uses.
 */

import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import { createIdleTracker, type IdleTracker, type LastInputCache } from '../net/snapshotScheduler.js';
import type { SimulationClock } from '../../core/clock/SimulationClock.js';

export class SnapshotBroadcaster {
  /** Binary swarm packet encoder. Per-client interest-window encoding
   *  reuses one encoder across all recipients. */
  readonly encoder = new BinarySwarmBroadcast();

  /** Snapshot-cadence counter — incremented once per `update()`.
   *  Drives the per-client phase-staggered broadcast predicate
   *  (`shouldBroadcastFar`). */
  broadcastCounter = 0;

  /** Per-recipient cache of the last `lastInput` bits sent for each
   *  ship. Used by `shouldIncludeLastInput` to omit the field when
   *  bits haven't changed. Keyed by Colyseus sessionId. */
  readonly lastInputCaches = new Map<string, LastInputCache>();

  /** Sector-wide idle tracker. Updated each tick from motion +
   *  projectile-in-flight signals; when no activity in
   *  `IDLE_THRESHOLD_TICKS` consecutive ticks the snapshot block
   *  short-circuits. */
  readonly idleTracker: IdleTracker = createIdleTracker();

  /** Server tick until which snapshot broadcasts are forced ON,
   *  bypassing idle-suppression. Set on every player join / spawn /
   *  rebind — see `JOIN_BROADCAST_GRACE_TICKS`. */
  forceBroadcastUntilTick = 0;

  /** 60-second snapshot-persistence cadence counter (galaxy sectors). */
  ticksSinceSnapshot = 0;

  /** PlayerIds currently holding shift-boost AND thrust. Surfaced on
   *  every snapshot so all clients render an exhaust trail. */
  readonly boostingPlayers = new Set<string>();
  /** PlayerIds currently holding thrust (regardless of boost). Strict
   *  superset of `boostingPlayers`. */
  readonly thrustingPlayers = new Set<string>();

  /** Last TiDi rate value pushed to the worker — gates CLOCK_RATE
   *  postMessages to once per RAMP_PER_TICK step. */
  lastSentClockRate = 1.0;

  /** TiDi simulation clock. Wired in onCreate via setClock(...) because
   *  the clock needs the room-owned `bus` at construction. */
  private _clock: SimulationClock | null = null;

  setClock(clock: SimulationClock): void { this._clock = clock; }

  get clock(): SimulationClock {
    if (this._clock === null) throw new Error('SnapshotBroadcaster: clock not initialised');
    return this._clock;
  }

  /** Extend the broadcast-grace window so a just-joined client gets a
   *  steady stream regardless of motion. Idempotent on `currentTick`. */
  extendGrace(untilTick: number): void {
    if (untilTick > this.forceBroadcastUntilTick) {
      this.forceBroadcastUntilTick = untilTick;
    }
  }
}
