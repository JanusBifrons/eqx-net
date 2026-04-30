import type { PhysicsWorld } from '../physics/World.js';

export const HITSCAN_DAMAGE = 20;
export const PROJECTILE_DAMAGE = 15;
export const HITSCAN_RANGE = 500;
export const PROJECTILE_SPEED = 300;
export const WEAPON_COOLDOWN_TICKS = 10;
export const PROJECTILE_RADIUS = 4;
export const SHIP_COLLISION_RADIUS = 12;

/**
 * Instant hitscan weapon. Returns the first entity hit along the ray
 * within HITSCAN_RANGE, excluding the shooter.
 */
export function hitscanRaycast(
  world: PhysicsWorld,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  excludeId: string,
): { hitId: string; dist: number } | null {
  return world.hitscan(fromX, fromY, dirX, dirY, maxDist, excludeId);
}

/**
 * Spawn a physical projectile body in the prediction world.
 * The body is a sensor — it overlaps without generating impulses.
 */
export function spawnProjectile(
  world: PhysicsWorld,
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  radius: number,
): void {
  world.spawnProjectile(id, x, y, vx, vy, radius);
}

/**
 * Geometric ray-sphere intersection used by the server lag-comp handler.
 * Does NOT require a Rapier world — works directly from rewound positions.
 * Returns the distance along the ray to the entry point, or null on miss.
 */
export function rayHitsSphere(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number,
  radius: number,
): number | null {
  const dx = cx - fromX;
  const dy = cy - fromY;
  const t = dx * dirX + dy * dirY;
  if (t < 0) return null;
  const closestX = fromX + t * dirX;
  const closestY = fromY + t * dirY;
  const dist2 = (closestX - cx) ** 2 + (closestY - cy) ** 2;
  if (dist2 > radius * radius) return null;
  const entry = t - Math.sqrt(radius * radius - dist2);
  if (entry > maxDist) return null;
  return entry;
}
