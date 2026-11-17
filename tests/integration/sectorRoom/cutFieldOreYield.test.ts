/**
 * Macro terrain v2: a robot harvester or grid Miner drawing from a cut-field
 * rock gets the ore the field holds at the rock's centre (`oreAt` →
 * `oreRow`), through the one ore path (`OreDraw.mine`). The mining laser
 * pays no ore per hit (only its cut pieces' pods do: oreDraw.test.ts), and
 * neither does any other weapon.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SwarmEntityRecord } from '../../../src/server/net/SwarmEntityRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { oreAt, oreSeed } from '../../../src/core/terrain/fieldOre.js';
import { SLICED } from '../../../src/core/terrain/fieldLayout.js';
import { oreRow, yieldInto } from '../../../src/shared-types/asteroidResources.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

const SEED = 'look';
const conc = (x: number, y: number) => oreAt(oreSeed(SEED), SLICED.radius, x, y, { ice: 0, crystal: 0 });

describe('SectorRoom integration — cut-field ore at the rock centre', () => {
  it('a harvester draws the ore at the rock centre; a mining-laser hit pays nothing', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', testMode: true, cutField: { seed: SEED }, asteroidConfig: [], droneCount: 0 });
    const pid = randomUUID();
    await harness.connectActive(pid, { shipKind: 'fighter', initialHull: 1_000_000, spawnX: -30_120, spawnY: 26_501 });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = room._internals;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = id;
    expect(shipId).not.toBe('');

    // Let the field stream in around the ship.
    const rocks: SwarmEntityRecord[] = [];
    const deadline = Date.now() + 15_000;
    while (rocks.length < 50 && Date.now() < deadline) {
      await harness.advance(250);
      rocks.length = 0;
      for (const r of int.swarmRegistry.all()) if (r.fieldRock === true) rocks.push(r);
    }
    expect(rocks.length, 'field rocks streamed in').toBeGreaterThan(0);
    for (const r of rocks) expect([r.restX, r.restY], 'a field rock keeps its rest centre').not.toContain(undefined);

    // A mining-laser hit on a field rock: no ore into the hold, none out of the pool.
    const goods = () => ({ ...(getHoldStore().get(shipId)?.hold.goods ?? {}) });
    const hit = rocks[0]!, hitPool0 = hit.resources!;
    for (let i = 0; i < 12; i++) int.applyDamage(hit.id, pid, 120, hit.restX!, hit.restY!, undefined, undefined, 'mining_laser');
    int.pulseStructureGrid();
    expect(hit.resources, 'no ore per hit').toBe(hitPool0);
    expect(goods(), 'nothing into the hold').toEqual({});

    // A robot harvester (or the grid Miner): the ore at the rock's centre.
    let core = rocks[0]!, coreOre = -1;
    for (const r of rocks) { const c = conc(r.restX!, r.restY!); if (c.ice + c.crystal > coreOre) { core = r; coreOre = c.ice + c.crystal; } }
    expect(coreOre, 'a rock centred on ore').toBeGreaterThan(0.2);
    const pool0 = core.resources!;
    room.mineAsteroid('harvester-test', core.entityId, 30, 1e6);
    const drawn = pool0 - core.resources!;
    expect(drawn).toBe(30);
    const want = yieldInto(oreRow(conc(core.restX!, core.restY!), {}), drawn, {});
    const hold = getHoldStore().get('harvester-test')?.hold.goods ?? {};
    for (const g of ['minerals', 'ice', 'crystal'] as const) expect(hold[g] ?? 0, `harvester ${g}`).toBe(want[g] ?? 0);
  });
});
