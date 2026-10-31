/**
 * Procedural bases through the REAL room + physics worker
 * (plan: soft-leaping-truffle, PR-V2).
 *
 *  - the base descriptor reaches a joining client via room state (no geometry
 *    on the wire — the client regenerates; Invariant #16);
 *  - a spawn requested INSIDE solid geometry is nudged to a clear point (the
 *    colliders are hollow outlines, so a body inside one would be trapped);
 *  - the worker's union-outline colliders stop a ship flying into a wall;
 *  - the server beam path (`blockShotAtWall`, used by both fire resolvers)
 *    stops at a base wall.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { generateBase } from '../../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../../src/core/procgen/baseLayout.js';
import { basePieceIndex } from '../../../src/shared-types/basePieceKinds.js';

const BASE = { archetype: 'warehouse' as const, seed: 42, x: 0, y: 0, size: 6000 };
const layout = generateBase({ ver: BASE_GENERATOR_VERSION, ...BASE });

/** Centre of the first rack row piece — a point guaranteed to be solid. */
function solidPoint(): { x: number; y: number } {
  const rack = basePieceIndex('rack_row');
  for (let i = 0; i < layout.count; i++) {
    if (layout.kind[i] === rack) return { x: layout.x[i]! + layout.w[i]! / 2, y: layout.y[i]! + layout.h[i]! / 2 };
  }
  throw new Error('no rack in layout');
}

function room(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

async function poseOf(h: SectorTestHarness, cr: Awaited<ReturnType<SectorTestHarness['connectActive']>>, pid: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    h.sendThrust(cr);
    const snap = await h.waitForSnapshot(cr, 2000);
    for (const st of Object.values(snap.states ?? {})) {
      const s = st as { playerId?: string; x: number; y: number };
      if (s.playerId === pid) return { x: s.x, y: s.y };
    }
  }
  throw new Error('no pose for ' + pid);
}

describe('SectorRoom integration — procedural bases', () => {
  let h: SectorTestHarness;
  const inside = solidPoint();
  beforeEach(async () => {
    h = await bootSectorTestServer({
      droneCount: 0,
      asteroidConfig: [],
      bases: [BASE],
      // Ask to spawn INSIDE a rack row: the room must nudge it clear.
      defaultSpawnX: inside.x,
      defaultSpawnY: inside.y,
    });
  }, 20_000);
  afterEach(async () => {
    if (h) await h.cleanup();
  }, 10_000);

  it('publishes the base descriptor in room state (client regenerates geometry)', async () => {
    const cr = await h.connectActive(randomUUID());
    const state = cr.state as unknown as SectorState;
    const b = state.bases.get('b0');
    expect(b).toBeDefined();
    expect(b!.seed).toBe(42);
    expect(b!.size).toBe(6000);
    expect(b!.originX).toBe(0);
    expect(b!.archetype).toBe('warehouse');
    expect(b!.ver).toBe(BASE_GENERATOR_VERSION);
  });

  it('a spawn requested inside solid geometry is nudged to a clear point', async () => {
    const pid = randomUUID();
    const cr = await h.connectActive(pid);
    const internal = room(cr.roomId)._internals;
    const pose = await poseOf(h, cr, pid);
    expect(internal.bases.isPointClear(pose.x, pose.y, 20)).toBe(true);
    expect(Math.hypot(pose.x - inside.x, pose.y - inside.y)).toBeLessThan(800);
  });

  it('the worker colliders stop a ship flying into the outer wall', async () => {
    const pid = randomUUID();
    const cr = await h.connectActive(pid);
    const internal = room(cr.roomId)._internals;
    // West wall, outside, at a y well away from any west gate; nose along +x.
    let y = 0;
    for (let g = 0; g < layout.gates.length; g += 2) {
      if (layout.gates[g] === -layout.half && Math.abs(layout.gates[g + 1]!) < 900) y = layout.gates[g + 1]! > 0 ? -1400 : 1400;
    }
    const x0 = -layout.half - 400;
    internal.postToWorker({ type: 'SET_POSITION', entityId: pid, x: x0, y, angle: -Math.PI / 2, vx: 900, vy: 0, angvel: 0 });
    await h.advance(1500);
    const pose = await poseOf(h, cr, pid);
    // It really flew (≈ 400 u to the wall at 900 u/s) — not a stalled body…
    expect(pose.x).toBeGreaterThan(x0 + 250);
    // …and the wall stopped it on the outside.
    expect(pose.x).toBeLessThan(-layout.half);
  });

  it('beams stop at a base wall (the shared fire-resolver block)', async () => {
    const cr = await h.connectActive(randomUUID());
    const internal = room(cr.roomId)._internals;
    // Fire east at the west wall from 300 u outside it, along y = 1400/-1400
    // (clear of gates is not required for a beam: posts/walls both block).
    const y = 1400;
    const d = internal.blockShotAtWall(-layout.half - 300, y, 1, 0, 2000, 10);
    const wallClear = internal.bases.rayFirst(-layout.half - 300, y, 1, 0, 2000);
    expect(wallClear).toBeGreaterThan(0);
    expect(d).toBeCloseTo(wallClear, 6);
    // A shot that misses every base wall is not blocked.
    expect(internal.blockShotAtWall(-layout.half - 300, y, -1, 0, 2000, 10)).toBeNull();
  });
});

