import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmSpawner, type AsteroidSpec } from './SwarmSpawner.js';
import { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_FLAGS_OFF,
  FLAG_IS_SWARM, FLAG_KIND_DRONE,
} from '../../shared-types/sabLayout.js';

interface PostedCmd {
  slot: number; id: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number;
}

describe('SwarmSpawner', () => {
  let registry: SwarmEntityRegistry;
  let spawner: SwarmSpawner;
  let f32: Float32Array;
  let u32: Uint32Array;
  let posted: PostedCmd[];
  let availableSlots: number[];

  beforeEach(() => {
    registry = new SwarmEntityRegistry();
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    f32 = new Float32Array(sab);
    u32 = new Uint32Array(sab);
    posted = [];
    availableSlots = [10, 11, 12]; // pre-stocked pool
    spawner = new SwarmSpawner(registry, {
      takeSlot: () => availableSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass) => posted.push({ slot, id, x, y, vx, vy, radius, mass }),
      sabF32: f32,
      sabU32: u32,
    });
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
});
