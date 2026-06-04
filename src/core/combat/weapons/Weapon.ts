/**
 * Weapon class hierarchy (Generic Entity Pipeline B3 — the OOP weapon model).
 *
 * `WeaponCatalogue.ts` stays the pure, append-only DATA source; this layer wraps
 * each `WeaponDef` in a stateless flyweight (`HitscanWeapon` / `ProjectileWeapon`
 * / `MissileWeapon`) that owns its per-mode FIRE DECISION. The two fire resolvers
 * (`PlayerFireResolver` / `AiFireResolver`) used to each carry a duplicated
 * `if (mode === 'projectile') … if (mode === 'missile') … else hitscan` branch;
 * both collapse to one virtual `weapon.resolveFire(ctx, sink)` call. Fire is a
 * LOW-frequency event (per-mount cooldown ≈ 6 Hz), so the virtual dispatch here
 * is cheap and clarifying — distinct from the per-HIT damage path, which stays
 * monomorphic (HC#5). You can point at `HitscanWeapon` and see what a beam does.
 *
 * The SERVER work (the lag-comp candidate sweep, the projectile/missile spawn,
 * the `laser_fired` broadcast) is state-bound, so it lives behind the
 * `WeaponFireSink` — a zone-pure ABSTRACTION here, with the concrete impl
 * injected by each resolver (DI invariant #5). The weapon decides WHICH sink
 * action + WHAT params (read off its def); the sink does the work. The resolver
 * provides the right sink, so player-vs-AI hitscan differences (4-pass lag-comp
 * vs players-only) live in the sink, not the weapon.
 *
 * Stateless + flyweight: one instance per `WeaponId` at module load
 * ([index.ts](index.ts)); per-mount cooldown stays in the resolvers' primitive
 * arrays (this layer holds no mutable state — zero hot-loop allocation, #14).
 */

import type { WeaponId, MissileWeaponDef } from '../WeaponCatalogue.js';

/**
 * Per-mount fire geometry handed to a weapon. Reused by the resolver (mutated
 * per mount) — the weapon only READS it, allocating nothing. `mountId` is
 * ignored by the weapon (the sink uses it for the `laser_fired` broadcast).
 */
export interface WeaponFireContext {
  /** Ray origin — barrel offset already applied. */
  fromX: number;
  fromY: number;
  /** Normalized ray direction. */
  dirX: number;
  dirY: number;
  /** Shooter velocity at fire tick — a projectile inherits it so bolts lead. */
  shooterVx: number;
  shooterVy: number;
  /** The firing mount's id (sink-only: the `laser_fired` mountId). */
  mountId: string;
}

/**
 * The server-side fire actions a weapon dispatches to. Zone-pure abstraction;
 * the concrete impl (per resolver) does the lag-comp sweep / spawn / broadcast.
 * The weapon passes already-computed params (velocity, range, damage) — the
 * sink owns shooter identity + per-fire-event state (set before the salvo).
 */
export interface WeaponFireSink {
  /** Resolve an instant beam: cast a ray of `range` and apply `damage` to the
   *  nearest hit, then broadcast the beam. (Server: the candidate sweep.) */
  hitscan(ctx: WeaponFireContext, range: number, damage: number): void;
  /** Spawn a server projectile with the given velocity + ballistics. */
  spawnProjectile(
    ctx: WeaponFireContext,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    maxTicks: number,
    weaponId: WeaponId,
  ): void;
  /** Spawn a server homing missile (lock-at-launch lives in the simulation). */
  spawnMissile(ctx: WeaponFireContext, def: MissileWeaponDef): void;
}

/**
 * The base every weapon flyweight extends. `resolveFire` is the virtual seam
 * that replaces the resolvers' mode if-tree: each leaf reads its def + the fire
 * geometry and calls exactly one sink action with its params.
 */
export abstract class Weapon {
  /** The catalogue id this flyweight wraps (== `mount.weaponId`). */
  abstract readonly id: WeaponId;
  /** Dispatch this weapon's per-mode fire action onto the sink. */
  abstract resolveFire(ctx: WeaponFireContext, sink: WeaponFireSink): void;
}
