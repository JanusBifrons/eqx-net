import { SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_FLAGS_OFF, FLAG_IS_SWARM, FLAG_KIND_DRONE, slotBase } from '../../shared-types/sabLayout.js';
import { SwarmEntityRegistry, type SwarmKind } from '../net/SwarmEntityRegistry.js';
import type { IAiBehaviour } from '../../core/contracts/IAiBehaviour.js';
import type { SpatialGrid } from '../interest/SpatialGrid.js';

export interface AsteroidSpec {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
}

export interface DroneSpec {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  radius?: number;
  mass?: number;
}

export interface SpawnerHooks {
  /** Pop a free SAB slot, or return undefined when full. */
  takeSlot: () => number | undefined;
  /** Send a SPAWN_OBSTACLE-shape command to the physics worker. */
  postSpawnObstacle: (slot: number, id: string, x: number, y: number, vx: number, vy: number, radius: number, mass: number) => void;
  /** Direct write into the SAB so the first update() tick reads a sane pose. */
  sabF32: Float32Array;
  sabU32: Uint32Array;
  /** Optional: register the entity with the AI controller (drones only). */
  registerAi?: (id: string, slot: number, behaviour: IAiBehaviour) => void;
  /** Per-entity AI behaviour factory. The spawner does not import concrete behaviours. */
  asteroidBehaviour?: () => IAiBehaviour;
  droneBehaviour?: () => IAiBehaviour;
  /** Optional: insert into the per-tick interest grid (Phase 5d). */
  interestGrid?: SpatialGrid;
}

const DRONE_DEFAULT_RADIUS = 14;
const DRONE_DEFAULT_MASS = 2;

/**
 * Owns swarm entity creation. Allocates a slot, primes the SAB, posts a
 * SPAWN_OBSTACLE worker command (bodies behave the same way regardless of
 * whether they're "asteroids" or "drones"; the AI behaviour is what makes
 * the difference), registers the entity with the wire registry, and wires
 * the AI controller for drones.
 *
 * Drone bodies use the same `spawnObstacle` worker path as asteroids — they're
 * just dynamic Rapier balls with damping=0. The Phase 4 weapon system already
 * treats any body in `slotToPlayer` as a valid hitscan target, so drones are
 * shootable without further plumbing.
 */
export class SwarmSpawner {
  constructor(
    private readonly registry: SwarmEntityRegistry,
    private readonly hooks: SpawnerHooks,
  ) {}

  /** Seed an asteroid swarm. Returns the count actually spawned (limited by free slots). */
  seedAsteroids(roster: ReadonlyArray<AsteroidSpec>): number {
    let spawned = 0;
    for (const a of roster) {
      if (this.spawnAsteroid(a)) spawned++;
    }
    return spawned;
  }

  /** Spawn one asteroid. Returns true on success, false if no free slot. */
  spawnAsteroid(a: AsteroidSpec): boolean {
    return this.spawnOne(0, a, undefined);
  }

  /** Spawn one drone. Returns true on success, false if no free slot. */
  spawnDrone(d: DroneSpec): boolean {
    const radius = d.radius ?? DRONE_DEFAULT_RADIUS;
    const mass = d.mass ?? DRONE_DEFAULT_MASS;
    const spec: AsteroidSpec = {
      id: d.id, x: d.x, y: d.y, vx: d.vx ?? 0, vy: d.vy ?? 0, radius, mass,
    };
    return this.spawnOne(1, spec, this.hooks.droneBehaviour);
  }

  private spawnOne(kind: SwarmKind, a: AsteroidSpec, behaviourFactory: (() => IAiBehaviour) | undefined): boolean {
    const slot = this.hooks.takeSlot();
    if (slot === undefined) return false;

    const base = slotBase(slot);
    this.hooks.sabF32[base + SLOT_X_OFF]  = a.x;
    this.hooks.sabF32[base + SLOT_Y_OFF]  = a.y;
    this.hooks.sabF32[base + SLOT_VX_OFF] = a.vx;
    this.hooks.sabF32[base + SLOT_VY_OFF] = a.vy;
    // Set IS_SWARM and KIND_DRONE flag bits on the SAB slot. These bits are
    // owned by the main thread (set on spawn, cleared on despawn); the worker
    // only ever toggles FLAG_SLEEPING.
    let flagsWord = FLAG_IS_SWARM;
    if (kind === 1) flagsWord |= FLAG_KIND_DRONE;
    this.hooks.sabU32[base + SLOT_FLAGS_OFF] = flagsWord;

    const rec = this.registry.register(a.id, slot, kind, a.radius, a.x, a.y, 0);

    this.hooks.postSpawnObstacle(slot, a.id, a.x, a.y, a.vx, a.vy, a.radius, a.mass);

    // Phase 5d: insert into the interest grid so this entity participates in
    // per-client filtering. Indexed by the dense u16 entityId since that's
    // what the binary broadcast writes on the wire.
    this.hooks.interestGrid?.insert(rec.entityId, a.x, a.y);

    if (kind === 1 && behaviourFactory && this.hooks.registerAi) {
      this.hooks.registerAi(a.id, slot, behaviourFactory());
    } else if (kind === 0 && this.hooks.asteroidBehaviour && this.hooks.registerAi) {
      // Asteroid behaviours are no-ops, but registering them keeps the AI
      // controller aware of the entity for future hooks (sleep accounting,
      // wake events). Optional in 5c — Phase 5d/5e may use it.
      this.hooks.registerAi(a.id, slot, this.hooks.asteroidBehaviour());
    }

    return true;
  }
}
