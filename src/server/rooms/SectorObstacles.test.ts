import { describe, it, expect } from 'vitest';
import { SectorObstacles, type HullSink, type SectorObstacleSources, type WallSink } from './SectorObstacles.js';
import { SLOT_X_OFF, SLOT_Y_OFF, SAB_TOTAL_BYTES, slotBase } from '../../shared-types/sabLayout.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import type { GridObstacle, ObstacleBox } from '../../core/structures/Grid.js';

interface Hull { x: number; y: number; kind?: string; playerId?: string; shipId?: string; pending?: boolean }

function world() {
  const sab = new Float32Array(SAB_TOTAL_BYTES / 4);
  const swarm: SwarmEntityRecord[] = [];
  const structures: StructureRecord[] = [];
  const hulls: Hull[] = [];
  const walls: Array<[number, number, number, number, number]> = [];
  const dormant: GridObstacle[] = [];
  const dormantFlags: Array<boolean | undefined> = [];
  const addSwarm = (kind: number, x: number, y: number, radius: number, extra: Partial<SwarmEntityRecord> = {}) => {
    const slot = swarm.length;
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y;
    swarm.push({ id: `e${slot}`, kind, slot, radius, ...extra } as SwarmEntityRecord);
  };
  const src: SectorObstacleSources = {
    structures: { all: () => structures },
    swarm: { all: () => swarm },
    sab: () => sab,
    dormantRocks: (box: ObstacleBox, out: GridObstacle[], wrecks?: boolean) => {
      dormantFlags.push(wrecks);
      for (const d of dormant) if (d.x >= box.x0 && d.x <= box.x1 && d.y >= box.y0 && d.y <= box.y1) out.push(d);
    },
    forEachHull: (sink: HullSink) => { for (const h of hulls) sink.hull(h.x, h.y, h.kind, h.playerId, h.shipId, h.pending ?? false); },
    forEachWall: (sink: WallSink) => { for (const w of walls) sink.wall(...w); },
    clearanceOf: (k) => (k === 'big' ? 500 : 60),
    extentOf: (k) => (k === 'big' ? 400 : k === 'small' ? 50 : undefined),
  };
  return { sab, swarm, structures, hulls, walls, dormant, dormantFlags, addSwarm, g: new SectorObstacles(src) };
}

