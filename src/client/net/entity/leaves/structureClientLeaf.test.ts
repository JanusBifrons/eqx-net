/**
 * Build mirror (base loop 4A-3): the client prediction body of a mirrored
 * structure must match the server collider (`SwarmSpawner.spawnStructure` →
 * `gateColliderPolygons(kind, mirror)`). The Shipyard's parts are lopsided, so
 * an unmirrored client body near a mirrored Shipyard is an invisible wall /
 * rubber-band. The flag rides the structure-state row (`mirror.structures`),
 * which may arrive after the swarm entry: the body is rebuilt ONCE then.
 */
import { describe, expect, it } from 'vitest';
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import { gateColliderPolygons } from '../../../../core/structures/gateGeometry.js';
import { StructureClientLeaf } from './structureClientLeaf.js';
import type { ClientSpawnCtx, ClientStructureFacts, PredWorldHandle } from '../IClientEntityLeaf.js';

type Parts = Array<Array<{ x: number; y: number }>> | undefined;

function fakeWorld() {
  const bodies = new Map<string, Parts>();
  let spawns = 0;
  let despawns = 0;
  const world = {
    hasShip: (k: string) => bodies.has(k),
    spawnObstacle: (k: string, _x: number, _y: number, _r: number, _m: number, _v: unknown, _a: number, _g: unknown, parts: Parts) => {
      bodies.set(k, parts);
      spawns++;
    },
    despawnShip: (k: string) => { bodies.delete(k); despawns++; },
    lockBody: () => undefined,
    setShipState: () => undefined,
    attachRig: () => undefined,
    setCollisionGroups: () => undefined,
    setHullExposed: () => undefined,
    setAngularDamping: () => undefined,
    setSleepSettle: () => undefined,
  };
  return {
    world: world as unknown as PredWorldHandle,
    parts: (k: string) => bodies.get(k),
    get spawns() { return spawns; },
    get despawns() { return despawns; },
  };
}

function ctxFor(w: PredWorldHandle, structures: Map<number, ClientStructureFacts>): ClientSpawnCtx {
  return {
    predWorld: w,
    aiController: { register: () => undefined, unregister: () => undefined } as unknown as ClientSpawnCtx['aiController'],
    structures,
    entityId: 7,
    key: 'swarm-7',
    entry: { x: 500, y: -200, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 300, kind: 2, shipKind: 'shipyard' } as SwarmRenderState,
    registeredAiId: null,
  };
}

describe('StructureClientLeaf — build mirror on the prediction body', () => {
  it('a mirrored Shipyard (row known at spawn) gets the server\'s mirrored collider parts', () => {
    const f = fakeWorld();
    const ctx = ctxFor(f.world, new Map([[7, { mirror: true }]]));
    const leaf = new StructureClientLeaf();
    leaf.spawnBody(ctx);
    leaf.onSync(ctx);
    expect(f.parts('swarm-7')).toEqual(gateColliderPolygons('shipyard', true));
    expect(f.spawns).toBe(1);
  });

  it('swarm entry first, row later: rebuilt once when the mirror flag arrives, never again', () => {
    const f = fakeWorld();
    const rows = new Map<number, ClientStructureFacts>();
    const ctx = ctxFor(f.world, rows);
    const leaf = new StructureClientLeaf();
    leaf.spawnBody(ctx);
    leaf.onSync(ctx);
    expect(f.parts('swarm-7')).toEqual(gateColliderPolygons('shipyard'));

    rows.set(7, { mirror: true });
    leaf.onSync(ctx);
    expect(f.parts('swarm-7')).toEqual(gateColliderPolygons('shipyard', true));
    expect(f.spawns).toBe(2);
    expect(f.despawns).toBe(1);

    for (let i = 0; i < 5; i++) leaf.onSync(ctx);
    expect(f.spawns).toBe(2); // not re-built per sync (#12)

    // Flag cleared (row rewritten): rebuilt back once.
    rows.set(7, {});
    leaf.onSync(ctx);
    leaf.onSync(ctx);
    expect(f.parts('swarm-7')).toEqual(gateColliderPolygons('shipyard'));
    expect(f.spawns).toBe(3);
  });

  it('an unmirrored Shipyard is never rebuilt', () => {
    const f = fakeWorld();
    const ctx = ctxFor(f.world, new Map([[7, {}]]));
    const leaf = new StructureClientLeaf();
    leaf.spawnBody(ctx);
    for (let i = 0; i < 3; i++) leaf.onSync(ctx);
    expect(f.parts('swarm-7')).toEqual(gateColliderPolygons('shipyard'));
    expect(f.spawns).toBe(1);
  });
});
