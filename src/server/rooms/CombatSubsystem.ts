/**
 * Combat state for SectorRoom.
 *
 * Step 8 of the hazy-pillow decomposition plan — relocates the 6 combat
 * state maps (last-fire ticks per shooter, live projectiles, per-drone
 * health / shield / last-damage tick) into a focused owner.
 *
 * Map fields are public readonly so existing iteration patterns at the
 * many call sites continue to work via `this.combat.liveProjectiles`
 * etc. The HEAVY method bodies (`handleFire`, `handleAiFire`,
 * `applyDamage`, `damageShipLayered`, `damageSwarmLayered`,
 * `advanceProjectiles`, `tickShieldRegen`, `spawnServerProjectile`)
 * remain in SectorRoom for now: they span SnapshotRing (lag-comp lookup),
 * PlayerMountAngles (per-mount ray geometry), PlayerSlotMap (worker-body
 * id resolution), ShieldHull (layered damage rules), the Colyseus
 * schema (`state.ships` hull/shield writes), and the bus (`SHIP_DESTROYED`).
 * Migrating those methods requires those collaborators to have stable
 * interfaces, which lands across Steps 9–11.
 *
 * This commit ships the state ownership boundary; the methods follow.
 */

import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';

export interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
  damage: number;
  radius: number;
  maxTicks: number;
  weaponId: WeaponId;
}

export class CombatSubsystem {
  /** Per-shooter most-recent fire tick. Used to enforce
   *  `WEAPON_COOLDOWN_TICKS` between consecutive fires from the same
   *  ship or drone. Keyed by shooterId (playerId or `swarm-*`). */
  readonly lastFireClientTick = new Map<string, number>();
  /** Live projectile records, indexed by stable server-generated
   *  projectile id. Advanced once per tick by `advanceProjectiles`. */
  readonly liveProjectiles = new Map<string, ProjectileRecord>();
  /** Monotonically-increasing counter for generating projectile ids
   *  (`p-${counter}`). Wraps via JS number precision — practically
   *  unbounded in a single server lifetime. */
  projectileCounter = 0;
  /** Per-drone health pool. Drones are killable; asteroids are not
   *  present in this map (asteroids deal but don't take damage). */
  readonly swarmHealth = new Map<string, number>();
  /** Per-drone shield pool. Server-authoritative. Reaches clients on
   *  discrete events only (`DamageEvent.newShield`, `ShieldEventMessage`),
   *  never on a continuous channel. */
  readonly swarmShield = new Map<string, number>();
  /** Per-drone "last damaged at tick" — gates shield regen onset. */
  readonly swarmShieldLastDmg = new Map<string, number>();

  /** Allocate the next projectile id and bump the counter. */
  nextProjectileId(): string {
    return `p-${++this.projectileCounter}`;
  }
}
