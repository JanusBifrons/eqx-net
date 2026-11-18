import type { AiEntity, AiWorldView } from '../../contracts/IAiBehaviour.js';
import { shipAimRadius } from '../../combat/shipHitShape.js';
import {
  isOnSightHostile,
  isNpcAllegianceId,
  PLAYERS_SIDE,
  type AllegianceSide,
} from '../../../shared-types/allegiances.js';
import { pickTarget, type MountTargetView, type PickTargetOptions } from '../WeaponMountController.js';
import { TARGET_CLAIM_WEIGHT } from '../tactics/targetClaims.js';
import {
  DEFAULT_AIM_RADIUS,
  DRONE_TARGET_HEALTH_WEIGHT,
  DRONE_TARGET_DWELL_TICKS,
  STRUCTURE_PRIORITY_BIAS,
  ORDERED_TARGET_PRIORITY,
} from '../hostileDroneTuning.js';

/** One entry of the merged COMBAT candidate buffer. */
export interface CombatCandidate {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing (rad); undefined when unknown (structures, views without it). */
  angle?: number;
  health?: number;
  maxHealth?: number;
  kindId?: string | null;
  shieldUp?: boolean;
  priority: number;
  /** Spread targets: brains of my side already on it (0 without `view.claims`). */
  claims: number;
  /** A ship (pilot hull or swarm combatant), not a structure. */
  ship: boolean;
  /** The hit circle a fixed gun aims at (`shipAimRadius` of the view's
   *  hull shape; the default kind's bubble without one); Infinity for a
   *  structure (the player window applies). */
  hitRadius: number;
  /** Per-candidate hostility (allegiances P0) — ALWAYS set before the pick,
   *  so `pickTarget` reads it instead of the callback. For a drones-only view
   *  it equals `hostileTo.has(id)` ⇒ byte-identical to pre-P0. */
  hostile: boolean;
  /** Hostile through the retaliation ledger (`hostileTo`), not on sight:
   *  the guard leash reaches these out to guard radius + weapon reach. */
  ledger: boolean;
}

/**
 * The pilot's target pick (owned by `HostileDroneBehaviour`, built once): the
 * merged candidate buffer and the four reused `pickTarget` option sets
 * (sensor-capped, uncapped fallback, guard leash, guard retaliation).
 * Alloc-free per tick (#14): candidates are created only when the buffer grows.
 */
export class TargetPick {
  /** Wave-system Phase 2 — reusable merged COMBAT candidate buffer (players +
   *  hostile structures). Filled IN PLACE every tick from `view.players` +
   *  `view.structures`; objects are created only when the buffer grows, never
   *  per-tick (#14, this is the hot AI loop). Structures carry `vx=vy=0`
   *  (static) + their class `priority`; players carry `priority 0`. Server-only
   *  (the client never ticks the drone brain). */
  readonly cand: CombatCandidate[] = [];
  /** Set by `build`: any candidate hostile this tick. */
  anyHostile = false;
  /** Reused body-pick options (alloc-free, #14); `ticksSincePrevTarget` is
   *  written each tick. */
  readonly pickOpts: PickTargetOptions;
  /** Same options without the sensor cap: the out-of-sensor fallback pick. */
  readonly pickOptsUncapped: PickTargetOptions;
  /** The guard-leash pick (a non-broadside ship with a post): measured from
   *  the POST, new picks AND the held target only inside the guard radius. */
  readonly pickOptsGuard: PickTargetOptions;
  /** The guard-leash pick for RETALIATION targets only (slice 6): a ship being
   *  shot answers out to its guard radius plus its weapon reach, so it fires
   *  back from the edge of its area. */
  readonly pickOptsGuardRetaliate: PickTargetOptions;
  /** Bound once (no per-tick closure). Unused while every candidate carries
   *  its own `hostile` flag, kept for the pickTarget signature. */
  private readonly _isHostile = (id: string): boolean => this.hostileTo.has(id);

