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
