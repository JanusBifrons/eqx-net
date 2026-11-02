/**
 * T4 (plan soft-leaping-truffle v3) — buy from and sell to an NPC base's
 * Freight Dock over the real `cargo_query` / `cargo_move` messages.
 *
 * A neutral pilot opening an NPC Freight Dock gets a MARKET (not free access):
 * the base's stock with the trade board's prices. Take buys (wallet pays, the
 * goods come from the base's storage network), Put sells (the dock takes the
 * goods, the wallet is paid). Each is one atomic group.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore, getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector, type TradeRoom } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import type { CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function ask(cr: Room, replies: CargoState[], type: 'cargo_query' | 'cargo_move', body: object): Promise<CargoState> {
  const n = replies.length;
  cr.send(type, { type, ...body });
  return until(() => replies.length > n, 4000).then((ok) => {
    if (!ok) throw new Error(`no cargo_state reply to ${type}`);
    return replies[replies.length - 1]!;
  });
}

describe('SectorRoom integration — NPC Freight Dock market (T4)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    setTradeSink(null);
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('a neutral pilot buys from and sells to an NPC Freight Dock at the board price', { timeout: 40_000 }, async () => {
    const dir = new TradeDirector(new Map<string, TradeRoom>(), new EconomyStore({ persistence: getPersistence }), getHoldStore(), {});
    setTradeSink(dir);
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      npcBases: [{ baseId: 'b1', role: 'refinery', tier: 'settlement', seed: 12, x: 0, y: 0, features: ['minerals'] }],
    });
    await harness.connectActive(randomUUID()); // creates the room (lazily, on first join)
    const internal = harness.getServerRoom()!._internals;
    const dock = [...internal.structureRegistry.all()].find((r) => r.kind === 'freight_dock')!;
    expect(dock, 'the base has a Freight Dock').toBeDefined();
    const entityId = internal.swarmRegistry.get(dock.id)!.entityId;

    const pid = randomUUID();
    // Spawn on the dock: the spawn nudge moves the ship just clear of it.
    const cr = await harness.connectActive(pid, { spawnX: dock.x, spawnY: dock.y, initialWallet: 5000 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    let shipId = '';
    for (const [, s] of (harness.getServerRoom()!.state as SectorState).ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;

    const view = await ask(cr, replies, 'cargo_query', { entityId });
    expect(view.open, view.message).toBe(true);
    expect(view.market, 'an NPC Freight Dock is a market').toBeDefined();
    const [good, stock] = (Object.entries(view.hold!.goods) as Array<[string, number]>).find(([, n]) => n >= 5)!;
    const price = view.market!.buy[good as keyof typeof view.market.buy]!;
    expect(price).toBeGreaterThan(0);
    expect(price, 'the board price for this pilot here').toBe(dir.dockQuote(pid, 'sol-prime', good as never)!.buy);

    const before = getWallet().balance(pid);
    const bought = await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { [good]: 2 } } });
    expect(bought.ok, bought.message).toBe(true);
    expect(getWallet().balance(pid)).toBe(before - Math.ceil(2 * price));
    expect((getHoldStore().get(shipId)?.hold.goods as Record<string, number>)[good]).toBe(2);
    expect((bought.hold!.goods as Record<string, number>)[good]).toBe(stock - 2);

    const sellPrice = bought.market!.sell[good as keyof typeof bought.market.sell]!;
    const mid = getWallet().balance(pid);
    const sold = await ask(cr, replies, 'cargo_move', { entityId, dir: 'put', items: { goods: { [good]: 1 } } });
    expect(sold.ok, sold.message).toBe(true);
    expect(getWallet().balance(pid)).toBe(mid + Math.floor(sellPrice));
    expect((getHoldStore().get(shipId)?.hold.goods as Record<string, number>)[good]).toBe(1);
    expect(sellPrice, 'the dock pays less than it charges (the spread)').toBeLessThan(price);
  });
});
