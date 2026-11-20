/**
 * Loop 3R (owner 2026-11-20: "keep size, several at once") — the Shipyard
 * lays its hulls in SHIPYARD_BAY_COUNT bays down the slipway, built one after
 * another. One shared bay table (`shipyardBayKeel`, #15); the server picks the
 * bay from the yard's finished-build count (`shipyardBayOf(prodCycles)`),
 * spawns the finished hull on that bay's keel (`newHullOrigin`), and puts the
 * bay (+ queued count) on the row's `prodBay` byte for late joiners (#16).
 */
import { describe, expect, it, vi } from 'vitest';

// hullHandOff pulls in the persistence singleton (node:sqlite); not used here.
vi.mock('../../src/server/db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => undefined }));

import { ProductionSubsystem } from '../../src/server/structures/ProductionSubsystem.js';
import type { StructureRecord, StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { NEW_HULL_PARK_OFFSET, newHullOrigin } from '../../src/server/rooms/features/hullHandOff.js';
import { PROD_QUEUE_MAX, decodeProdBay, encodeProdBay } from '../../src/shared-types/production.js';
import { RECIPES } from '../../src/shared-types/recipes.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import { gateColliderBoxes, shipyardSlipFits, worldToLocal } from '../../src/core/structures/gateGeometry.js';
import {
  SHIPYARD_BAY_COUNT, SHIPYARD_BAY_LEN, SHIPYARD_SLIP_HALF_W, SHIPYARD_SLIP_X0, SHIPYARD_SLIP_X1,
  shipyardBayKeel, shipyardBayOf,
} from '../../src/core/articulation/rigs/heavyIndustry.js';

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

const bayAt = (localX: number): number => {
  for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) if (Math.abs(shipyardBayKeel(b).x - localX) < 1e-9) return b;
  return -1;
};

describe('Shipyard bays (loop 3R)', () => {
  it('the bays line the slipway, bay 0 at the bow, each long enough for any slip-built hull', () => {
    expect(SHIPYARD_BAY_COUNT).toBe(5);
    let longest = 0;
    for (const k of ['scout', 'fighter', 'interceptor', 'gunship', 'heavy', 'missile_frigate']) {
      if (shipyardSlipFits(k)) longest = Math.max(longest, 2 * getShipKind(k).radius);
    }
    expect(longest).toBeGreaterThan(0);
    expect(SHIPYARD_BAY_LEN).toBeGreaterThan(longest);
    for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) {
      const k = shipyardBayKeel(b);
      expect(k.y).toBe(0);
      expect(k.x - SHIPYARD_BAY_LEN / 2).toBeGreaterThanOrEqual(SHIPYARD_SLIP_X0 - 1e-9);
      expect(k.x + SHIPYARD_BAY_LEN / 2).toBeLessThanOrEqual(SHIPYARD_SLIP_X1 + 1e-9);
      if (b > 0) expect(k.x, 'each bay is further from the bow').toBeLessThan(shipyardBayKeel(b - 1).x);
    }
    expect(shipyardBayKeel(SHIPYARD_BAY_COUNT)).toBe(shipyardBayKeel(0));
  });

  it('builds go to bays 0,1,2 in turn', () => {
    const per = RECIPES.build_interceptor.inputs.minerals!;
    const capital = rec('c', 'capital', { minerals: per * 8 });
    const bay = rec('bay', 'cargo_bay', { hold: { goods: {}, blueprints: [] } });
    const yard = rec('y', 'shipyard', {
      recipe: 'build_interceptor',
      blueprint: { uid: 'bp', product: 'hull:interceptor', kind: 'bpo', runs: null, material: 0, output: 0, research: 0 },
    });
    const recs = [capital, bay, yard];
    const byId = new Map(recs.map((r) => [r.id, r]));
    const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
    const spawnedIn: number[] = [];
    const wireBays: number[] = [];
    const out = { bay: -1, queued: -1 };
    const prod = new ProductionSubsystem({
      registry, powered: () => true, componentOf: () => recs.map((r) => r.id),
      // The room's hook (SectorRoom): the hull spawns at the keel of the bay `prodCycles` names.
      launchHull: (r) => {
        spawnedIn.push(bayAt(newHullOrigin(r.kind, r.x, r.y, r.rot ?? 0, 'interceptor', r.prodCycles).x));
        return true;
      },
    });
    const pulses = RECIPES.build_interceptor.cyclePulses;
    for (let n = 0; n < 7; n++) {
      // Mid-build, the row's byte (structuresSlice) names the bay the hull is being built in.
      for (let i = 0; i < pulses - 1; i++) prod.pulse();
      wireBays.push(decodeProdBay(encodeProdBay(shipyardBayOf(yard.prodCycles), 0), out).bay);
      prod.pulse();
    }
    expect(spawnedIn).toEqual([0, 1, 2, 3, 4, 0, 1]);
    expect(wireBays).toEqual(spawnedIn);
    expect(yard.prodCycles).toBe(7);
  });

  it("a hull spawns at its bay's keel facing the bow", () => {
    const fp = getStructureKind('shipyard').footprint;
    const reach = fp.w / 2 + NEW_HULL_PARK_OFFSET;
    const local = { x: 0, y: 0 };
    for (const rot of [0, 90, 210]) {
      const yx = 500, yy = -300, a = (rot * Math.PI) / 180;
      for (let cycles = 0; cycles < SHIPYARD_BAY_COUNT + 2; cycles++) {
        const o = newHullOrigin('shipyard', yx, yy, rot, 'gunship', cycles);
        worldToLocal(yx, yy, a, o.x, o.y, local);
        expect(local.x).toBeCloseTo(shipyardBayKeel(cycles % SHIPYARD_BAY_COUNT).x, 6);
        expect(local.y).toBeCloseTo(0, 6);
        for (const b of gateColliderBoxes('shipyard')!) {
          expect(Math.abs(local.x - b.cx) < b.hw && Math.abs(local.y - b.cy) < b.hh, 'not in a solid part').toBe(false);
        }
        // Nose (-sin, cos) points along the bow (local +x).
        expect(-Math.sin(o.angle)).toBeCloseTo(Math.cos(a), 6);
        expect(Math.cos(o.angle)).toBeCloseTo(Math.sin(a), 6);
        // The same Move target beyond the bow, on the slip centre line: a
        // back-bay hull flies straight out over the bays ahead of it.
        expect(o.flyOut).toBe(true);
        worldToLocal(yx, yy, a, o.parkX, o.parkY, local);
        expect(local.x).toBeCloseTo(reach, 6);
        expect(Math.abs(local.y)).toBeLessThan(SHIPYARD_SLIP_HALF_W);
      }
    }
    // The Barge exception is unchanged.
    expect(newHullOrigin('shipyard', 0, 0, 0, 'barge', 3).flyOut).toBe(false);
  });

  it('the bay and queue reach a late joiner via state', () => {
    const out = { bay: -1, queued: -1 };
    for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) {
      for (let q = 0; q <= PROD_QUEUE_MAX; q++) {
        const v = encodeProdBay(b, q);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
        expect(decodeProdBay(v, out)).toEqual({ bay: b, queued: q });
      }
    }
    expect(decodeProdBay(encodeProdBay(2, 99), out).queued, 'queue capped').toBe(PROD_QUEUE_MAX);
    expect(encodeProdBay(0, 0), 'bay 0, nothing queued = the omitted default').toBe(0);
    expect(decodeProdBay(undefined, out)).toEqual({ bay: 0, queued: 0 });

    // The real room-state row, read by a late-joining client: tests/integration/sectorRoom/shipyard.test.ts.
  });
});
