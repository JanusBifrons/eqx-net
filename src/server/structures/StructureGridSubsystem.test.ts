import { describe, it, expect, beforeEach } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_COST_PER_HP,
} from '../../core/structures/structureGridConstants.js';

/** Shared harness: a real registry + health map, with placement + grid wired
 *  over the same state (the way SectorRoom wires them). */
function makeHarness(asteroid?: { entityId: number; x: number; y: number; range?: number }) {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const despawned: string[] = [];
  let counter = 0;

  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { despawned.push(id); health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });

  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { despawned.push(id); health.delete(id); },
    findNearestAsteroid: (x, y, range) => {
      if (!asteroid) return null;
      const dx = asteroid.x - x;
      const dy = asteroid.y - y;
      if (Math.hypot(dx, dy) > range) return null;
      return { entityId: asteroid.entityId, x: asteroid.x, y: asteroid.y };
    },
  });

  let now = 0;
  const pulse = () => { now += 1000; return grid.pulse(now); };
  return { registry, health, despawned, placement, grid, pulse };
}

const OWNER = 'player-1';

describe('StructureGridSubsystem — auto-connect on place', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a connector placed in range of the capital auto-links to it', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    expect(h.registry.hasConnection(cap, con)).toBe(true);
    expect(h.registry.connectionCount(con)).toBe(1);
  });

  it('a leaf placed near another leaf (no hub in range) stays unconnected', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    expect(cap).toBeTruthy();
    // Two solars far from the capital but near each other → hub rule blocks them.
    const s1 = h.placement.place(OWNER, 'solar', 3000, 0)!;
    const s2 = h.placement.place(OWNER, 'solar', 3120, 0)!;
    expect(h.registry.connectionCount(s1)).toBe(0);
    expect(h.registry.connectionCount(s2)).toBe(0);
  });

  it('does not connect structures owned by different players', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place('player-2', 'connector', 200, 0)!;
    expect(h.registry.hasConnection(cap, con)).toBe(false);
  });
});

describe('StructureGridSubsystem — construction flow economy', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a connector blueprint builds up pulse-by-pulse, debiting the capital', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const cost = getStructureKind('connector').constructionCost;
    const capRec = h.registry.get(cap)!;
    const conRec = h.registry.get(con)!;
    const startMinerals = capRec.minerals;
    expect(conRec.isConstructed).toBe(false);

    h.pulse();
    expect(conRec.constructionProgress).toBe(CONSTRUCTION_PULSE_AMOUNT);
    expect(capRec.minerals).toBe(startMinerals - CONSTRUCTION_PULSE_AMOUNT);

    // Drive to completion.
    const pulsesNeeded = Math.ceil(cost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 1; i < pulsesNeeded; i++) h.pulse();
    expect(conRec.isConstructed).toBe(true);
    expect(conRec.constructionProgress).toBe(cost);
    // HP reset to full on completion.
    expect(h.health.get(con)).toBe(getStructureKind('connector').maxHealth);
  });

  it('construction PAUSES when the capital runs dry and RESUMES on refill', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const capRec = h.registry.get(cap)!;
    const conRec = h.registry.get(con)!;

    h.pulse();
    const progressAfterOne = conRec.constructionProgress;
    expect(progressAfterOne).toBeGreaterThan(0);

    // Empty the bank → construction stalls (no progress, no negative minerals).
    capRec.minerals = 0;
    h.pulse();
    h.pulse();
    expect(conRec.constructionProgress).toBe(progressAfterOne);
    expect(capRec.minerals).toBe(0);

    // Refill → resumes exactly where it paused (no progress lost).
    capRec.minerals = 1000;
    h.pulse();
    expect(conRec.constructionProgress).toBe(progressAfterOne + CONSTRUCTION_PULSE_AMOUNT);
  });

  it('dead-end: a leaf behind an UNBUILT connector receives nothing until it completes', () => {
    h.placement.place(OWNER, 'capital', 0, 0);
    const con = h.placement.place(OWNER, 'connector', 300, 0)!;
    const sol = h.placement.place(OWNER, 'solar', 600, 0)!;
    const conRec = h.registry.get(con)!;
    const solRec = h.registry.get(sol)!;
    // Solar should hang off the connector (nearest hub), not the capital.
    expect(h.registry.hasConnection(sol, con)).toBe(true);

    // While the connector is a blueprint, the solar gets zero (can't relay
    // through a half-built node).
    const conCost = getStructureKind('connector').constructionCost;
    const pulsesToBuildCon = Math.ceil(conCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulsesToBuildCon; i++) {
      h.pulse();
      if (!conRec.isConstructed) expect(solRec.constructionProgress).toBe(0);
    }
    expect(conRec.isConstructed).toBe(true);
    expect(solRec.constructionProgress).toBe(0); // still 0 the pulse it completes

    // Now the connector relays → the solar starts building.
    h.pulse();
    expect(solRec.constructionProgress).toBeGreaterThan(0);
  });
});

