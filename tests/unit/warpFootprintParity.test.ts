/**
 * Warp route check, invariant #15: the server's structure footprints
 * (`WarpRouteCheck` over the registry, a gate's boxes from its swarm record
 * as `SwarmSpawner` sets them) and the client's (`WarpRouteClient` over the
 * structure mirror + swarm entries) are the same boxes for the same
 * structures. If they differ, the client offers a near side the server
 * refuses.
 */
import { describe, expect, it } from 'vitest';
import { WarpRouteCheck } from '../../src/server/rooms/warpRouteCheck.js';
import { gateHitBoxes, writeDoorLeafBoxes } from '../../src/server/structures/doorLeafBoxes.js';
import { DOOR_POS_MAX } from '../../src/core/structures/gateGeometry.js';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { WarpRouteClient } from '../../src/client/components/warpRoute.js';
import { newWarpTarget } from '../../src/core/galaxy/warpTarget.js';
import type { WarpStructureFootprint } from '../../src/core/nav/warpLineStop.js';
import { STRUCTURE_KINDS_LIST } from '../../src/shared-types/structureKinds.js';

interface Placed { id: number; kind: string; x: number; y: number; rot: number; mirror: boolean }

const KINDS = [STRUCTURE_KINDS_LIST[0]!.id, 'shield_gate', 'shield_airlock', 'alien_gate'];
const placed: Placed[] = [];
let n = 1;
for (const kind of KINDS) {
  for (const rot of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      placed.push({ id: n, kind, x: n * 1234.5, y: -n * 321.25, rot, mirror });
      n++;
    }
  }
}

const p0 = (x: number) => ({ p0: x, t0: 0, dir: 1 as const, level: 0 });

const fp = (): WarpStructureFootprint => ({ x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined });

describe('warp structure footprints: server and client agree (#15)', () => {
  /** Doors: end A / end B position per structure (server re-poses the swarm
   *  record's leaves as GateController does; the client reads the row's segments). */
  const check = (doorA: number, doorB: number): void => {
    const recs = new Map<string, StructureRecord>();
    const swarmBoxes = new Map<string, Float32Array>();
    for (const p of placed) {
      const id = String(p.id);
      recs.set(id, { id, owner: 'o', kind: p.kind, subtypeIndex: 0, x: p.x, y: p.y, radius: 100, rot: p.rot, mirror: p.mirror, isConstructed: true } as StructureRecord);
      const b = gateHitBoxes(p.kind, (p.rot * Math.PI) / 180, p.mirror);
      if (b) { writeDoorLeafBoxes(p.kind, (p.rot * Math.PI) / 180, doorA, doorB, b); swarmBoxes.set(id, b); }
    }
    const server = new WarpRouteCheck({
      sectorKey: () => null, solar: () => false, fieldOpts: () => null,
      structures: { all: () => recs.values() }, gateBoxes: (id) => swarmBoxes.get(id),
      pose: () => undefined, kindOf: () => 'fighter', accepted: () => false,
    });
    server.targetFor('fighter', 0, 0, 1, 0, newWarpTarget()); // gathers the registry

    const client = new WarpRouteClient().gather({
      structures: new Map(placed.map((p) => [p.id, { mirror: p.mirror, doorA: p0(doorA), doorB: p0(doorB) }])),
      swarm: new Map(placed.map((p) => [p.id, { x: p.x, y: p.y, angle: (p.rot * Math.PI) / 180, shipKind: p.kind }])),
    });

    expect(client.count).toBe(server.count);
    expect(swarmBoxes.size).toBeGreaterThan(0);
    const a = fp(), b = fp();
    for (let i = 0; i < server.count; i++) {
      server.footprint(i, a);
      client.footprint(i, b);
      expect(b.x).toBe(a.x);
      expect(b.y).toBe(a.y);
      expect(b.halfW).toBe(a.halfW);
      expect(b.halfH).toBe(a.halfH);
      expect(b.boxes ? Array.from(b.boxes) : null).toEqual(a.boxes ? Array.from(a.boxes) : null);
    }
  };

  it('gives the same box (and gate part boxes) for every structure, doors shut', () => check(0, 0));

  it('poses the door leaves the same with a door open or part open', () => {
    check(DOOR_POS_MAX, 0);
    check(DOOR_POS_MAX >> 1, DOOR_POS_MAX);
  });

  it('an open door moves the leaf boxes (the check sees door state)', () => {
    const shut = gateHitBoxes('shield_gate', 0, false)!;
    const open = gateHitBoxes('shield_gate', 0, false)!;
    writeDoorLeafBoxes('shield_gate', 0, DOOR_POS_MAX, 0, open);
    expect(Array.from(open)).not.toEqual(Array.from(shut));
  });

  it('forgets the gate boxes of structures that are gone', () => {
    const g = placed.find((p) => p.kind === 'shield_gate')!;
    const row = new Map([[g.id, { mirror: false }]]);
    const sw = new Map([[g.id, { x: 0, y: 0, angle: 0, shipKind: 'shield_gate' }]]);
    const c = new WarpRouteClient().gather({ structures: row, swarm: sw });
    c.footprint(0, fp());
    expect(c.cachedGateBoxes).toBe(1);
    c.gather({ structures: new Map(), swarm: sw });
    expect(c.cachedGateBoxes).toBe(0);
  });
});
