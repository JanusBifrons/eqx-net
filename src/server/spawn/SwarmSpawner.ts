import { SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_FLAGS_OFF, FLAG_IS_SWARM, FLAG_KIND_DRONE, slotBase } from '../../shared-types/sabLayout.js';
import { SwarmEntityRegistry, type SwarmKind } from '../net/SwarmEntityRegistry.js';
import type { IAiBehaviour } from '../../core/contracts/IAiBehaviour.js';
import type { SpatialGrid } from '../interest/SpatialGrid.js';
import { generateAsteroidVertices, type Vec2 } from '../../core/swarm/asteroidShape.js';
import { ASTEROID_DEFAULT_MASS } from '../../core/swarm/asteroidConstants.js';

export interface AsteroidSpec {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Optional — defaults to `ASTEROID_DEFAULT_MASS`. Asteroids are intentionally
   *  very heavy; per-spec overrides exist for tests and special-case rocks. */
  mass?: number;
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
  /** Send a SPAWN_OBSTACLE-shape command to the physics worker. The optional
   *  `vertices` array carries the asteroid polygon's local-space points so the
   *  worker can build a `convexHull` collider. Drones (kind=1) pass `undefined`
   *  and remain ball colliders. */
  postSpawnObstacle: (slot: number, id: string, x: number, y: number, vx: number, vy: number, radius: number, mass: number, vertices?: ReadonlyArray<Vec2>) => void;
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
  /** Optional: register the entity with the lag-comp snapshot ring so the
   *  hit resolver can rewind its pose to the shooter's tick. Called for every
   *  swarm entity (asteroids + drones). Player ships register separately in
   *  the room's onJoin path. */
  registerLagComp?: (id: string) => void;
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

  /**
   * Phase 5e bulk seed. Distributes `count` entities across an asteroid/drone
   * mix (`ratio` is the asteroid fraction, default 0.8) over a deterministic
   * spiral within `radius` of origin. Deterministic because tests need to
   * count-and-locate seeded entities; the spawn pattern itself isn't game-
   * critical. Returns the number actually spawned (capped by free slots).
   *
   * Slot exhaustion is logged by the caller — `seed()` returns the truncated
   * count without throwing so a too-large `swarmCount` degrades gracefully.
   */
  seed(count: number, ratio = 0.8, radius = 18_000): number {
    if (count <= 0) return 0;
    let spawned = 0;
    // Sunflower-spiral spread across a disc bounded by `radius`. Gives a
    // visually uniform distribution without clustering near origin.
    //
    // Drone/asteroid kind is INTERLEAVED across the spiral via a stride
    // derived from `ratio`, not segregated to the outer band by index. The
    // older "i >= asteroidCount" approach put every drone at radii 16-18k —
    // far outside any reasonable interest window — so the player at origin
    // never saw a drone. Interleaving keeps the kind ratio while putting
    // drones at every distance band.
    const dronesPerCycle = Math.max(1, Math.round((1 - ratio) * 10));
    const droneStride = 10; // 10 entities per cycle; `dronesPerCycle` of them are drones
    const PHI = Math.PI * (3 - Math.sqrt(5)); // golden angle
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const r = Math.sqrt(t) * radius;
      const angle = i * PHI;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      const isDrone = (i % droneStride) < dronesPerCycle;
      // Vary asteroid radius along the spiral so the bulk-seeded swarm shows
      // visible size variety without per-entry hand-tuning.
      const asteroidRadius = 18 + ((i * 7) % 8) * 4; // 18, 22, 26, 30, 34, 38, 42, 46
      const ok = isDrone
        ? this.spawnDrone({ id: `swarm-drone-${i}`, x, y })
        : this.spawnAsteroid({
          id: `swarm-asteroid-${i}`,
          x, y,
          // Tiny drift so the wire isn't entirely static at low speeds.
          vx: Math.cos(angle * 1.7) * 0.5,
          vy: Math.sin(angle * 1.7) * 0.5,
          radius: asteroidRadius,
          // Stress-test rooms keep the original light asteroid mass (1) for
          // bandwidth-budget continuity. Galaxy rooms and hand-rolled rosters
          // get ASTEROID_DEFAULT_MASS via the spawner default. The bulk-seed
          // mass-feel doesn't matter — there's no gameplay collision testing
          // in `swarm-soak` / `swarm-tidi`; they exist purely as broadcast /
          // load benchmarks.
          mass: 1,
        });
      if (!ok) break;
      spawned++;
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

    // Asteroids get a deterministic convex-polygon collider derived from
    // their stable entityId. Drones stay circular. Vertices are attached to
    // the registry record so the polygon-aware hit resolver can read them
    // alongside the rewound pose at fire time.
    let vertices: ReadonlyArray<Vec2> | undefined;
    let mass = a.mass;
    if (kind === 0) {
      vertices = generateAsteroidVertices(rec.entityId, a.radius);
      rec.vertices = vertices;
      mass ??= ASTEROID_DEFAULT_MASS;
    } else {
      mass ??= DRONE_DEFAULT_MASS;
    }

    this.hooks.postSpawnObstacle(slot, a.id, a.x, a.y, a.vx, a.vy, a.radius, mass, vertices);

    // Phase 5d: insert into the interest grid so this entity participates in
    // per-client filtering. Indexed by the dense u16 entityId since that's
    // what the binary broadcast writes on the wire.
    this.hooks.interestGrid?.insert(rec.entityId, a.x, a.y);

    // Register every dynamic swarm entity with the lag-comp ring so the hit
    // resolver can rewind its pose. Mass-independent: any moving obstacle
    // benefits from accurate hit attribution.
    this.hooks.registerLagComp?.(a.id);

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