describe('SectorObstacles (navigation slice 2: the one obstacle gatherer)', () => {
  it('rocks: live kind-0 bodies at their SAB pose, plus dormant field rocks only with a box', () => {
    const w = world();
    w.addSwarm(0, 100, 200, 30, { vertices: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    w.addSwarm(1, 0, 0, 20); // a drone: not a rock
    w.dormant.push({ x: 5000, y: 0, radius: 90 });
    const r = w.g.rocks();
    expect(r.map((o) => [o.x, o.y, o.radius])).toEqual([[100, 200, 30]]);
    expect(r[0]!.parts).toHaveLength(1);
    expect(w.g.rocks({ x0: 4000, y0: -100, x1: 6000, y1: 100 }).map((o) => o.radius)).toEqual([30, 90]);
  });

  it('rocks: wreck pieces (kind 4, by their parts) and unloaded wrecks only when placement opts in (wreck fields 7)', () => {
    const w = world();
    const parts = [[{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 0, y: 40 }]];
    w.addSwarm(0, 100, 0, 30);
    w.addSwarm(4, 500, 0, 70, { wreckParts: parts });
    const box = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
    // Link line of sight (no flag): rocks only, as before.
    expect(w.g.rocks(box).map((o) => o.radius)).toEqual([30]);
    expect(w.g.rocks().map((o) => o.radius)).toEqual([30]);
    // Placement: the wreck piece too, with its convex parts and SAB pose.
    const r = w.g.rocks(box, true);
    expect(r.map((o) => [o.x, o.radius])).toEqual([[100, 30], [500, 70]]);
    expect(r[1]!.parts).toBe(parts);
    // The flag reaches the dormant query (unloaded wreck hulls) only for placement.
    expect(w.dormantFlags).toEqual([false, true]);
  });

  it('reuses its records and part lists on repeat calls (#14)', () => {
    const w = world();
    for (let i = 0; i < 20; i++) w.addSwarm(0, i * 100, 0, 30, { vertices: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], fieldRock: true });
    w.structures.push({ id: 's', kind: 'relay', x: 0, y: 0, radius: 50 } as unknown as StructureRecord);
    w.hulls.push({ x: 300, y: 0, kind: 'small', playerId: 'other' });
    const r1 = [...w.g.rocks()], parts1 = r1.map((o) => o.parts);
    w.g.landing('me', 0, 0, 10_000);
    const b1 = [...w.g.boxes], c1 = [...w.g.circles];
    for (let k = 0; k < 5; k++) { w.g.rocks(); w.g.landing('me', 0, 0, 10_000); }
    w.g.rocks().forEach((o, i) => { expect(o).toBe(r1[i]); expect(o.parts).toBe(parts1[i]); });
    w.g.landing('me', 0, 0, 10_000);
    w.g.boxes.forEach((o, i) => expect(o).toBe(b1[i]));
    w.g.circles.forEach((o, i) => expect(o).toBe(c1[i]));
  });

  it('landing: structures, every nearby swarm body, dormant rocks, other hulls and blocking walls; own hulls skipped', () => {
    const w = world();
    w.structures.push({ id: 's', kind: 'relay', x: 10, y: 20, radius: 50, halfW: 40, halfH: 30 } as unknown as StructureRecord);
    w.addSwarm(0, 100, 0, 30);        // rock
    w.addSwarm(4, 200, 0, 70);        // wreck piece
    w.addSwarm(1, 99_000, 0, 20);     // far drone: outside `near`
    w.dormant.push({ x: 300, y: 0, radius: 90 });
    w.hulls.push({ x: 400, y: 0, kind: 'big', playerId: 'other' });
    w.hulls.push({ x: 500, y: 0, kind: 'big', playerId: 'me' });                 // own active ship
    w.hulls.push({ x: 600, y: 0, kind: 'small', playerId: 'me', shipId: 'p1' }); // own parked hull
    w.walls.push([0, 0, 100, 0, 15]);
    w.g.landing('me', 0, 0, 5000);
    expect(w.g.boxes.map((b) => [b.x, b.y, b.hw, b.hh])).toEqual([[10, 20, 40, 30]]);
    expect(w.g.circles.map((c) => [c.x, c.r])).toEqual([[100, 30], [200, 70], [300, 90], [400, 500]]);
    expect(w.g.walls.map((s) => s.r)).toEqual([15]);
  });

  it('landing with onlySkipShipId: own hulls are obstacles, only that ship is skipped', () => {
    const w = world();
    w.hulls.push({ x: 500, y: 0, kind: 'big', playerId: 'me' });
    w.hulls.push({ x: 600, y: 0, kind: 'small', playerId: 'me', shipId: 'p1' });
    w.hulls.push({ x: 700, y: 0, kind: 'small', playerId: 'me', shipId: 'p2' });
    w.g.landing('me', 0, 0, 5000, 'p1');
    expect(w.g.circles.map((c) => c.x)).toEqual([500, 700]);
  });

  it('hullCircles: AI ships by extent, other pilots, no own hulls, no pilots still joining', () => {
    const w = world();
    w.addSwarm(1, 10, 0, 20, { shipKind: 'big' } as Partial<SwarmEntityRecord>);
    w.addSwarm(1, 20, 0, 25, { shipKind: 'not-a-kind' } as Partial<SwarmEntityRecord>);
    w.addSwarm(0, 30, 0, 99); // rock: not a hull
    w.hulls.push({ x: 40, y: 0, kind: 'small', playerId: 'other' });
    w.hulls.push({ x: 50, y: 0, kind: 'small', playerId: 'joining', pending: true });
    w.hulls.push({ x: 60, y: 0, kind: 'small', playerId: 'me' });
    w.hulls.push({ x: 70, y: 0, kind: 'big', playerId: 'other', shipId: 'p9' });
    w.hulls.push({ x: 80, y: 0, kind: 'big', playerId: 'me', shipId: 'p1' });
    expect(w.g.hullCircles('me').map((c) => [c.x, c.r])).toEqual([[10, 400], [20, 25], [40, 50], [70, 400]]);
  });
});
