import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmSpawner, type AsteroidSpec, pickRandomShipKind } from './SwarmSpawner.js';
import { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { ASTEROID_DEFAULT_MASS } from '../../core/swarm/asteroidConstants.js';
import { SCRAP_LINEAR_DAMPING, SCRAP_DEFAULT_MASS } from '../../core/swarm/scrapConstants.js';
import { SCRAP_COLLISION_GROUPS } from '../../core/physics/collisionGroups.js';
import { SWARM_KIND_SCRAP } from '../../shared-types/swarmWireFormat.js';
import { SHIP_KINDS, SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF,
  FLAG_IS_SWARM, FLAG_KIND_DRONE,
} from '../../shared-types/sabLayout.js';

interface PostedCmd {
  slot: number; id: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number;
  vertices?: ReadonlyArray<Vec2>;
  linearDamping?: number;
  staticBody?: boolean;
  collisionGroups?: number;
  angle?: number;
}

describe('SwarmSpawner', () => {
  let registry: SwarmEntityRegistry;
  let spawner: SwarmSpawner;
  let f32: Float32Array;
  let u32: Uint32Array;
  let posted: PostedCmd[];
  let availableSlots: number[];
  let lagCompRegistered: string[];

  beforeEach(() => {
    registry = new SwarmEntityRegistry();
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    f32 = new Float32Array(sab);
    u32 = new Uint32Array(sab);
    posted = [];
    availableSlots = [10, 11, 12]; // pre-stocked pool
    lagCompRegistered = [];
    spawner = new SwarmSpawner(registry, {
      takeSlot: () => availableSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass, vertices, linearDamping, staticBody, collisionGroups, angle) =>
        posted.push({ slot, id, x, y, vx, vy, radius, mass, vertices, linearDamping, staticBody, collisionGroups, angle }),
      sabF32: f32,
      sabU32: u32,
      registerLagComp: (id) => lagCompRegistered.push(id),
    });
  });

  // P3.10 (P0) — structures must be IMMOVABLE. They spawn through the same
  // `spawnObstacle` path as drones/asteroids (dynamic Rapier bodies), so a ram
  // imparted velocity and the (damping-0) structure coasted away forever — the
  // "I hit a pylon and it started MOVING" bug. The fix flags kind-2 spawns
  // `staticBody: true` so the worker locks the body (mirroring the client
  // predWorld's existing `spawnObstacle` + `lockBody` for structures). Drones +
  // asteroids stay dynamic — they're meant to move / be bumped (R2.33).
  it('structure spawns flagged staticBody; drones + asteroids stay dynamic (P3.10)', () => {
    spawner.spawnStructure({ id: 'cap', x: 0, y: 0, radius: 60, shipKind: 'capital' });
    spawner.spawnDrone({ id: 'drone-s', x: 0, y: 0, kind: 'fighter' });
    spawner.spawnAsteroid({ id: 'rock-s', x: 0, y: 0, vx: 0, vy: 0, radius: 30 });
    const cap = posted.find((p) => p.id === 'cap')!;
    const drone = posted.find((p) => p.id === 'drone-s')!;
    const rock = posted.find((p) => p.id === 'rock-s')!;
    expect(cap.staticBody).toBe(true); // the P0 fix — structures never move
    expect(drone.staticBody).toBeFalsy(); // drones fly
    expect(rock.staticBody).toBeFalsy(); // asteroids stay dynamic / bump-able
  });

  // WS-11 (R2.25) — drones get their per-kind linearDamping so the AI brake has
  // friction to settle against (the "float / coast away forever" fix); asteroids
  // + structures stay ballistic (0). Pre-fix, spawnObstacle hard-coded 0 for all.
  it('drone spawn passes the kind linearDamping; asteroid stays ballistic (0)', () => {
    spawner.spawnDrone({ id: 'drone-f', x: 0, y: 0, kind: 'fighter' });
    spawner.spawnAsteroid({ id: 'rock', x: 0, y: 0, vx: 0, vy: 0, radius: 30 });
    const drone = posted.find((p) => p.id === 'drone-f')!;
    const rock = posted.find((p) => p.id === 'rock')!;
    expect(drone.linearDamping).toBe(SHIP_KINDS.fighter.linearDamping);
    expect(drone.linearDamping).toBeGreaterThan(0); // the load-bearing fix
    expect(rock.linearDamping).toBe(0); // asteroids never get friction
  });

  it('a heavy drone gets ITS kind damping (not the fighter default)', () => {
    spawner.spawnDrone({ id: 'drone-h', x: 0, y: 0, kind: 'heavy' });
    const drone = posted.find((p) => p.id === 'drone-h')!;
    expect(drone.linearDamping).toBe(SHIP_KINDS.heavy.linearDamping);
  });

  // Scrap-on-death (Phase 2b-i) — a scrap piece spawns as a kind-3, dynamic,
  // damageable body that carries the passed convex-hull vertices, the parent
  // ship-kind (on rec.shipKind) + componentIndex, and is posted to the worker
  // with SCRAP_COLLISION_GROUPS + SCRAP_LINEAR_DAMPING + staticBody false (so
  // scrap doesn't collide with scrap but drifts off everything else).
  it('spawnScrap: kind 3 record, dynamic, carries vertices/parentKind/componentIndex; posted with scrap groups + damping', () => {
    const verts: Vec2[] = [
      { x: -10, y: -8 },
      { x: 10, y: -8 },
      { x: 10, y: 8 },
      { x: -10, y: 8 },
    ];
    const ok = spawner.spawnScrap({
      id: 'scrap-0', x: 120, y: -40, vx: 5, vy: -3, angle: 0.7, radius: 12,
      parentShipKind: 'havok', componentIndex: 2, vertices: verts,
    });
    expect(ok).toBe(true);

    const rec = registry.get('scrap-0')!;
    expect(rec.kind).toBe(SWARM_KIND_SCRAP); // kind 3
    expect(rec.kind).toBe(3);
    expect(rec.shipKind).toBe('havok'); // parent ship-kind on the shared byte
    expect(rec.componentIndex).toBe(2);
    expect(rec.vertices).toBe(verts); // single source of truth: same array

    // KIND_DRONE flag must NOT be set for scrap (only FLAG_IS_SWARM).
    const flags = u32[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0;
    expect(flags & FLAG_IS_SWARM).toBe(FLAG_IS_SWARM);
    expect(flags & FLAG_KIND_DRONE).toBe(0);

    const cmd = posted.find((p) => p.id === 'scrap-0')!;
    expect(cmd.collisionGroups).toBe(SCRAP_COLLISION_GROUPS);
    expect(cmd.linearDamping).toBe(SCRAP_LINEAR_DAMPING);
    expect(cmd.staticBody).toBeFalsy(); // scrap is dynamic — it drifts
    expect(cmd.vertices).toBe(verts); // convex-hull collider from the passed poly
    expect(cmd.vx).toBe(5);
    expect(cmd.vy).toBe(-3);
    // Scrap spawns rotated to the dying ship's angle: posted to the worker AND
    // primed into the SAB pose angle slot so the first update() reads it.
    expect(cmd.angle).toBeCloseTo(0.7, 6);
    expect(f32[slotBase(rec.slot) + SLOT_ANGLE_OFF]).toBeCloseTo(0.7, 6);
  });

  it('spawnScrap: mass defaults to SCRAP_DEFAULT_MASS when omitted', () => {
    spawner.spawnScrap({
      id: 'scrap-m', x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: 10,
      parentShipKind: 'havok', componentIndex: 0,
      vertices: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 0, y: 5 }],
    });
    const cmd = posted.find((p) => p.id === 'scrap-m')!;
    expect(cmd.mass).toBe(SCRAP_DEFAULT_MASS);
  });

  it('spawnScrap: every other kind is posted WITHOUT collisionGroups (default Rapier groups)', () => {
    spawner.spawnDrone({ id: 'd-cg', x: 0, y: 0, kind: 'fighter' });
    spawner.spawnAsteroid({ id: 'a-cg', x: 0, y: 0, vx: 0, vy: 0, radius: 20 });
    spawner.spawnStructure({ id: 's-cg', x: 0, y: 0, radius: 60, shipKind: 'capital' });
    expect(posted.find((p) => p.id === 'd-cg')!.collisionGroups).toBeUndefined();
    expect(posted.find((p) => p.id === 'a-cg')!.collisionGroups).toBeUndefined();
    expect(posted.find((p) => p.id === 's-cg')!.collisionGroups).toBeUndefined();
  });

  it('seeds an asteroid roster, registers each, primes SAB and posts spawn commands', () => {
    const roster: AsteroidSpec[] = [
      { id: 'a-0', x: 100, y: 0, vx: 0, vy: 0, radius: 32, mass: 5 },
      { id: 'a-1', x: -50, y: 80, vx: 0.3, vy: -0.2, radius: 24, mass: 3 },
    ];
    const count = spawner.seedAsteroids(roster);
    expect(count).toBe(2);
    expect(registry.size()).toBe(2);
    expect(posted).toHaveLength(2);

    const a = registry.get('a-0')!;
    expect(a.kind).toBe(0);
    expect(a.radius).toBe(32);

    // SAB primed for both.
    const baseA = slotBase(a.slot);
    expect(f32[baseA + SLOT_X_OFF]).toBeCloseTo(100, 5);
    expect(f32[baseA + SLOT_Y_OFF]).toBeCloseTo(0, 5);
    // FLAG_IS_SWARM set, KIND_DRONE clear for asteroid.
    expect((u32[baseA + SLOT_FLAGS_OFF] ?? 0) & FLAG_IS_SWARM).toBe(FLAG_IS_SWARM);
    expect((u32[baseA + SLOT_FLAGS_OFF] ?? 0) & FLAG_KIND_DRONE).toBe(0);
  });

  it('bails out gracefully when slots are exhausted', () => {
    availableSlots = []; // pool empty
    const count = spawner.seedAsteroids([
      { id: 'a-0', x: 0, y: 0, vx: 0, vy: 0, radius: 32, mass: 5 },
    ]);
    expect(count).toBe(0);
    expect(registry.size()).toBe(0);
    expect(posted).toHaveLength(0);
  });

  it('drone spawn sets KIND_DRONE flag and posts the SPAWN_OBSTACLE-equivalent command', () => {
    const ok = spawner.spawnDrone({ id: 'drone-0', x: 50, y: -30 });
    expect(ok).toBe(true);
    const rec = registry.get('drone-0')!;
    expect(rec.kind).toBe(1);
    const flags = u32[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0;
    expect(flags & FLAG_IS_SWARM).toBe(FLAG_IS_SWARM);
    expect(flags & FLAG_KIND_DRONE).toBe(FLAG_KIND_DRONE);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.id).toBe('drone-0');
    expect(posted[0]!.vx).toBe(0); // default velocity
  });

  it('passes asteroid velocity through to SAB and worker command', () => {
    const ok = spawner.spawnAsteroid({ id: 'a-0', x: 0, y: 0, vx: 0.5, vy: -0.7, radius: 30, mass: 4 });
    expect(ok).toBe(true);
    const rec = registry.get('a-0')!;
    const b = slotBase(rec.slot);
    expect(f32[b + SLOT_VX_OFF]).toBeCloseTo(0.5, 5);
    expect(f32[b + SLOT_VY_OFF]).toBeCloseTo(-0.7, 5);
    expect(posted[0]!.vx).toBeCloseTo(0.5, 5);
    expect(posted[0]!.vy).toBeCloseTo(-0.7, 5);
  });

  it('asteroid spawn forwards polygon vertices to the worker AND attaches them to the registry record', () => {
    spawner.spawnAsteroid({ id: 'rock', x: 0, y: 0, vx: 0, vy: 0, radius: 32 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.vertices).toBeDefined();
    expect(posted[0]!.vertices!.length).toBeGreaterThanOrEqual(3);
    const rec = registry.get('rock')!;
    expect(rec.vertices).toBeDefined();
    // Single source of truth: same array reference on both worker command and
    // registry record means the polygon-aware hit resolver and the physics
    // collider are guaranteed to agree on shape.
    expect(rec.vertices).toBe(posted[0]!.vertices);
  });

  it('drone spawn does NOT forward vertices and does NOT attach vertices to the record', () => {
    spawner.spawnDrone({ id: 'drone-1', x: 100, y: 100 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.vertices).toBeUndefined();
    expect(registry.get('drone-1')!.vertices).toBeUndefined();
  });

  it('asteroid spec without explicit mass falls back to ASTEROID_DEFAULT_MASS', () => {
    spawner.spawnAsteroid({ id: 'rock', x: 0, y: 0, vx: 0, vy: 0, radius: 32 });
    expect(posted[0]!.mass).toBe(ASTEROID_DEFAULT_MASS);
  });

  it('asteroid spec WITH explicit mass overrides the default', () => {
    spawner.spawnAsteroid({ id: 'rock', x: 0, y: 0, vx: 0, vy: 0, radius: 32, mass: 7 });
    expect(posted[0]!.mass).toBe(7);
  });

  it('every swarm spawn registers with the lag-comp ring (mass-independent)', () => {
    spawner.spawnAsteroid({ id: 'rock', x: 0, y: 0, vx: 0, vy: 0, radius: 32 });
    spawner.spawnDrone({ id: 'drone-x', x: 0, y: 0 });
    expect(lagCompRegistered).toEqual(['rock', 'drone-x']);
  });

  it('explicit DroneSpec.kind wins over the pickDroneKind hook (Living World carry)', () => {
    const hookKind = SHIP_KINDS_LIST[0]!.id;
    const forcedKind = SHIP_KINDS_LIST[1]!.id;
    expect(forcedKind).not.toBe(hookKind); // catalogue has ≥2 distinct kinds
    spawner = new SwarmSpawner(registry, {
      takeSlot: () => availableSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass, vertices) =>
        posted.push({ slot, id, x, y, vx, vy, radius, mass, vertices }),
      sabF32: f32,
      sabU32: u32,
      pickDroneKind: () => hookKind,
    });
    expect(spawner.spawnDrone({ id: 'lwbot-0', x: 0, y: 0, kind: forcedKind })).toBe(true);
    expect(registry.get('lwbot-0')!.shipKind).toBe(forcedKind);
  });

  it('absent DroneSpec.kind falls back to the pickDroneKind hook (back-compat)', () => {
    const hookKind = SHIP_KINDS_LIST[1]!.id;
    spawner = new SwarmSpawner(registry, {
      takeSlot: () => availableSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass, vertices) =>
        posted.push({ slot, id, x, y, vx, vy, radius, mass, vertices }),
      sabF32: f32,
      sabU32: u32,
      pickDroneKind: () => hookKind,
    });
    expect(spawner.spawnDrone({ id: 'drone-legacy', x: 0, y: 0 })).toBe(true);
    expect(registry.get('drone-legacy')!.shipKind).toBe(hookKind);
  });
});

describe('pickRandomShipKind — engineering kinds excluded (capture ilhqk6)', () => {
  it('never returns an engineeringOnly kind across 5000 calls', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 5000; i++) {
      const id = pickRandomShipKind();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      const kind = SHIP_KINDS_LIST.find((k) => k.id === id)!;
      expect(kind.engineeringOnly, `picked ${id} ${n}× — engineering-only kinds must not leak into galaxy spawn pool`).toBeFalsy();
    }
    // Specifically: crossguard + el (the two kinds that triggered the
    // 2026-05-28 smoke-test bug — square ship rendered larger than its
    // shield bubble, and downstream lag from heavy chassis ramming-probe
    // logs in Sol Prime).
    expect(counts.has('crossguard')).toBe(false);
    expect(counts.has('el')).toBe(false);
    // Sanity: at least one gameplay kind got picked.
    expect(counts.size).toBeGreaterThan(0);
    // Sanity: catalogue still has the engineering kinds — we're filtering,
    // not deleting.
    expect(SHIP_KINDS.crossguard.engineeringOnly).toBe(true);
    expect(SHIP_KINDS.el.engineeringOnly).toBe(true);
  });
});
