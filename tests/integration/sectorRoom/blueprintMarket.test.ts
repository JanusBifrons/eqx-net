/**
 * Economy v2 W6 (plan peppy-jumping-pinwheel) — the BLUEPRINT MARKET through a
 * real SectorRoom and the real `bp_market_query` / `bp_buy` / `bp_sell`
 * messages (sent with `type`, as the real client does).
 *
 *  1. the view lists the traders' board and the base's own blueprints (names);
 *  2. buying debits the wallet, puts the blueprint into storage, and takes the
 *     offer off the board; a short wallet is refused;
 *  3. selling credits the wallet and removes it from storage;
 *  4. another pilot's storage is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { BlueprintMarket, setBlueprintMarket } from '../../../src/server/economy/BlueprintMarket.js';
import type { BpMarketState } from '../../../src/shared-types/blueprintMarket.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('SectorRoom integration — blueprint market (economy v2 W6)', () => {
  let harness: SectorTestHarness;
  const owner = randomUUID();
  beforeEach(async () => {
    setBlueprintMarket(new BlueprintMarket());
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
      prebuiltStructuresOwner: owner,
    });
  }, 15_000);
  afterEach(async () => {
    setBlueprintMarket(null);
    if (harness) await harness.cleanup();
  }, 10_000);

  it('buys from the board into storage and sells back for credits', { timeout: 30_000 }, async () => {
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 900, shipKind: 'fighter' });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const cap = [...internal.structureRegistry.all()].find((s) => s.kind === 'capital')!;
    const capEid = internal.swarmRegistry.get(cap.id)!.entityId;
    cap.hold = { goods: {}, blueprints: [{ uid: 'mine-1', product: 'hull:gunship', kind: 'bpc', runs: 3, material: 2, output: 20, research: 0 }] };
    const replies: BpMarketState[] = [];
    cr.onMessage('bp_market_state', (m: BpMarketState) => replies.push(m));
    const ask = async (type: string, body: Record<string, unknown>): Promise<BpMarketState> => {
      const n = replies.length;
      cr.send(type, { type, networkEntityId: capEid, ...body });
      expect(await until(() => replies.length > n, 4000)).toBe(true);
      return replies[replies.length - 1]!;
    };

    // 1. The view.
    const v = await ask('bp_market_query', {});
    expect(v.offers.length).toBeGreaterThan(0);
    expect(v.mine.map((b) => b.name)).toEqual(['Gunship']);
    expect(v.mine[0]!.price).toBeGreaterThan(0);

    // 2. A short wallet is refused; then buy.
    const offer = v.offers[0]!;
    const poor = await ask('bp_buy', { offerId: offer.id });
    expect(poor.ok).toBe(false);
    expect(poor.message).toMatch(/You need/);
    getWallet().credit(owner, offer.price + 1000, 'test');
    const w0 = getWallet().balance(owner);
    const bought = await ask('bp_buy', { offerId: offer.id });
    expect(bought.ok, bought.message).toBe(true);
    expect(getWallet().balance(owner)).toBe(w0 - offer.price);
    expect(cap.hold.blueprints).toHaveLength(2);
    expect(bought.offers.map((o) => o.id)).not.toContain(offer.id);
    expect((await ask('bp_buy', { offerId: offer.id })).ok).toBe(false); // already sold

    // 3. Sell my gunship copy.
    const sellPrice = bought.mine.find((b) => b.id === 'mine-1')!.price;
    const w1 = getWallet().balance(owner);
    const sold = await ask('bp_sell', { uid: 'mine-1' });
    expect(sold.ok, sold.message).toBe(true);
    expect(getWallet().balance(owner)).toBe(w1 + sellPrice);
    expect(cap.hold.blueprints.some((b) => b.uid === 'mine-1')).toBe(false);
  });

  it('another pilot’s storage is refused', { timeout: 30_000 }, async () => {
    const thief = randomUUID();
    const cr = await harness.connectActive(thief, { spawnX: 0, spawnY: 900, shipKind: 'fighter' });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const cap = [...internal.structureRegistry.all()].find((s) => s.kind === 'capital')!;
    cap.hold = { goods: {}, blueprints: [{ uid: 'mine-1', product: 'hull:gunship', kind: 'bpc', runs: 3, material: 2, output: 20, research: 0 }] };
    const replies: BpMarketState[] = [];
    cr.onMessage('bp_market_state', (m: BpMarketState) => replies.push(m));
    cr.send('bp_sell', { type: 'bp_sell', networkEntityId: internal.swarmRegistry.get(cap.id)!.entityId, uid: 'mine-1' });
    expect(await until(() => replies.length > 0, 4000)).toBe(true);
    expect(replies[0]!.ok).toBe(false);
    expect(replies[0]!.mine).toEqual([]);
    expect(cap.hold.blueprints).toHaveLength(1);
  });
});
