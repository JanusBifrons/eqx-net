import { SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF, FLAG_IS_SWARM, FLAG_KIND_DRONE, slotBase } from '../../shared-types/sabLayout.js';
import { SwarmEntityRegistry, type SwarmKind } from '../net/SwarmEntityRegistry.js';
import type { IAiBehaviour } from '../../core/contracts/IAiBehaviour.js';
import type { SpatialGrid } from '../interest/SpatialGrid.js';
import { generateAsteroidVertices, asteroidResources, type Vec2 } from '../../core/swarm/asteroidShape.js';
import { ASTEROID_DEFAULT_MASS } from '../../core/swarm/asteroidConstants.js';
import { STRUCTURE_DEFAULT_MASS } from '../../core/swarm/structureConstants.js';
import { SCRAP_DEFAULT_MASS, SCRAP_LINEAR_DAMPING } from '../../core/swarm/scrapConstants.js';
import { SCRAP_COLLISION_GROUPS } from '../../core/physics/collisionGroups.js';
import { SWARM_KIND_SCRAP } from '../../shared-types/swarmWireFormat.js';
import { SHIP_KINDS_LIST, GAMEPLAY_SHIP_KINDS_LIST, type ShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { structureHullPoints } from '../../shared-types/structureKinds.js';

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
  /** Force a specific ship kind for this drone. Wins over the
   *  `pickDroneKind` hook and the random fallback — used by the Living
   *  World Director to carry a bot's kind across an inter-sector warp /
   *  preserve it on respawn. Absent ⇒ legacy hook/random path (no
   *  behavioural change for existing seed callers). */
  kind?: ShipKindId;
}

export interface SpawnerHooks {
  /** Pop a free SAB slot, or return undefined when full. */
  takeSlot: () => number | undefined;
  /** Send a SPAWN_OBSTACLE-shape command to the physics worker. The optional
   *  `vertices` array carries the asteroid polygon's local-space points so the
   *  worker can build a `convexHull` collider. Drones (kind=1) pass `undefined`
   *  and remain ball colliders. `staticBody` (structures, kind=2) locks the
   *  body so a ram can't move it (P3.10). `collisionGroups` (scrap, kind=3)
   *  carries a Rapier collision-group mask so scrap doesn't collide with other
   *  scrap but does collide with everything else (scrap-on-death Phase 2b-i).
   *  `angle` (scrap, kind=3) rotates the body at spawn so a recentred scrap
   *  collider is oriented to match the dying ship; every other caller passes 0
   *  / undefined (legacy axis-aligned spawn). */
  postSpawnObstacle: (slot: number, id: string, x: number, y: number, vx: number, vy: number, radius: number, mass: number, vertices?: ReadonlyArray<Vec2>, linearDamping?: number, staticBody?: boolean, collisionGroups?: number, angle?: number) => void;
  /** Direct write into the SAB so the first update() tick reads a sane pose. */
  sabF32: Float32Array;
  sabU32: Uint32Array;
  /** Optional: register the entity with the AI controller (drones only). */
  registerAi?: (id: string, slot: number, behaviour: IAiBehaviour) => void;
  /** Per-entity AI behaviour factory. The spawner does not import concrete behaviours. */
  asteroidBehaviour?: () => IAiBehaviour;
  /** Drone AI factory. Takes the chosen `ShipKind` so per-kind tuning
   *  (`kind.ai.thrust`, `turnKp`, `maxTorque`) flows into the behaviour
   *  without the spawner needing to import `HostileDroneBehaviour`. */
  droneBehaviour?: (kind: ShipKind) => IAiBehaviour;
  /** Optional drone-kind chooser. Defaults to "uniform random across the
   *  catalogue" — override in tests or for biased spawn distributions. */
  pickDroneKind?: () => ShipKindId;
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

