/**
 * Worker sleep hysteresis: a body must report sleeping for
 * `SLEEP_HYSTERESIS_TICKS` consecutive steps before the worker sets
 * FLAG_SLEEPING and posts SLEEP_TRANSITION (suppresses flap on slow-drift
 * bodies under rapier2d-compat's threshold). `sleepCount` is the worker's
 * per-slot run of sleeping steps.
 */
import type { PhysicsWorld } from './World.js';

export const SLEEP_HYSTERESIS_TICKS = 12;

/**
 * Wreck fields: a piece laid out at rest (a field hull, a restored battle
 * piece) spawns ASLEEP, so the settle / wakeDv rules govern from the first
 * step. The counter is seeded one short of the hysteresis: the first step
 * reports it asleep, sets FLAG_SLEEPING and posts SLEEP_TRANSITION (no
 * 12-tick awake window).
 */
export function spawnAsleep(
  physics: PhysicsWorld,
  sleepCount: Map<number, number>,
  slot: number,
  id: string,
  x: number,
  y: number,
  angle: number,
): void {
  physics.setShipStateAsleep(id, { x, y, angle, vx: 0, vy: 0, angvel: 0 });
  sleepCount.set(slot, SLEEP_HYSTERESIS_TICKS - 1);
}
