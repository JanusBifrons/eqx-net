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
  return { registry, grid, placement, capital, second, relay, solar, turret, pulse: () => grid.pulse(now += 1000) };
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

/** An ownerless base (its Capital destroyed) and its old pieces. */
function ownerlessBase() {
  const b = poweredBase();
  b.registry.remove(b.capital);
  b.pulse();
  const none = unownedOwner(b.capital);
  for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(none);
  return { ...b, none };
}

describe('capturing an ownerless base by linking to it (capture plan 4E S4)', () => {
  const FINDER = 'player-2';

  it('a Capital placed in link range takes the whole ownerless grid', () => {
    const b = ownerlessBase();
    const cap = b.placement.place(FINDER, 'capital', 0, 1000, { rot: 0 })!;
    expect(b.registry.hasConnection(cap, b.relay)).toBe(true);
    b.pulse();
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(FINDER);
    expect(b.grid.componentMembersOf(b.turret)).toContain(cap);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
  });

  it('a Connector bridging the finder\'s own base takes it once built', () => {
    const b = ownerlessBase();
    const cap = b.placement.place(FINDER, 'capital', 0, 1700, { rot: 0 })!;
    expect(b.registry.connectionCount(cap)).toBe(0); // out of reach on its own
    const bridge = b.placement.place(FINDER, 'connector', 0, 1000)!;
    expect(b.registry.hasConnection(bridge, b.relay)).toBe(true);
    expect(b.registry.hasConnection(bridge, cap)).toBe(true);
    b.pulse();
    // A blueprint bridge is never crossed: no capture until it is built.
    expect(b.registry.get(bridge)!.isConstructed).toBe(false);
    expect(b.registry.get(b.relay)!.owner).toBe(b.none);
    for (let i = 0; i < 120 && !b.registry.get(bridge)!.isConstructed; i++) b.pulse();
    expect(b.registry.get(bridge)!.isConstructed).toBe(true);
    b.pulse();
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(FINDER);
  });

  it('an NPC Capital nearby neither links to nor takes an ownerless base', () => {
    const b = ownerlessBase();
    const cap = b.placement.place('npc:traders:sol-3', 'capital', 0, 1000, { rot: 0 })!;
    b.pulse();
    expect(b.registry.hasConnection(cap, b.relay)).toBe(false);
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(b.none);
    // Even a link forced past the gate (old save, seeded layout) captures nothing.
    b.registry.addConnection(cap, b.relay, 1);
    b.pulse();
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(b.none);
  });

  it('two ownerless bases joined stay ownerless, each keeping its own owner', () => {
    const b = ownerlessBase();
    const other = unownedOwner('pstruct-lost-elsewhere');
    const c = b.placement.place(other, 'connector', 0, 1000)!;
    b.registry.get(c)!.isConstructed = true;
    expect(b.registry.hasConnection(c, b.relay)).toBe(false); // the gate refuses it
    b.registry.addConnection(c, b.relay, 1);
    b.pulse();
    expect(b.registry.get(c)!.owner).toBe(other);
    for (const id of [b.relay, b.solar, b.turret]) expect(b.registry.get(id)!.owner).toBe(b.none);
  });
});
