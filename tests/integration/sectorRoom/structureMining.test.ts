/**
 * Structures plan, Phase 4 — mining, through the real SectorRoom. A built +
 * powered Miner near an asteroid extracts minerals each pulse and hauls them to
 * the Capital's bank. Pulses driven deterministically via _internals.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

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

describe('SectorRoom integration — mining (Phase 4)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a powered miner near an asteroid grows the capital mineral bank', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // Seed an asteroid within the miner's mining range.
    expect(internals.spawnTestAsteroid('mine-rock', 0, 600, 30)).toBe(true);

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const sol = await placeAndWait(harness, room, 'solar', 200, 0); // offsets miner power draw
    const miner = await placeAndWait(harness, room, 'miner', 0, 300);
    const capRec = internals.structureRegistry.get(cap)!;
    const minerRec = internals.structureRegistry.get(miner)!;

    // Build everything (construction drains the bank).
    for (let i = 0; i < 120; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(sol)!.isConstructed).toBe(true);
    expect(minerRec.isConstructed).toBe(true);

    // Now mining refills the bank, and the miner is locked onto the asteroid.
    const before = capRec.minerals;
    internals.pulseStructureGrid();
    expect(minerRec.miningTargetEntityId).toBeDefined();
    expect(capRec.minerals).toBeGreaterThan(before);
  }, 25_000);

  it('an UNPOWERED miner (no solar to offset its draw) mines nothing', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    internals.spawnTestAsteroid('mine-rock', 0, 600, 30);

    // Capital + miner, NO solar: capital 50 − miner 60 = −10 ⇒ unpowered grid.
    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    const miner = await placeAndWait(harness, room, 'miner', 0, 300);
    const capRec = internals.structureRegistry.get(cap)!;
    const minerRec = internals.structureRegistry.get(miner)!;
    for (let i = 0; i < 120; i++) internals.pulseStructureGrid();
    expect(minerRec.isConstructed).toBe(true);

    const before = capRec.minerals;
    internals.pulseStructureGrid();
    // Unpowered ⇒ no mining target locked, no extraction.
    expect(minerRec.miningTargetEntityId).toBeUndefined();
    expect(minerRec.minerals).toBe(0);
    // Capital bank doesn't grow from this miner (no haul).
    expect(capRec.minerals).toBe(before);
  }, 25_000);
});
