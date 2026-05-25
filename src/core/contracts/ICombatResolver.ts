/**
 * Combat resolution surface (server-side). Owns hitscan / projectile fire,
 * projectile world-stepping, and damage application. The core zone declares
 * the contract; the server zone supplies the concretion.
 *
 * Pure types only — no runtime imports — so `src/core` keeps the boundary
 * invariant against `colyseus`, persistence, and pino.
 *
 * Today (pre-refactor) all three responsibilities live inline in
 * `SectorRoom.ts`. Commit 21 of the god-file refactor (see
 * `docs/plans/refactor-god-files.md`) extracts them into `CombatResolver.ts`
 * implementing this interface, with `LagCompRing.ts` as a sibling collaborator.
 */

export interface FireRequest {
  /** Server-resolved shooter entity id (player or drone). */
  readonly shooterId: string;
  /** Weapon catalogue id (e.g. 'hitscan', 'projectile'). */
  readonly weaponId: string;
  /** Direction unit vector for the shot. */
  readonly dirX: number;
  readonly dirY: number;
  /** Client tick at which the shot was fired (used for lag-comp rewind). */
  readonly clientTick: number;
  /** Optional client-supplied shot id for ack correlation (player shots only). */
  readonly clientShotId?: string;
}

export interface FireResult {
  /** Whether the fire was accepted by the cooldown gate. */
  readonly accepted: boolean;
  /** Resolved target entity id, if the fire hit one. */
  readonly hitTargetId?: string;
  /** Resolved hit point in world coords (hitscan only). */
  readonly hitX?: number;
  readonly hitY?: number;
}

export interface DamageSource {
  readonly shooterId: string;
  readonly weapon: string;
  readonly clientShotId?: string;
}

export interface DamageOutcome {
  /** Did this damage destroy the target? */
  readonly destroyed: boolean;
  /** Remaining hull after damage (>= 0). */
  readonly remainingHp: number;
  /** Did this damage cross the shield 0-line? */
  readonly shieldBroken: boolean;
}

export interface ProjectileTickResult {
  /** Number of projectiles advanced this tick. */
  readonly advanced: number;
  /** Number of projectiles that hit this tick (and were retired). */
  readonly hits: number;
  /** Number of projectiles expired by TTL. */
  readonly expired: number;
}

export interface ICombatResolver {
  /** Apply a fire request through the lag-comp + hitscan/projectile path. */
  handleFire(req: FireRequest): FireResult;
  /** Step active projectiles by `dt` seconds; resolve hits + TTL. */
  stepProjectiles(dt: number): ProjectileTickResult;
  /** Apply damage to a target (post-mitigation by shield/hull layer). */
  applyDamage(targetId: string, amount: number, src: DamageSource): DamageOutcome;
}
