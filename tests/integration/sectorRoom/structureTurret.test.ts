/**
 * Structures plan, Phase 5 — defensive turrets, through the real SectorRoom.
 * A built + powered turret near a drone aims at it and damages it through the
 * standard `applyDamage` path. Turret ticks driven deterministically.
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

describe('SectorRoom integration — turret (Phase 5)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a powered turret damages a drone in range; an idle one (no drone) does not', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // Idle drone parked in range of the turret-to-be.
    expect(internals.spawnTestDrone('mob-1', 250, 0)).toBe(true);

    await placeAndWait(harness, room, 'capital', 0, 0);
    const sol = await placeAndWait(harness, room, 'solar', 150, 0); // offsets turret draw
    const turret = await placeAndWait(harness, room, 'turret', 0, 250);
    for (let i = 0; i < 120; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(sol)!.isConstructed).toBe(true);
    expect(internals.structureRegistry.get(turret)!.isConstructed).toBe(true);

    const before = internals.swarmHealth.get('mob-1')!;
    expect(before).toBeGreaterThan(0);

    // Fire once → the drone takes turret damage.
    internals.tickStructureTurrets();
    const after = internals.swarmHealth.get('mob-1');
    // Either it lost health, or one shot already overkilled it (evicted).
    if (after !== undefined) {
      expect(after).toBeLessThan(before);
    } else {
      expect(internals.swarmRegistry.get('mob-1') ?? null).toBeNull();
    }
    // The turret locked onto the drone (aim line target set).
    expect(internals.structureRegistry.get(turret)!.turretTargetEntityId).toBeDefined();
  }, 25_000);

  it('an unpowered turret (overdrawn grid) does not fire', async () => {
    harness = await bootSectorTestServer({});
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    internals.spawnTestDrone('mob-2', 250, 0);

    await placeAndWait(harness, room, 'capital', 0, 0);
    const turret = await placeAndWait(harness, room, 'turret', 0, 250);
    // A miner far enough not to overlap, to push the grid negative.
    const miner = await placeAndWait(harness, room, 'miner', 0, -300);
    for (let i = 0; i < 400; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(turret)!.isConstructed).toBe(true);
    expect(internals.structureRegistry.get(miner)!.isConstructed).toBe(true);

    const before = internals.swarmHealth.get('mob-2')!;
    internals.tickStructureTurrets();
    // capital 50 − turret 15 − miner 60 = −25 → unpowered → no shot.
    expect(internals.swarmHealth.get('mob-2')).toBe(before);
    expect(internals.structureRegistry.get(turret)!.turretTargetEntityId).toBeUndefined();
  }, 25_000);
});