  /** Spawn one drone. Returns true on success, false if no free slot.
   *  Kind precedence: explicit `d.kind` (Living World Director) > the
   *  configured `pickDroneKind` hook (deterministic test sequences) >
   *  random from the catalogue. The chosen kind drives the drone's
   *  collider radius and AI tuning. */
  spawnDrone(d: DroneSpec): boolean {
    const kindId = d.kind ?? (this.hooks.pickDroneKind ? this.hooks.pickDroneKind() : pickRandomShipKind());
    const kind = SHIP_KINDS_LIST.find((k) => k.id === kindId) ?? SHIP_KINDS_LIST[0]!;
    // Explicit per-spawn `radius` / `mass` still wins; otherwise fall back to
    // the kind's tuning values so each kind has its own physical footprint.
    const radius = d.radius ?? kind.radius ?? DRONE_DEFAULT_RADIUS;
    // 2026-05-28 fix: respect `kind.mass`. Pre-fix this fell straight through
    // to `DRONE_DEFAULT_MASS` (= 2), so a Crossguard drone (kind.mass = 30)
    // spawned at mass 2 — the player could push it across the sector with
    // basic thrust. Symmetric server↔client: the binary swarm wire doesn't
    // carry per-drone mass; both sides re-derive it from `entry.shipKind`
    // → catalogue lookup, so this fix lands on both. Player ships
    // (`spawnShip`) already use `kind.mass` (see World.ts:161).
    const mass = d.mass ?? kind.mass ?? DRONE_DEFAULT_MASS;
    const spec: AsteroidSpec = {
      id: d.id, x: d.x, y: d.y, vx: d.vx ?? 0, vy: d.vy ?? 0, radius, mass,
    };
    return this.spawnOne(1, spec, this.hooks.droneBehaviour, kind);
  }

  /** Spawn one static, damageable STRUCTURE (Generic Entity Pipeline P4). Rides
   *  the kind=2 pose-core path: no AI, heavy mass so projectile / ram impulse
   *  barely moves it. The CALLER seeds `swarmHealth` to make it damageable
   *  through the EXISTING DamageRouter 'swarm' strategy — zero new dispatch
   *  code. Its collision hull is the regular-polygon `structureHullPoints` (the
   *  same point-set the renderer draws) → a convexHull collider matching the
   *  silhouette, replacing the old circular collider (unified-hull plan).
   *  Returns false if no free slot. */
  spawnStructure(s: { id: string; x: number; y: number; radius: number; mass?: number; shipKind?: string }): boolean {
    // The subtype rides the shared `shipKind` byte (set below). Compute the
    // hull polygon from it + the radius here so `spawnOne` can attach the
    // matching convexHull collider + hit-resolver vertices.
    const structureVertices = structureHullPoints(s.shipKind, s.radius);
    const spec: AsteroidSpec = {
      id: s.id, x: s.x, y: s.y, vx: 0, vy: 0, radius: s.radius, mass: s.mass ?? STRUCTURE_DEFAULT_MASS,
    };
    const ok = this.spawnOne(2, spec, undefined, undefined, structureVertices);
    // The structure SUBTYPE rides the shared `shipKind` byte (kind=2 path) so
    // the client decoder can pick the right silhouette + tint. Set it on the
    // freshly-registered record (spawnOne only auto-sets shipKind for drones).
    if (ok && s.shipKind) {
      const rec = this.registry.get(s.id);
      if (rec) rec.shipKind = s.shipKind;
    }
    return ok;
  }

  /** Spawn one dynamic, damageable SCRAP body (scrap-on-death Phase 2b-i) —
   *  one component of a destroyed composite ship. Rides the kind=3 pose-core
   *  path: no AI, light mass, a small `SCRAP_LINEAR_DAMPING` so it coasts then
   *  slows, and `SCRAP_COLLISION_GROUPS` so scrap does NOT collide with other
   *  scrap but DOES collide with everything else. Its collision hull is the
   *  passed convex-hull `vertices` (the recentred scrap-group collider). The
   *  parent ship-kind rides the shared `shipKind` byte and `componentIndex`
   *  selects which `shipScrapGroups(parentKind)` group this piece is. Returns
   *  false if no free slot. */
  spawnScrap(spec: {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Spawn angle (radians, world math-up). The dying ship's angle so the
     *  recentred scrap-group collider is oriented correctly. */
    angle: number;
    radius: number;
    mass?: number;
    parentShipKind: ShipKindId;
    componentIndex: number;
    vertices: ReadonlyArray<Vec2>;
  }): boolean {
    const a: AsteroidSpec = {
      id: spec.id, x: spec.x, y: spec.y, vx: spec.vx, vy: spec.vy, radius: spec.radius, mass: spec.mass,
    };
    // Mirror spawnStructure: spawnOne attaches the convexHull collider from the
    // passed vertices; the parent ship-kind + component index are set on the
    // freshly-registered record below (spawnOne only auto-sets shipKind for
    // drones). The behaviour factory is undefined (scrap has no AI). `angle`
    // is threaded into the SAB pose + the worker spawn so the body is rotated.
    const ok = this.spawnOne(SWARM_KIND_SCRAP, a, undefined, undefined, spec.vertices, spec.angle);
    if (ok) {
      const rec = this.registry.get(spec.id);
      if (rec) {
        rec.shipKind = spec.parentShipKind;
        rec.componentIndex = spec.componentIndex;
      }
    }
    return ok;
  }