describe('SectorRoom integration — destructible base pieces (PR-D)', () => {
  let h: SectorTestHarness;
  beforeEach(async () => {
    h = await bootSectorTestServer({
      droneCount: 0,
      asteroidConfig: [],
      bases: [BASE],
      baseHpScale: 0.0001, // bespoke trigger: one shot breaks a piece
      defaultSpawnX: 0,
      defaultSpawnY: -layout.half - 600,
    });
  }, 20_000);
  afterEach(async () => {
    if (h) await h.cleanup();
  }, 10_000);

  it('a shot destroys a rack: room state carries the hole, the worker opens it, a late joiner sees it', async () => {
    const pid = randomUUID();
    const cr = await h.connectActive(pid);
    const internal = room(cr.roomId)._internals;
    // A rack and a firing line straight along +x into its middle.
    let i = 0;
    while (layout.kind[i] !== basePieceIndex('rack_row')) i++;
    const y = layout.y[i]! + layout.h[i]! / 2;
    const x0 = layout.x[i]! - 150;
    expect(internal.bases.rayFirst(x0, y, 1, 0, 400)).toBeGreaterThan(0);
    internal.blockShotAtWall(x0, y, 1, 0, 400, 50);

    // Room state → the connected client.
    const deadOn = (s: SectorState): boolean => {
      const b = s.bases.get('b0');
      return !!b && Array.from(b.dead).some((w) => w !== 0);
    };
    const t0 = Date.now();
    while (!deadOn(cr.state as unknown as SectorState) && Date.now() - t0 < 3000) await h.advance(50);
    expect(deadOn(cr.state as unknown as SectorState)).toBe(true);

    // The worker rebuilt its colliders: a ship flies into where the rack was.
    internal.postToWorker({ type: 'SET_POSITION', entityId: pid, x: x0, y, angle: -Math.PI / 2, vx: 700, vy: 0, angvel: 0 });
    // Poll the condition with a deadline (a fixed sleep flaked on a loaded host).
    let px = -Infinity;
    const t1 = Date.now();
    while (px <= layout.x[i]! + 60 && Date.now() - t1 < 4000) {
      px = (await poseOf(h, cr, pid)).x;
      if (px <= layout.x[i]! + 60) await h.advance(100);
    }
    expect(px).toBeGreaterThan(layout.x[i]! + 60);

    // A late joiner reconstructs the same hole from room state alone.
    const late = await h.connectActive(randomUUID());
    expect(deadOn(late.state as unknown as SectorState)).toBe(true);
  });
});

// PR-K2 — the CITY archetype rides the same pipeline (descriptor → worker
// regenerates → outline colliders). Lock that city pieces really collide and
// block beams on the authoritative side, not just render.
describe('SectorRoom integration — city base (PR-K2)', () => {
  const CITY = { archetype: 'city' as const, seed: 42, x: 0, y: 0, size: 6000 };
  const city = generateBase({ ver: BASE_GENERATOR_VERSION, ...CITY });
  const tower = basePieceIndex('tower');
  /** The largest tower piece (a solid target well clear of the spawn). */
  function bigTower(): number {
    let best = -1;
    let area = 0;
    for (let i = 0; i < city.count; i++) {
      if (city.kind[i] === tower && city.w[i]! * city.h[i]! > area) {
        area = city.w[i]! * city.h[i]!;
        best = i;
      }
    }
    if (best < 0) throw new Error('no tower in city');
    return best;
  }
  /**
   * A start point in the street west of the big tower's building: scan west
   * from the tower's west face until the ship fits and has ≥ 300 u of run-up
   * before the first solid piece east of it.
   */
  function streetStart(bases: SectorRoom['_internals']['bases']): { x0: number; y: number } {
    const t = bigTower();
    const y = city.y[t]! + city.h[t]! / 2;
    for (let x0 = city.x[t]! - 32; x0 > -city.half - 600; x0 -= 16) {
      if (bases.isPointClear(x0, y, 40) && bases.rayFirst(x0, y, 1, 0, 2000) >= 300) return { x0, y };
    }
    throw new Error('no street start west of the tower');
  }
  let h: SectorTestHarness;
  beforeEach(async () => {
    h = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [], bases: [CITY], defaultSpawnX: 0, defaultSpawnY: -3400 });
  }, 20_000);
  afterEach(async () => {
    if (h) await h.cleanup();
  }, 10_000);

  it('publishes a city descriptor, and a ship flown at a tower is stopped by it', async () => {
    const pid = randomUUID();
    const cr = await h.connectActive(pid);
    expect((cr.state as unknown as SectorState).bases.get('b0')!.archetype).toBe('city');
    const internal = room(cr.roomId)._internals;
    const { x0, y } = streetStart(internal.bases);
    // Distance to the first solid thing east of the start (the tower or a
    // building wing in front of it): the ship must stop before it.
    const hitD = internal.bases.rayFirst(x0, y, 1, 0, 2000);
    expect(hitD).toBeGreaterThan(250);
    internal.postToWorker({ type: 'SET_POSITION', entityId: pid, x: x0, y, angle: -Math.PI / 2, vx: 900, vy: 0, angvel: 0 });
    await h.advance(1500);
    const pose = await poseOf(h, cr, pid);
    expect(pose.x).toBeGreaterThan(x0 + 150); // it flew…
    expect(pose.x).toBeLessThan(x0 + hitD); // …and the building stopped it
  });

  it('beams stop at a city tower', async () => {
    const cr = await h.connectActive(randomUUID());
    const internal = room(cr.roomId)._internals;
    const { x0, y } = streetStart(internal.bases);
    const d = internal.blockShotAtWall(x0, y, 1, 0, 2000, 10);
    expect(d).not.toBeNull();
    expect(d!).toBeLessThanOrEqual(city.x[bigTower()]! - x0 + 1e-6);
  });
});
