/**
 * T2 (plan soft-leaping-truffle v3) — the convoy seams only a real room proves.
 * The flight sequencing is unit-tested over fake rooms (ConvoyDirector.test.ts);
 * here a seeded NPC base in a real SectorRoom must:
 *  - report itself for planning (`npcBaseTrade`: anchor storage, stock, a
 *    footprint box around its structures, use rates from its processors);
 *  - load a convoy hauler's hold in one atomic take;
 *  - have that hauler SPILL its hold when it's destroyed (the `hauler-convoy-`
 *    prefix inherits the hauler spill rule), and accept a release back in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { emptyHold } from '../../../src/core/cargo/hold.js';
import { CONVOY_HAULER_ID_PREFIX } from '../../../src/server/livingworld/directorBotIds.js';

describe('SectorRoom integration — NPC base convoys (T2)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('a seeded base reports itself, loads a convoy hold, and a killed convoy hauler spills it', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      npcBases: [{ baseId: 'b1', role: 'refinery', tier: 'settlement', seed: 12, x: 0, y: 0, features: ['minerals'] }],
    });
    await harness.connectActive(randomUUID());
    const room = harness.getServerRoom()!;

    const bases = room.npcBaseTrade();
    expect(bases).toHaveLength(1);
    const b = bases[0]!;
    expect(b.owner).toBe('npc:traders:b1');
    expect(b.box.x1 - b.box.x0).toBeGreaterThan(1000);
    expect(Object.keys(b.view.uses).length, 'processors and reactors use goods').toBeGreaterThan(0);
    const stocked = (Object.entries(b.view.stock) as Array<[string, number]>).find(([, n]) => n >= 10);
    expect(stocked, 'the base starts stocked').toBeDefined();
    const [good] = stocked!;

    // Load 10 into a convoy hauler's hold (one atomic take).
    const haulerId = `${CONVOY_HAULER_ID_PREFIX}t1`;
    const want = emptyHold();
    (want.goods as Record<string, number>)[good] = 10;
    const res = room.tradeTransfer(b.owner, b.networkUid, { take: { want, intoUid: haulerId, intoOwner: null } });
    expect((res?.taken.goods as Record<string, number> | undefined)?.[good]).toBe(10);
    expect(getHoldStore().get(haulerId)?.holderType).toBe('hauler');
    const after = room.npcBaseTrade()[0]!.view.stock as Record<string, number>;
    expect(after[good]).toBe((b.view.stock as Record<string, number>)[good]! - 10);

    // The hauler flies (as a swarm entity) and is destroyed: its hold spills.
    const x = (b.box.x0 + b.box.x1) / 2, y = b.box.y1 + 800;
    expect(room.spawnLivingWorldBot({ botId: haulerId, kind: 'trader-hauler', x, y })).toBe(true);
    const internal = room._internals;
    await harness.advance(100);
    // Shields absorb the hit that breaks them (no spillover), so hit twice.
    internal.applyDamage(haulerId, 'test', 1_000_000, x, y);
    await harness.advance(50);
    internal.applyDamage(haulerId, 'test', 1_000_000, x, y);
    await harness.advance(300);
    expect(getHoldStore().get(haulerId), 'a destroyed convoy hauler spills its hold').toBeUndefined();
  });
});