describe('StructureGridSubsystem — repair + deconstruction', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a damaged BUILT structure repairs over pulses, debiting minerals', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const conRec = h.registry.get(con)!;
    const capRec = h.registry.get(cap)!;
    // Fast-build the connector.
    const pulses = Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulses; i++) h.pulse();
    expect(conRec.isConstructed).toBe(true);

    // Damage it, then repair.
    h.health.set(con, 50);
    const mineralsBefore = capRec.minerals;
    h.pulse();
    const expectedGain = REPAIR_PULSE_AMOUNT / REPAIR_COST_PER_HP; // 30 HP
    expect(h.health.get(con)).toBeCloseTo(50 + expectedGain, 5);
    expect(capRec.minerals).toBeCloseTo(mineralsBefore - REPAIR_PULSE_AMOUNT, 5);
  });

  it('deconstruction drains progress, returns minerals, and removes the structure', () => {
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!;
    const conRec = h.registry.get(con)!;
    const capRec = h.registry.get(cap)!;
    const pulses = Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulses; i++) h.pulse();
    const mineralsBefore = capRec.minerals;

    conRec.isDeconstructing = true;
    h.pulse(); // DECONSTRUCTION_RATE_KG (100) ≥ connector cost (80) → one pulse
    expect(h.registry.has(con)).toBe(false);
    expect(h.despawned).toContain(con);
    expect(capRec.minerals).toBeGreaterThan(mineralsBefore); // reclaimed
  });
});

describe('StructureGridSubsystem — mining (Phase 4)', () => {
  it('a built + powered miner extracts minerals and hauls them to the capital', async () => {
    // Asteroid at (250,0), within the miner's miningRange.
    const h = makeHarness({ entityId: 7, x: 250, y: 0 });
    h.placement.place(OWNER, 'capital', 0, 0);
    // Solar to offset the miner's power draw (miner consumes 60; cap 50 + solar 30 = 80).
    const sol = h.placement.place(OWNER, 'solar', 200, 0)!;
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    const capRec = [...h.registry.all()].find((r) => r.kind === 'capital')!;

    // Build solar + miner.
    for (let i = 0; i < 200; i++) h.pulse();
    expect(h.registry.get(sol)!.isConstructed).toBe(true);
    expect(h.registry.get(miner)!.isConstructed).toBe(true);

    const before = capRec.minerals;
    h.pulse();
    // The miner mined + hauled this pulse → capital bank grew.
    expect(capRec.minerals).toBeGreaterThan(before);
    expect(h.registry.get(miner)!.miningTargetEntityId).toBe(7);
  });

  it('an UNPOWERED miner does not mine (no asteroid target set)', () => {
    // Asteroid in range, but no solar → miner draws the grid negative.
    const h = makeHarness({ entityId: 9, x: 250, y: 0 });
    h.placement.place(OWNER, 'capital', 0, 0);
    const miner = h.placement.place(OWNER, 'miner', 0, 300)!;
    // Build the miner (construction itself isn't power-gated).
    for (let i = 0; i < 400; i++) h.pulse();
    const minerRec = h.registry.get(miner)!;
    expect(minerRec.isConstructed).toBe(true);
    // Capital 50 − miner 60 = −10 → unpowered → no mining target, no minerals.
    h.pulse();
    expect(minerRec.miningTargetEntityId).toBeUndefined();
    expect(minerRec.minerals).toBe(0);
  });
});

describe('StructureGridSubsystem — power summary', () => {
  it('a built capital→connector→solar web reports powered + summed netPower', () => {
    const h = makeHarness();
    h.placement.place(OWNER, 'capital', 0, 0);
    const con = h.placement.place(OWNER, 'connector', 300, 0)!;
    const sol = h.placement.place(OWNER, 'solar', 600, 0)!;
    // Build connector then solar (drive enough pulses for both).
    for (let i = 0; i < 60; i++) h.pulse();
    expect(h.registry.get(con)!.isConstructed).toBe(true);
    expect(h.registry.get(sol)!.isConstructed).toBe(true);
    // pulse once more so the final topology rebuild ran.
    h.pulse();
    const summary = h.grid.powerSummaryFor(sol);
    expect(summary.powered).toBe(true);
    expect(summary.netPower).toBe(80); // capital 50 + solar 30
  });
});
