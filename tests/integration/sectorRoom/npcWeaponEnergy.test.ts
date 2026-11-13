/**
 * NPC weapons pay energy like a player's (owner rule 2026-11-13: "Ships
 * turning, acceleration, weapons, everything is related to the ship,
 * regardless of pilot").
 *
 * Bug: a player's slot trigger is refused unless `canAfford(pool,
 * resolveSlotEnergyCost(slot))` and then spends that cost
 * (PlayerFireResolver; the player side is locked by
 * slotFiringAndEnergy.test.ts), but `AiFireResolver` fired for free. The
 * virtual pilot already gave each NPC an energy pool for boost; guns must
 * draw on the same pool.
 *
 * Runs the real room path (`handleAiFire` → AiFireResolver) on a fighter
 * drone with its live HostileDroneBehaviour.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { resolveSlotEnergyCost } from '../../../src/core/combat/Energy.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

interface PoolView { getEnergy(): number; trySpendEnergy?(cost: number): boolean }

describe('SectorRoom integration — NPC weapons spend the ship energy pool', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a fighter drone pays the player slot cost per shot, stops when empty, resumes after regen', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      asteroidConfig: [],
      testMode: true,
      defaultSpawnX: -4000,
      defaultSpawnY: -4000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('en-shooter', 0, 0, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('en-target', 0, 2000, 'heavy')).toBe(true);
    await harness.advance(100);

    const r = room as unknown as {
      aiController: { getBehaviour(id: string): PoolView | null };
      aiFireResolver: { fireNow: (...a: unknown[]) => void };
      lastFireClientTick: Map<string, number>;
    };
    const brain = r.aiController.getBehaviour('en-shooter')!;
    expect(brain).not.toBeNull();
    let shots = 0;
    const origFire = r.aiFireResolver.fireNow.bind(r.aiFireResolver);
    r.aiFireResolver.fireNow = (...a: unknown[]) => { if (a[0] === 'en-shooter') shots++; origFire(...a); };

    // The same cost a player flying a fighter pays per slot trigger.
    const cost = resolveSlotEnergyCost(getShipKind('fighter'));
    expect(cost).toBeGreaterThan(0);

    // 1) One shot drains exactly the slot cost (synchronous: no regen tick between).
    const e0 = brain.getEnergy();
    internals.aiFire('en-shooter', 0, 1, 'en-target');
    expect(shots, 'the first trigger fired').toBe(1);
    expect(e0 - brain.getEnergy(), 'energy per NPC shot == player slot cost').toBeCloseTo(cost, 6);

    // 2) Empty pool (e.g. boost drained it): the trigger is refused and spends no cooldown.
    await harness.advance(300); // past the 10-tick cooldown
    while (brain.trySpendEnergy?.(cost)) { /* drain */ }
    const fireTickBefore = r.lastFireClientTick.get('en-shooter');
    const shotsBefore = shots;
    // Fire right after draining: regen adds < one shot before this sync call.
    expect(brain.getEnergy()).toBeLessThan(cost);
    internals.aiFire('en-shooter', 0, 1, 'en-target');
    expect(shots, 'refused on an empty pool').toBe(shotsBefore);
    expect(r.lastFireClientTick.get('en-shooter'), 'a refused shot spends no cooldown').toBe(fireTickBefore);

    // 3) After regen it fires again.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && brain.getEnergy() < cost) await harness.advance(50);
    expect(brain.getEnergy()).toBeGreaterThanOrEqual(cost);
    internals.aiFire('en-shooter', 0, 1, 'en-target');
    expect(shots, 'fires again after regen').toBe(shotsBefore + 1);
  });
});
