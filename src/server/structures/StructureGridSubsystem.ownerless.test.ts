/**
 * Capture plan 4E (S2) — a base whose last Capital is lost (destroyed or
 * packed) becomes ownerless (`none:<lostCapitalId>`) but keeps working:
 * still powered, no faction. A grid with another built Capital stays owned.
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { unownedOwner } from '../../shared-types/relations.js';

const OWNER = 'player-1';

/** A built, powered base: Capital → relay → Solar + Turret (the On/Off test
 *  layout, footprint units). `second` adds another Capital on the relay. */
function poweredBase(opts?: { second?: boolean; owner?: string }) {
  const owner = opts?.owner ?? OWNER;
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let counter = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    findNearestAsteroid: () => null,
    applyDamage: () => {},
    broadcastBeam: () => {},
  });
  const capital = placement.place(owner, 'capital', 0, 0, { rot: 180 })!;
  const relay = placement.place(owner, 'connector', 0, 350)!;
  const r = registry.get(relay)!;
  r.isConstructed = true;
  r.constructionProgress = r.constructionCost;
  health.set(relay, getStructureKind('connector').maxHealth);
  registry.topologyDirty = true;
  const second = opts?.second === true ? placement.place(owner, 'capital', 0, 1000, { rot: 0 }) : null;
  const solar = placement.place(owner, 'solar', 450, 500)!;
  const turret = placement.place(owner, 'turret', -130, 400)!;
  let now = 0;
  for (let i = 0; i < 120; i++) grid.pulse(now += 1000);
  expect(registry.get(turret)!.isConstructed).toBe(true);
  expect(grid.powerSummaryFor(turret).powered).toBe(true);
  return { registry, grid, capital, second, relay, solar, turret, pulse: () => grid.pulse(now += 1000) };
}

describe('a base that loses its last Capital (capture plan 4E)', () => {
  it('destroyed: the whole base turns ownerless and stays powered', () => {
    const b = poweredBase();
    b.registry.remove(b.capital); // every removal path ends here (combat, pack, take down)
    b.pulse();
    const none = unownedOwner(b.capital);
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(none);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
    expect(b.grid.powerSummaryFor(b.turret).supplyFrac).toBe(1);
  });

  it('two Capitals on one grid: losing one keeps the base owned', () => {
    const b = poweredBase({ second: true });
    expect(b.grid.componentMembersOf(b.relay)).toContain(b.second);
    b.registry.remove(b.capital);
    b.pulse();
    for (const id of [b.relay, b.solar, b.turret, b.second!]) expect(b.registry.get(id)!.owner).toBe(OWNER);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
  });

  it('packing the last Capital is the same as losing it', () => {
    const b = poweredBase();
    const cap = b.registry.get(b.capital)!;
    cap.prepaid = true; // placed from a crate: taking it down repacks it
    cap.isDeconstructing = true;
    for (let i = 0; i < 2000 && b.registry.has(b.capital); i++) b.pulse();
    expect(b.registry.has(b.capital)).toBe(false);
    b.pulse();
    const none = unownedOwner(b.capital);
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(none);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
  });

  it('an NPC base is left alone (S5 handles NPC bases)', () => {
    const npc = 'npc:traders:sol-3';
    const b = poweredBase({ owner: npc });
    b.registry.remove(b.capital);
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(npc);
  });
});
