/**
 * The pilot's targeting state (owned by `HostileDroneBehaviour`, built once):
 * the hostility state machine, the retaliation ledger, the sticky body pick
 * and the owner's targeting orders (attitude, hold fire, attack order). The
 * brain keeps one-line delegates for its public setters; `tick()` reads and
 * writes these fields in place. Plain fields and two reused collections, so
 * nothing here allocates per tick (#14).
 *
 * `hostileTo` is the SAME Set the brain exposes as its own `hostileTo` field
 * (the WeaponMountTicker duck-reads it) and the `TargetPick` reads.
 */
import { FORGET_TICKS, type DroneState } from '../hostileDroneTuning.js';

export class PilotTargeting {
  // ── Phase 1: hostility / state machine ────────────────────────────────
  /** Behaviour state. Driven by `markHostile`/`purgeHostility` external
   *  events and the time-based forget at the top of `tick()`. */
  state: DroneState = 'IDLE';
  /** Set of player ids the drone is actively hostile toward. Populated
   *  via `markHostile(shooterId, atTick)` from damage events both sides
   *  receive (server `applyDamage`, client `handleDamage`). */
  readonly hostileTo = new Set<string>();
  /** Last server-tick at which each hostile player damaged this drone.
   *  Used to time-decay hostility when a player has been clean for
   *  `FORGET_TICKS` ticks. */
  readonly lastHitByPlayer = new Map<string, number>();
  /** Previously-picked target id, used by `pickTarget` to apply sticky
   *  hysteresis (Phase 4a). Pre-refactor the drone re-picked nearest hostile
   *  every tick, which oscillated between two near-equidistant players. Per-
   *  instance so it's lockstep-safe in the same way `lastHitByPlayer` is —
   *  reset purely by `markHostile`/`purgeHostility`/time-decay, both of
   *  which fire symmetrically on server and client. */
  prevTargetId: string | null = null;
  /** Server tick at which `prevTargetId` was last (re)acquired — drives the
   *  `DRONE_TARGET_DWELL_TICKS` switch-delay in the body target pick. */
  prevTargetSinceTick = 0;
  /** On-sight engagement (RTS Part B slice 6, `setEngageOnSight`): off ⇒ this
   *  ship fights only what is on its retaliation ledger (`hostileTo`), the
   *  Defensive attitude. Drones and robots keep it on. */
  engageOnSight = true;
  /** Hold fire (RTS Part B slice 7, `setHoldFire`): on ⇒ this ship picks no
   *  target at all (no on-sight, no retaliation, no trigger) and keeps flying
   *  its job. `markHostile` still records attackers, so a switch back to
   *  Defensive / Aggressive answers one that hit within `FORGET_TICKS`. */
  holdFire = false;
  /** RTS Part B slice 8 (`setOrderedTarget`): the owner's attack-order target.
   *  On the retaliation ledger (never forgotten while ordered, so a Defensive
   *  ship fights a neutral), `ORDERED_TARGET_PRIORITY` in the pick, and free of
   *  the guard leash and the sensor cap. Null = no order. */
  orderedTargetId: string | null = null;
  /** The ledger tick the order wrote for its target (-1 = none): lifting the
   *  order forgets the mark unless the target hit this ship since. */
  private orderMarkTick = -1;

  constructor(private readonly ownerId: string | null) {}

  /** Record an attacker on the ledger (`markHostile`); false = ignored (none
   *  or this ship's owner). */
  markHostile(shooterId: string, atTick: number): boolean {
    if (!shooterId || shooterId === this.ownerId) return false;
    this.hostileTo.add(shooterId);
    this.lastHitByPlayer.set(shooterId, atTick);
    this.state = 'COMBAT';
    return true;
  }

  /** Drop a player from the ledger (`purgeHostility`). */
  purgeHostility(playerId: string): void {
    if (!playerId) return;
    this.hostileTo.delete(playerId);
    this.lastHitByPlayer.delete(playerId);
    // If the purged player was the sticky target, drop the sticky pin so
    // the next `pickTarget` call doesn't try to keep them.
    if (this.prevTargetId === playerId) this.prevTargetId = null;
    if (this.hostileTo.size === 0) this.state = 'IDLE';
  }

  /** Time-decay: drop hostiles whose last hit aged past FORGET_TICKS (the
   *  ordered target is kept). `tick` is `serverTick` on the server and
   *  `inputTick` on the client. */
  decay(tick: number): void {
    if (this.hostileTo.size > 0) {
      for (const [pid, lastHit] of this.lastHitByPlayer) {
        if (tick - lastHit > FORGET_TICKS && pid !== this.orderedTargetId) {
          this.lastHitByPlayer.delete(pid);
          this.hostileTo.delete(pid);
          // Drop the sticky pin if the decayed player was our target.
          if (this.prevTargetId === pid) this.prevTargetId = null;
        }
      }
      if (this.hostileTo.size === 0) this.state = 'IDLE';
    }
  }

  /** Stand down (the warp-out): forget every hostility. */
  forgetAll(): void {
    this.hostileTo.clear();
    this.lastHitByPlayer.clear();
    this.state = 'IDLE';
    this.prevTargetId = null;
  }

  /** The attack order (`setOrderedTarget`; the brain's doc has the rules). */
  setOrderedTarget(id: string | null, atTick: number): void {
    const next = id === this.ownerId ? null : id;
    const prev = this.orderedTargetId;
    if (next === prev) return;
    if (prev !== null) {
      // Forget the order's ledger mark unless the target hit this ship since.
      if (this.orderMarkTick >= 0 && this.lastHitByPlayer.get(prev) === this.orderMarkTick) {
        this.hostileTo.delete(prev);
        this.lastHitByPlayer.delete(prev);
      }
      if (this.prevTargetId === prev) this.prevTargetId = next;
    }
    this.orderedTargetId = next;
    this.orderMarkTick = -1;
    if (next !== null) {
      this.hostileTo.add(next);
      if (!this.lastHitByPlayer.has(next)) {
        this.lastHitByPlayer.set(next, atTick);
        this.orderMarkTick = atTick;
      }
      this.state = 'COMBAT';
    } else if (this.hostileTo.size === 0) this.state = 'IDLE';
  }
}
