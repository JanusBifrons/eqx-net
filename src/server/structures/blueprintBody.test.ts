/**
 * Hologram pass-through (base loop 3F, server): an unbuilt blueprint is
 * spawned non-colliding, still reserves its space for placement, and turns
 * solid on completion only when no ship is inside it.
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { hullOverlapsFootprint, moveParkedHullsClear, type HullCircle } from './blueprintBody.js';

function makeHarness() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const spawns: Array<{ id: string; blueprint?: boolean }> = [];
  const solidified: string[] = [];
  const hulls: HullCircle[] = [];
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: (s) => { spawns.push({ id: s.id, ...(s.blueprint ? { blueprint: true } : {}) }); return true; },
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    registry,
    shipHulls: () => hulls,
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    findNearestAsteroid: () => null,
    shipHulls: () => hulls,
    solidify: (id) => solidified.push(id),
  });
  /** A blueprint that builds on time alone (prepaid), so no Capital route. */
  const blueprint = (x: number, y: number): string => {
    const id = placement.place('p1', 'connector', x, y)!;
    registry.get(id)!.prepaid = true;
    return id;
  };
  /** Pulse until the record is fully paid (or `max` pulses). */
  const pulseUntilPaid = (id: string, max = 500): void => {
    const rec = registry.get(id)!;
    for (let i = 0; i < max && rec.constructionProgress < rec.constructionCost; i++) grid.pulse(i);
  };
  return { registry, placement, grid, spawns, solidified, hulls, blueprint, pulseUntilPaid };
}

describe('hologram pass-through (server)', () => {
  it('an unbuilt blueprint does not block a ship: it spawns as a blueprint body', () => {
    const h = makeHarness();
    const bp = h.blueprint(0, 0);
    const cap = h.placement.place('p1', 'capital', 10_000, 0)!;
    expect(h.spawns.find((s) => s.id === bp)).toEqual({ id: bp, blueprint: true });
    expect(h.registry.get(bp)!.ghostBody).toBe(true);
    // A pre-built Capital spawns solid.
    expect(h.spawns.find((s) => s.id === cap)).toEqual({ id: cap });
    expect(h.registry.get(cap)!.ghostBody).toBeUndefined();
  });

  it('a blueprint still blocks another placement', () => {
    const h = makeHarness();
    h.blueprint(0, 0);
    expect(h.placement.place('p2', 'connector', 0, 0)).toBeNull();
  });

  it('it waits to turn solid while a ship is inside', () => {
    const h = makeHarness();
    const bp = h.blueprint(0, 0);
    const rec = h.registry.get(bp)!;
    h.hulls.push({ x: 10, y: -5, r: 20 });
    h.pulseUntilPaid(bp);
    expect(rec.constructionProgress).toBe(rec.constructionCost);
    for (let i = 0; i < 5; i++) h.grid.pulse(1_000 + i);
    expect(rec.isConstructed).toBe(false);
    expect(rec.ghostBody).toBe(true);
    expect(h.solidified).toEqual([]);
    // Prepaid progress never overshoots while it waits.
    expect(rec.constructionProgress).toBe(rec.constructionCost);

    h.hulls.length = 0; // the ship leaves
    h.grid.pulse(2_000);
    expect(rec.isConstructed).toBe(true);
    expect(rec.ghostBody).toBe(false);
    expect(h.solidified).toEqual([bp]);
    h.grid.pulse(3_000);
    expect(h.solidified).toEqual([bp]); // once
  });

  it('turns solid at once on completion when nothing is inside', () => {
    const h = makeHarness();
    const bp = h.blueprint(0, 0);
    h.hulls.push({ x: 5_000, y: 0, r: 50 }); // far away
    h.pulseUntilPaid(bp);
    h.grid.pulse(9_999);
    expect(h.registry.get(bp)!.isConstructed).toBe(true);
    expect(h.solidified).toEqual([bp]);
  });

  it('a structure built outside the pulse (restore, seeded base) turns solid on the next pulse', () => {
    const h = makeHarness();
    const bp = h.blueprint(0, 0);
    const rec = h.registry.get(bp)!;
    rec.isConstructed = true;
    rec.constructionProgress = rec.constructionCost;
    h.hulls.push({ x: 0, y: 0, r: 20 });
    h.grid.pulse(0);
    expect(h.solidified).toEqual([]);
    h.hulls.length = 0;
    h.grid.pulse(1);
    expect(h.solidified).toEqual([bp]);
  });

  it('a pre-built Capital placed round a ship starts as a hologram and turns solid once clear', () => {
    const h = makeHarness();
    h.hulls.push({ x: 0, y: 200, r: 44 }); // inside the 560 × 560 footprint
    const cap = h.placement.place('p1', 'capital', 0, 0)!;
    const rec = h.registry.get(cap)!;
    expect(h.spawns.find((s) => s.id === cap)).toEqual({ id: cap, blueprint: true });
    expect(rec.isConstructed).toBe(true);
    expect(rec.ghostBody).toBe(true);
    h.grid.pulse(0);
    expect(h.solidified).toEqual([]);
    h.hulls.length = 0; // the ship leaves
    h.grid.pulse(1);
    expect(rec.ghostBody).toBe(false);
    expect(h.solidified).toEqual([cap]);
  });

  it('moveParkedHullsClear orders only the parked hulls inside the footprint, as their owner', () => {
    const orders: Array<[string, string, number, number]> = [];
    const poses = new Map([['in', { x: 0, y: 250 }], ['out', { x: 0, y: 900 }], ['ownerless', { x: 0, y: 0 }]]);
    const ships: Record<string, { playerId: string; kind: string }> = {
      in: { playerId: 'p1', kind: 'fighter' }, out: { playerId: 'p1', kind: 'fighter' }, ownerless: { playerId: '', kind: 'fighter' },
    };
    const moved = moveParkedHullsClear({ x: 0, y: 0, radius: 396, halfW: 280, halfH: 280 }, {
      lingeringPoses: poses,
      ship: (id) => ships[id],
      extentOf: () => 44,
      landingPoint: (_p, x, y) => ({ x, y: y + 100 }),
      applyOrder: (owner, ids, o) => { orders.push([owner, ids[0]!, o.x, o.y]); return ids; },
    });
    expect(moved).toBe(1);
    expect(orders).toEqual([['p1', 'in', 0, 350]]);
  });

  it('hullOverlapsFootprint tests the footprint box against the hull circle', () => {
    const h = makeHarness();
    const rec = h.registry.get(h.blueprint(0, 0))!;
    const hw = rec.halfW!;
    expect(hullOverlapsFootprint(rec, { x: hw + 10, y: 0, r: 11 })).toBe(true);
    expect(hullOverlapsFootprint(rec, { x: hw + 10, y: 0, r: 9 })).toBe(false);
  });
});
