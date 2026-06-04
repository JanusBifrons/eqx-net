/**
 * Structure (Generic Entity Pipeline P4) constants. A structure is a static,
 * damageable world object that rides the pose-core binary channel as kind
 * byte 2 — the "for free" proof that a new entity type wires in cheaply.
 *
 * Heavy mass so projectile / ram impulse barely moves it server-side (the
 * client additionally LOCKS the body via `swarmKindClientProfile`.staticBody);
 * a hull pool so the existing DamageRouter 'swarm' strategy makes it damageable
 * with zero new dispatch code.
 */

/** Effectively-immovable: a structure shrugs off projectile / ram impulse. */
export const STRUCTURE_DEFAULT_MASS = 5000;

/** Hull points seeded into `swarmHealth` on spawn — presence is what makes the
 *  structure damageable through the existing swarm damage path (asteroids,
 *  which are absent from `swarmHealth`, stay immune). */
export const STRUCTURE_DEFAULT_HEALTH = 200;
