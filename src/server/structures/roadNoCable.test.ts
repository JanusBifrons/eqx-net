/**
 * Base platforms slice 34 — owner: "Roads take no cable at all. A road belongs
 * to a base because it sits on that base's deck. You build it like any deck
 * tile, with no wiring step, and no cable ever ends on a road." The road
 * links to nothing (placement, the reconnect sweep, a manual reconnect, a
 * restore: all go through `canConnect`), yet it still builds from its owner's
 * Capital along the route to the anchor of the plate it sits on
 * (`deckTileFunding.ts`).
 */
import { describe, expect, it } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { autoConnectStructure } from './structureGridView.js';
import { deckTileFundingTarget } from './deckTileFunding.js';
import { HEX_DIRS } from '../../core/hex/hex.js';
import { deckHexCentreInto, plateCentreHex, plateCentreWorldInto } from '../../core/hex/plates.js';
import { BUILD_STALL_NOT_CONNECTED } from '../../shared-types/structureStateWire.js';

function makeHarness() {
  const registry = new StructureRegistry();
  registry.deck = true;
  const health = new Map<string, number>();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    registry,
    shipHulls: () => [],
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: () => {},
    findNearestAsteroid: () => null,
    shipHulls: () => [],
    solidify: () => {},
  });
  return { registry, placement, grid };
}

/** Centre of outer hex `k` of plate (i, j). */
function outerHex(i: number, j: number, k: number): { x: number; y: number } {
  const c = plateCentreHex(i, j), d = HEX_DIRS[k]!;
  return deckHexCentreInto(c.q + d.q, c.r + d.r, { x: 0, y: 0 });
}

/** A deck base: plate (0, 0)'s anchor and a Capital on its outer hex 0. */
function base() {
  const h = makeHarness();
  const at = plateCentreWorldInto(0, 0, { x: 0, y: 0 });
  const anchor = h.placement.place('p1', 'connector', at.x, at.y)!;
  const cap = outerHex(0, 0, 0);
  const capital = h.placement.place('p1', 'capital', cap.x, cap.y)!;
  expect(anchor, 'anchor placed').toBeTruthy();
  expect(capital, 'capital placed').toBeTruthy();
  expect(h.registry.connectionCount(capital), 'capital on the anchor').toBe(1);
  return { ...h, anchor, capital };
}

const pulseUntil = (grid: StructureGridSubsystem, done: () => boolean, max = 600): void => {
  for (let t = 1; t <= max && !done(); t++) grid.pulse(t * 1000);
};

describe('roads take no cable (base platforms 34)', () => {
  it('a placed road links to nothing, and builds from the Capital via its plate anchor', () => {
    const h = base();
    const p = outerHex(0, 0, 3);
    const road = h.placement.place('p1', 'road', p.x, p.y, { rot: 30 })!;
    expect(road).toBeTruthy();
    expect(h.registry.connectionCount(road), 'no cable on placement').toBe(0);
    expect(deckTileFundingTarget(h.registry, road)).toBe(h.anchor);
    const capital = h.registry.get(h.capital)!;
    const bank = capital.minerals;
    const rec = h.registry.get(road)!;
    pulseUntil(h.grid, () => rec.isConstructed);
    expect(rec.isConstructed, 'the road builds with no wiring step').toBe(true);
    expect(capital.minerals, 'paid from the Capital').toBeLessThan(bank);
    expect(h.registry.connectionCount(road), 'the reconnect sweep never wires it').toBe(0);
  });

  it('no cable at any time: auto-connect and a manual reconnect both refuse', () => {
    const h = base();
    const p = outerHex(0, 0, 3);
    const road = h.placement.place('p1', 'road', p.x, p.y, { rot: 30 })!;
    expect(autoConnectStructure(h.registry, road)).toBeNull();
    h.grid.reconnect(road);
    expect(h.registry.connectionCount(road)).toBe(0);
  });

  it('a road with no anchor of its owner on its plate is paused: not connected', () => {
    const h = base();
    // Plate (0, 0) is p1's; a p2 road there has no anchor of its own.
    const p = outerHex(0, 0, 3);
    const road = h.placement.place('p2', 'road', p.x, p.y, { rot: 30 })!;
    expect(road).toBeTruthy();
    expect(deckTileFundingTarget(h.registry, road)).toBe(road);
    const rec = h.registry.get(road)!;
    pulseUntil(h.grid, () => rec.isConstructed, 30);
    expect(rec.isConstructed).toBe(false);
    expect(h.grid.buildStallReason(rec)).toBe(BUILD_STALL_NOT_CONNECTED);
  });

  it('a restore re-derives links through the same rule: a saved road comes back with no cable', () => {
    // Links are never saved: `restoreStructures` re-places every row through
    // `place` (auto-connect). Re-placing the road beside a live anchor is that path.
    const h = base();
    const p = outerHex(0, 0, 3);
    const road = h.placement.place('p1', 'road', p.x, p.y, { rot: 90 })!;
    h.grid.pulse(1000);
    expect(h.registry.connectionCount(road)).toBe(0);
  });

  it('a building other than a road still links to its anchor', () => {
    const h = base();
    const p = outerHex(0, 0, 3);
    const solar = h.placement.place('p1', 'solar', p.x, p.y)!;
    expect(solar).toBeTruthy();
    expect(h.registry.connectionCount(solar)).toBe(1);
    expect(deckTileFundingTarget(h.registry, solar)).toBe(solar);
  });
});