  private spawnOne(
    kind: SwarmKind,
    a: AsteroidSpec,
    behaviourFactory: ((shipKind: ShipKind) => IAiBehaviour) | (() => IAiBehaviour) | undefined,
    shipKind?: ShipKind,
    structureVertices?: ReadonlyArray<Vec2>,
    angle = 0,
  ): boolean {
    const slot = this.hooks.takeSlot();
    if (slot === undefined) return false;

    const base = slotBase(slot);
    this.hooks.sabF32[base + SLOT_X_OFF]  = a.x;
    this.hooks.sabF32[base + SLOT_Y_OFF]  = a.y;
    this.hooks.sabF32[base + SLOT_VX_OFF] = a.vx;
    this.hooks.sabF32[base + SLOT_VY_OFF] = a.vy;
    // SCRAP (kind 3) spawns rotated to the dying ship's angle so its recentred
    // collider is oriented correctly; prime the SAB pose angle slot so the
    // first update() tick reads it (mirrors the x/y/vx/vy priming above). The
    // worker SET_HULL/setShipState in the SPAWN_OBSTACLE handler applies the
    // same angle to the Rapier body. Other kinds keep the angle-0 default.
    if (kind === SWARM_KIND_SCRAP && angle !== 0) {
      this.hooks.sabF32[base + SLOT_ANGLE_OFF] = angle;
    }
    // Set IS_SWARM and KIND_DRONE flag bits on the SAB slot. These bits are
    // owned by the main thread (set on spawn, cleared on despawn); the worker
    // only ever toggles FLAG_SLEEPING.
    let flagsWord = FLAG_IS_SWARM;
    if (kind === 1) flagsWord |= FLAG_KIND_DRONE;
    this.hooks.sabU32[base + SLOT_FLAGS_OFF] = flagsWord;

    const rec = this.registry.register(a.id, slot, kind, a.radius, a.x, a.y, 0);
    if (kind === 1 && shipKind) {
      rec.shipKind = shipKind.id;
    }

    // Asteroids get a deterministic convex-polygon collider derived from their
    // stable entityId; STRUCTURES get the regular-polygon hull from
    // `structureHullPoints` (matching the rendered silhouette). Both attach a
    // convexHull collider in the worker AND set `rec.vertices` so the
    // polygon-aware hit resolver reads them alongside the rewound pose. Drones
    // stay circular.
    let vertices: ReadonlyArray<Vec2> | undefined;
    let mass = a.mass;
    if (kind === 0) {
      vertices = generateAsteroidVertices(rec.entityId, a.radius);
      rec.vertices = vertices;
      mass ??= ASTEROID_DEFAULT_MASS;
      // WS-4 / R2.27 — seed the finite mineable resource pool from the
      // silhouette area (a bigger rock holds more ore). Mining draws it down;
      // combat never touches it. Per-session (not persisted — first cut).
      const pool = asteroidResources(vertices);
      rec.resources = pool;
      rec.resourcesMax = pool;
    } else if (kind === 2 && structureVertices) {
      vertices = structureVertices;
      rec.vertices = vertices;
      mass ??= STRUCTURE_DEFAULT_MASS;
    } else if (kind === SWARM_KIND_SCRAP && structureVertices) {
      // SCRAP (kind 3, scrap-on-death Phase 2b-i) — the passed convex-hull
      // collider (the recentred scrap-group polygon). NO asteroid generation,
      // NO resource pool. Light default mass; it's just drifting debris.
      vertices = structureVertices;
      rec.vertices = vertices;
      mass ??= SCRAP_DEFAULT_MASS;
    } else {
      mass ??= DRONE_DEFAULT_MASS;
    }

    // WS-11 (R2.25) — DRONES (kind 1) get their per-kind `linearDamping` so the
    // AI standoff/brake has friction to settle against (matching `spawnShip`);
    // ASTEROIDS (kind 0) + STRUCTURES (kind 2) stay ballistic (damping 0). SCRAP
    // (kind 3) coasts then slows (SCRAP_LINEAR_DAMPING) so a death-burst settles.
    const linearDamping =
      kind === 1 && shipKind ? shipKind.linearDamping
        : kind === SWARM_KIND_SCRAP ? SCRAP_LINEAR_DAMPING
          : 0;
    // P3.10 (P0) — STRUCTURES (kind 2) spawn as LOCKED bodies: immovable under
    // ram impulses (the "I hit a pylon and it MOVED" bug). Drones (1) + asteroids
    // (0) + scrap (3) stay dynamic — drones fly, asteroids are bump-able (R2.33),
    // scrap drifts.
    const staticBody = kind === 2;
    // SCRAP (kind 3) carries a collision-group mask so scrap doesn't collide with
    // other scrap but does collide with everything else. Every other kind passes
    // undefined ⇒ Rapier's default groups (collide with all).
    const collisionGroups = kind === SWARM_KIND_SCRAP ? SCRAP_COLLISION_GROUPS : undefined;
    // SCRAP (kind 3) carries its spawn angle so the worker rotates the body to
    // match the dying ship. Other kinds pass 0 (legacy axis-aligned spawn).
    const spawnAngle = kind === SWARM_KIND_SCRAP ? angle : 0;
    this.hooks.postSpawnObstacle(slot, a.id, a.x, a.y, a.vx, a.vy, a.radius, mass, vertices, linearDamping, staticBody, collisionGroups, spawnAngle);

    // Phase 5d: insert into the interest grid so this entity participates in
    // per-client filtering. Indexed by the dense u16 entityId since that's
    // what the binary broadcast writes on the wire.
    this.hooks.interestGrid?.insert(rec.entityId, a.x, a.y);

    // Register every dynamic swarm entity with the lag-comp ring so the hit
    // resolver can rewind its pose. Mass-independent: any moving obstacle
    // benefits from accurate hit attribution.
    this.hooks.registerLagComp?.(a.id);

    if (kind === 1 && behaviourFactory && this.hooks.registerAi) {
      // Drone factory takes the chosen ShipKind; asteroid factory takes none.
      // The conditional cast keeps both shapes compatible with the same field.
      const behaviour = shipKind
        ? (behaviourFactory as (k: ShipKind) => IAiBehaviour)(shipKind)
        : (behaviourFactory as () => IAiBehaviour)();
      this.hooks.registerAi(a.id, slot, behaviour);
    } else if (kind === 0 && this.hooks.asteroidBehaviour && this.hooks.registerAi) {
      // Asteroid behaviours are no-ops, but registering them keeps the AI
      // controller aware of the entity for future hooks (sleep accounting,
      // wake events). Optional in 5c — Phase 5d/5e may use it.
      this.hooks.registerAi(a.id, slot, this.hooks.asteroidBehaviour());
    }

    return true;
  }
}

/** Default uniform-random kind picker for drones. Skews toward Fighter only
 *  by virtue of the catalogue's order — every gameplay kind has equal
 *  probability. Engineering-only kinds (`crossguard`, `el`) are excluded
 *  via `GAMEPLAY_SHIP_KINDS_LIST` — they're scale-10 test fixtures and
 *  leaked into Sol Prime in capture ilhqk6 with the "square ship bigger
 *  than its shield" smoke report. Player-explicit `JoinOption.shipKind`
 *  still bypasses this filter; only ambient random selection is gated. */
export function pickRandomShipKind(): ShipKindId {
  const idx = Math.floor(Math.random() * GAMEPLAY_SHIP_KINDS_LIST.length);
  return GAMEPLAY_SHIP_KINDS_LIST[idx]!.id;
}
