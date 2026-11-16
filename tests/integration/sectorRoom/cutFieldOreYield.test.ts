/**
 * Macro terrain v2 F1b (yield by hit point): a mining-laser hit on a cut-field
 * rock pays out the ore the field holds WHERE the beam landed (`oreAt` at the
 * hit point → `oreRow`), through the one ore path (`OreDraw`): a rich spot
 * gives ore, plain rock gives minerals. The pool stays size-based.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SwarmEntityRecord } from '../../../src/server/net/SwarmEntityRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { ORE_UNITS_PER_DAMAGE } from '../../../src/server/rooms/OreDraw.js';
import { oreAt, oreSeed } from '../../../src/core/terrain/fieldOre.js';
import { SLICED } from '../../../src/core/terrain/fieldLayout.js';
import { oreRow, yieldInto } from '../../../src/shared-types/asteroidResources.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

const SEED = 'look';
const conc = (x: number, y: number) => oreAt(oreSeed(SEED), SLICED.radius, x, y, { ice: 0, crystal: 0 });

/** Points on a resting field rock: its centre and halfway to each corner. */
function pointsOn(rec: SwarmEntityRecord): Array<{ x: number; y: number }> {
  const out = [{ x: rec.restX!, y: rec.restY! }];
  for (const v of rec.vertices ?? []) out.push({ x: rec.restX! + v.x / 2, y: rec.restY! + v.y / 2 });
  return out;
}

describe('SectorRoom integration — cut-field ore by hit point (F1b)', () => {
  it('a mining-laser hit pays the ore at the point it landed', { timeout: 40_000 }, async () => {
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

    // The richest and the plainest point on any loaded rock.
    let rich = { rec: rocks[0]!, x: 0, y: 0, ore: -1 };
    let plain = { rec: rocks[0]!, x: 0, y: 0, ore: 2 };
    for (const rec of rocks) for (const p of pointsOn(rec)) {
      const c = conc(p.x, p.y), ore = c.ice + c.crystal;
      if (ore > rich.ore) rich = { rec, ...p, ore };
      if (ore < plain.ore) plain = { rec, ...p, ore };
    }
    expect(rich.ore, 'the seed has ore near the lane').toBeGreaterThan(0.2);
    expect(plain.ore).toBeLessThan(0.05);

    const goods = () => ({ ...(getHoldStore().get(shipId)?.hold.goods ?? {}) });
    for (const spot of [rich, plain]) {
      const before = goods();
      const pool0 = spot.rec.resources!;
      for (let i = 0; i < 12; i++) int.applyDamage(spot.rec.id, pid, 120, spot.x, spot.y, undefined, undefined, 'mining_laser');
      int.pulseStructureGrid();
      const drawn = pool0 - spot.rec.resources!;
      expect(drawn, 'the pool pays by size, as before').toBe(Math.floor(12 * 120 * ORE_UNITS_PER_DAMAGE));
      const want = yieldInto(oreRow(conc(spot.x, spot.y), {}), drawn, {});
      const after = goods();
      for (const g of ['minerals', 'ice', 'crystal'] as const) {
        expect((after[g] ?? 0) - (before[g] ?? 0), `${g} at the ${spot === rich ? 'rich' : 'plain'} spot`).toBe(want[g] ?? 0);
      }
    }
    const got = goods();
    expect((got.ice ?? 0) + (got.crystal ?? 0), 'the rich spot paid ore').toBeGreaterThan(0);

    // No hit point (a robot harvester, the grid Miner): the ore at the rock's centre.
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
