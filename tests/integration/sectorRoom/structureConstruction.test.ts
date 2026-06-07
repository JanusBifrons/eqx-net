/**
 * Structures plan, Phase 3 — the construction FLOW ECONOMY, through the real
 * SectorRoom. A blueprint builds gradually by draining minerals from connected
 * storage over pulses; it pauses when the source runs dry and resumes on
 * refill; an unbuilt node is a dead-end (can't relay to leaves behind it);
 * damaged built structures repair. Pulses are driven deterministically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import {
  CONSTRUCTION_PULSE_AMOUNT,
  REPAIR_PULSE_AMOUNT,
  REPAIR_COST_PER_HP,
} from '../../../src/core/structures/structureGridConstants.js';

async function placeAndWait(
  harness: SectorTestHarness,
  room: Awaited<ReturnType<SectorTestHarness['connectAs']>>,
  kind: string,
  x: number,
  y: number,
): Promise<string> {
  const internals = harness.getServerRoom()!._internals;
  const before = new Set<string>();
  for (const r of internals.structureRegistry.all()) before.add(r.id);
  room.send('place_structure', { type: 'place_structure', kind, x, y });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const r of internals.structureRegistry.all()) {
      if (!before.has(r.id)) return r.id;
    }
    await harness.advance(40);
  }
  throw new Error(`structure ${kind} never placed`);
}

describe('SectorRoom integration — construction flow economy (Phase 3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a connector blueprint builds up pulse-by-pulse, debiting the capital bank', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const capRec = internals.structureRegistry.get(cap)!;
    const conRec = internals.structureRegistry.get(con)!;
    const startMinerals = capRec.minerals;

    internals.pulseStructureGrid();
    expect(conRec.constructionProgress).toBe(CONSTRUCTION_PULSE_AMOUNT);
    expect(capRec.minerals).toBe(startMinerals - CONSTRUCTION_PULSE_AMOUNT);

    const cost = getStructureKind('connector').constructionCost;
    for (let i = 0; i < Math.ceil(cost / CONSTRUCTION_PULSE_AMOUNT); i++) internals.pulseStructureGrid();
    expect(conRec.isConstructed).toBe(true);
    expect(internals.swarmHealth.get(con)).toBe(getStructureKind('connector').maxHealth);
  }, 20_000);

  it('construction PAUSES when the bank is empty and RESUMES on refill (no progress lost)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const capRec = internals.structureRegistry.get(cap)!;
    const conRec = internals.structureRegistry.get(con)!;

    internals.pulseStructureGrid();
    const paused = conRec.constructionProgress;
    expect(paused).toBeGreaterThan(0);

    capRec.minerals = 0;
    internals.pulseStructureGrid();
    internals.pulseStructureGrid();
    expect(conRec.constructionProgress).toBe(paused); // frozen

    capRec.minerals = 1000;
    internals.pulseStructureGrid();
    expect(conRec.constructionProgress).toBe(paused + CONSTRUCTION_PULSE_AMOUNT); // resumed
  }, 20_000);

  it('dead-end: a leaf behind an UNBUILT connector gets nothing until it completes', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const sol = await placeAndWait(harness, room, 'solar', 600, 0);
    const conRec = internals.structureRegistry.get(con)!;
    const solRec = internals.structureRegistry.get(sol)!;

    const conPulses = Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < conPulses; i++) {
      internals.pulseStructureGrid();
      if (!conRec.isConstructed) expect(solRec.constructionProgress).toBe(0);
    }
    expect(conRec.isConstructed).toBe(true);
    expect(solRec.constructionProgress).toBe(0);

    internals.pulseStructureGrid(); // connector now relays
    expect(solRec.constructionProgress).toBeGreaterThan(0);
  }, 20_000);

  it('repair: a damaged built structure heals over pulses, debiting minerals', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const con = await placeAndWait(harness, room, 'connector', 300, 0);
    const capRec = internals.structureRegistry.get(cap)!;
    for (let i = 0; i < Math.ceil(getStructureKind('connector').constructionCost / CONSTRUCTION_PULSE_AMOUNT); i++) {
      internals.pulseStructureGrid();
    }
    expect(internals.structureRegistry.get(con)!.isConstructed).toBe(true);

    internals.swarmHealth.set(con, 50);
    const before = capRec.minerals;
    internals.pulseStructureGrid();
    expect(internals.swarmHealth.get(con)!).toBeCloseTo(50 + REPAIR_PULSE_AMOUNT / REPAIR_COST_PER_HP, 4);
    expect(capRec.minerals).toBeCloseTo(before - REPAIR_PULSE_AMOUNT, 4);
  }, 20_000);
});
