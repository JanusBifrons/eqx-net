import { describe, it, expect } from 'vitest';
import { StructureRegistry, type StructureRecord } from '../structures/StructureRegistry.js';
import { structureNavObstacle } from './RoomNav.js';
import { structureHalfExtents, structureKindToIndex, type StructureKindId } from '../../shared-types/structureKinds.js';
import { pointToShipPolygonDistance } from '../../core/combat/Weapons.js';

function rec(id: string, kind: StructureKindId, x: number, y: number, rot = 0): StructureRecord {
  const { hw, hh } = structureHalfExtents(kind, rot);
  return {
    id, owner: 'p1', kind, subtypeIndex: structureKindToIndex(kind), x, y, radius: 20, rot, halfW: hw, halfH: hh,
    isConstructed: true, constructionProgress: 0, constructionCost: 0, isDeconstructing: false, minerals: 0, storedPower: 0, level: 1,
  };
}

describe('structures as the fine nav layer\'s static obstacles (nav fine rebuild slice C1)', () => {
  it('the registry tells listeners of each add and each real removal, once; unsubscribe stops it', () => {
    const reg = new StructureRegistry(), seen: string[] = [];
    const off = reg.onChange((r, added) => seen.push(`${added ? '+' : '-'}${r.id}`));
    reg.add(rec('a', 'capital', 0, 0));
    reg.remove('a');
    reg.remove('a'); // despawn-then-remove callers: the second finds nothing
    off();
    reg.add(rec('b', 'capital', 0, 0));
    expect(seen).toEqual(['+a', '-a']);
  });

  it('a structure\'s obstacle is its collider: the footprint at its quarter turn, the circle enclosing it', () => {
    const r = rec('c', 'capital', 1000, 2000, 90), o = structureNavObstacle(r);
    const { hw, hh } = structureHalfExtents('capital', 90); // the rotated box every rule reads
    expect(o.radius).toBeCloseTo(Math.hypot(hw, hh), 6);
    expect(pointToShipPolygonDistance(1000 + hw + 50, 2000, o.x, o.y, o.angle!, o.parts!)).toBeCloseTo(50, 4);
    expect(pointToShipPolygonDistance(1000, 2000 + hh + 70, o.x, o.y, o.angle!, o.parts!)).toBeCloseTo(70, 4);
    expect(pointToShipPolygonDistance(1000, 2000, o.x, o.y, o.angle!, o.parts!)).toBe(0);
  });

  it('a gate keeps its gap open (posts as separate parts, as its physics body)', () => {
    const o = structureNavObstacle(rec('g', 'shield_gate', 0, 0));
    expect(o.parts!.length).toBeGreaterThan(1);
    expect(pointToShipPolygonDistance(0, 0, 0, 0, o.angle!, o.parts!)).toBeGreaterThan(0);
  });
});
