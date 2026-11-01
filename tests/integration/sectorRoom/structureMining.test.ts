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
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // Seed an asteroid within the miner's mining range.
    expect(internals.spawnTestAsteroid('mine-rock', -500, 900, 30)).toBe(true);

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    // WS-5 capital-only-connectors: leaves route through a Connector relay
    // offset above the Capital (its LOS clears for both the +x solar + +y miner).
    await placeAndWait(harness, room, 'connector', 0, 350);
    const sol = await placeAndWait(harness, room, 'solar', 250, 400); // offsets miner power draw
    const miner = await placeAndWait(harness, room, 'miner', -180, 420);
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

  it('an overdrawn miner browns out: it drills only on alternate pulses', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    internals.spawnTestAsteroid('mine-rock', -500, 900, 30);

    // Capital + miner, NO solar: capital 50 − miner 60 = −10 ⇒ unpowered grid.
    // WS-5: the miner routes via a Connector relay (still draws the grid
    // negative, so the component stays unpowered — the behaviour under test).
    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    await placeAndWait(harness, room, 'connector', 0, 350);
    const miner = await placeAndWait(harness, room, 'miner', -180, 420);
    const capRec = internals.structureRegistry.get(cap)!;
    const minerRec = internals.structureRegistry.get(miner)!;
    for (let i = 0; i < 120; i++) internals.pulseStructureGrid();
    expect(minerRec.isConstructed).toBe(true);

    const before = capRec.minerals;
    internals.pulseStructureGrid();
    // Active power: idle, the miner draws a trickle (capital 50 − 12 > 0), so
    // it powers up and locks the rock; drilling draws its full 60 (net −10),
    // so the next pulse it is unpowered and drops the target. Brown-out.
    const active: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      internals.pulseStructureGrid();
      active.push(minerRec.miningTargetEntityId !== undefined);
    }
    for (let i = 1; i < active.length; i++) expect(active[i]).toBe(!active[i - 1]);
    expect(capRec.minerals + minerRec.minerals).toBeGreaterThanOrEqual(before);
  }, 25_000);
});