  constructor(
    private readonly hostileTo: ReadonlySet<string>,
    private readonly allegiance: AllegianceSide,
    private readonly onSightPlayers: boolean,
    private readonly foesOfPlayers: boolean,
    private readonly ownerId: string | null,
    sensorRange: number,
  ) {
    this.pickOpts = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
      maxDistance: sensorRange,
      prevMaxDistance: Infinity,
    };
    this.pickOptsUncapped = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
    };
    this.pickOptsGuard = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
      maxDistance: 0,
      prevMaxDistance: 0,
    };
    this.pickOptsGuardRetaliate = { ...this.pickOptsGuard };
  }

  /** The guard leash's reach: the post's radius, retaliation out to radius + fire range. */
  setLeash(guardR: number, fireRange: number): void {
    this.pickOptsGuard.maxDistance = guardR;
    this.pickOptsGuard.prevMaxDistance = guardR;
    this.pickOptsGuardRetaliate.maxDistance = guardR + fireRange;
    this.pickOptsGuardRetaliate.prevMaxDistance = guardR + fireRange;
  }

  /**
   * Build the merged candidate buffer in place (players, hostile structures,
   * hostile other-allegiance swarm ships); returns its length and sets
   * `anyHostile`.
   */
  build(self: AiEntity, view: AiWorldView, engageR2: number, onSight: boolean, ordered: string | null): number {
    const cand = this.cand;
    const ownerId = this.ownerId;
    const ownerFoe = view.hostileToPlayer;
    let n = 0;
    let anyHostile = false;
    for (const p of view.players) {
      let c = cand[n];
      if (!c) {
        c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
        cand[n] = c;
      }
      c.id = p.id;
      c.x = p.x;
      c.y = p.y;
      c.vx = p.vx;
      c.vy = p.vy;
      c.angle = p.angle;
      c.health = p.health;
      c.maxHealth = p.maxHealth;
      c.kindId = p.kindId;
      c.shieldUp = p.shieldUp;
      c.priority = p.id === ordered ? ORDERED_TARGET_PRIORITY : 0;
      c.ship = true;
      c.hitRadius = p.kindId != null ? shipAimRadius(p.kindId, p.shieldUp === true) : DEFAULT_AIM_RADIUS;
      let h = this.hostileTo.has(p.id) || (p.ownerId !== undefined && this.hostileTo.has(p.ownerId));
      if (h && this.ownerId !== null && (p.id === this.ownerId || p.ownerId === this.ownerId)) h = false;
      c.ledger = h;
      if (!h && onSight && this.onSightPlayers && p.truce !== true) {
        const dx = p.x - self.x;
        const dy = p.y - self.y;
        h = dx * dx + dy * dy <= engageR2;
      }
      c.hostile = h;
      if (h) anyHostile = true;
      n++;
    }
    const structs = view.structures;
    if (structs) {
      for (const s of structs) {
        let c = cand[n];
        if (!c) {
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = 0;
        c.vy = 0;
        c.angle = undefined;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.kindId = undefined;
        c.shieldUp = undefined;
        c.priority = s.id === ordered ? Math.max(s.priority, ORDERED_TARGET_PRIORITY) : s.priority;
        c.ship = false;
        c.hitRadius = Infinity; // a footprint box, not a hull: the player window
        c.hostile = this.hostileTo.has(s.id);
        c.ledger = c.hostile;
        if (c.hostile) anyHostile = true;
        n++;
      }
    }
    // Allegiances P0 — other-allegiance swarm combatants. Only HOSTILE ones are
    // appended (stance on-sight within range, or retaliation via `hostileTo`),
    // keeping the candidate list small in a mixed sector.
    const swarms = view.swarms;
    if (swarms) {
      for (const s of swarms) {
        if (s.id === self.id) continue;
        let h = this.hostileTo.has(s.id);
        const ledger = h;
        // On sight: the stance table, a players-side ship's foes of players,
        // and (owned ships) anything hostile to the OWNER (slice 6).
        if (!h && onSight && isNpcAllegianceId(s.allegiance)
          && (isOnSightHostile(this.allegiance, s.allegiance)
            || (this.foesOfPlayers && isOnSightHostile(s.allegiance, PLAYERS_SIDE))
            || (ownerId !== null && ownerFoe !== undefined && ownerFoe(s.id, ownerId)))) {
          const dx = s.x - self.x;
          const dy = s.y - self.y;
          h = dx * dx + dy * dy <= engageR2;
        }
        if (!h) continue;
        let c = cand[n];
        if (!c) {
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = s.vx;
        c.vy = s.vy;
        c.angle = s.angle;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.kindId = s.kindId;
        c.shieldUp = s.shieldUp;
        c.priority = s.id === ordered ? ORDERED_TARGET_PRIORITY : 0;
        c.ship = true;
        c.hitRadius = s.kindId != null ? shipAimRadius(s.kindId, s.shieldUp === true) : DEFAULT_AIM_RADIUS;
        c.hostile = true;
        c.ledger = ledger;
        anyHostile = true;
        n++;
      }
    }
    if (cand.length !== n) cand.length = n;
    this.anyHostile = anyHostile;
    return n;
  }

  /**
   * Pick the body target from the built buffer: an attack order uncapped
   * (other targets leashed), else the guard leash round (`guardX`, `guardY`)
   * with its retaliation reach, else the sensor-capped pick with the uncapped
   * fallback.
   */
  pick(
    self: AiEntity, n: number, prevTargetId: string | null, sinceTicks: number, ordered: string | null,
    orderedLive: boolean, leash: boolean, guardX: number, guardY: number, guardR: number, anyHostile: boolean,
  ): MountTargetView | null {
    const cand = this.cand;
    let target: MountTargetView | null;
    if (orderedLive) {
      // Attack order (slice 8): go and get it. The ordered target is free of
      // the sensor cap and the guard leash; it wins on its priority inside the
      // usual pick. Every other target keeps the leash (inside the guard
      // radius round the post), narrowed in place (the pick is the last reader).
      if (leash) {
        const r2 = guardR * guardR;
        for (let i = 0; i < n; i++) {
          const c = cand[i]!;
          if (!c.hostile || c.id === ordered) continue;
          const dx = c.x - guardX;
          const dy = c.y - guardY;
          if (dx * dx + dy * dy > r2) c.hostile = false;
        }
      }
      this.pickOptsUncapped.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, prevTargetId, this._isHostile, this.pickOptsUncapped);
    } else if (leash) {
      this.pickOptsGuard.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(guardX, guardY, cand, prevTargetId, this._isHostile, this.pickOptsGuard);
      // Slice 6: a ship being shot answers. Nothing inside the radius ⇒ a
      // RETALIATION target out to the radius plus the weapon reach (so it
      // fires back from the edge of its area); on-sight ones stay inside.
      // Narrows `hostile` to the ledger in place: the pick is the buffer's
      // last reader this tick.
      if (target === null && this.hostileTo.size > 0) {
        for (let i = 0; i < n; i++) { const c = cand[i]!; c.hostile = c.ledger; }
        this.pickOptsGuardRetaliate.ticksSincePrevTarget = sinceTicks;
        target = pickTarget(guardX, guardY, cand, prevTargetId, this._isHostile, this.pickOptsGuardRetaliate);
      }
    } else {
      this.pickOpts.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, prevTargetId, this._isHostile, this.pickOpts);
    }
    if (target === null && anyHostile && !leash && !orderedLive) {
      this.pickOptsUncapped.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, prevTargetId, this._isHostile, this.pickOptsUncapped);
    }
    return target;
  }
}
