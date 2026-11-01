/**
 * Living World P2 (plan peppy-jumping-pinwheel) — trade deals against a REAL
 * SectorRoom: the TradeDirector drives the room's actual hooks (storage escrow
 * via `tradeTransfer`, hauler spawn/despawn, the kill path that spills a
 * hauler's hold). The director's own state machine is unit-tested with a fake
 * room (TradeDirector.test.ts); this locks the room side of the contract (#15).
 *
 *  1. A SELL: goods leave the Capital at dock, credits arrive on departure, the
 *     hauler leaves the sector.
 *  2. A BUY raided while docked: the hauler is really shot down, its cargo
 *     (the trader's goods) spills as a loot pod, and the buyer's credits come
 *     back to the Capital in full.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore, getPersistence } from '../../../src/server/db/PersistenceWorker.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import { buyCost, sellProceeds } from '../../../src/core/economy/deals.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const SECTOR = 'trade-test';
const OWNER = 'trade-owner';

interface Ctx {
  harness: SectorTestHarness;
  room: SectorRoom;
  capital: { uid?: string; hold?: { goods: Record<string, number>; credits: number; blueprints: string[] } };
  dir: TradeDirector;
  store: EconomyStore;
}

async function boot(): Promise<Ctx> {
  const harness = await bootSectorTestServer({
    sectorKey: SECTOR,
    droneCount: 0,
    testMode: true,
    asteroidConfig: [],
    prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
    prebuiltStructuresOwner: OWNER,
  } as never);
  await harness.connectAs(randomUUID()); // creates the room (a pending observer)
  const room = harness.getServerRoom() as unknown as SectorRoom;
  const capital = [...room._internals.structureRegistry.all()].find((s) => s.kind === 'capital')!;
  const store = new EconomyStore({ persistence: getPersistence });
  const dir = new TradeDirector(new Map([[SECTOR, room]]), store, getHoldStore(), {
    controlIntervalMs: 50,
    dockMs: 300,
    departMs: 300,
    // The hauler spawns at the sector edge; a huge radius docks it at once so
    // the test exercises escrow + settlement, not the flight.
    dockRadius: 100_000,
  });
  dir.start();
  // The room reports hauler hits + robot hits through the trade sink (index.ts
  // installs it in production).
  setTradeSink(dir);
  return { harness, room, capital: capital as Ctx['capital'], dir, store };
}

async function until(pred: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${label}`);
}

function haulers(room: SectorRoom): string[] {
  return [...room._internals.swarmRegistry.all()].filter((r) => r.id.startsWith('hauler-')).map((r) => r.id);
}

describe('SectorRoom integration — trade deals (P2)', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await boot(); }, 20_000);
  afterEach(async () => {
    setTradeSink(null);
    ctx.dir.stop();
    await ctx.harness.cleanup();
  }, 10_000);

  it('a SELL settles on safe departure and the hauler leaves', { timeout: 20_000 }, async () => {
    const { room, capital, dir, store } = ctx;
    capital.hold = { goods: { salvage: 50 }, credits: 0, blueprints: [] };
    const offer = dir.offersFor(OWNER).find((o) => o.kind === 'sell' && o.good === 'salvage')!;
    const v = dir.acceptOffer(OWNER, SECTOR, {
      type: 'accept_offer', offerId: offer.offerId, networkUid: capital.uid!, qty: 20,
      recurrenceMin: null, visits: null, priceBandPct: 0,
    });
    expect(v.ok, v.message).toBe(true);

    await until(() => haulers(room).length === 1, 3000, 'hauler spawned in the sector');
    await until(() => (capital.hold?.goods.salvage ?? 0) === 30, 3000, 'goods taken into escrow at dock');
    expect(capital.hold!.credits).toBe(0); // nothing paid while docked
    await until(() => store.getDeal(v.dealId!)?.state === 'settled', 5000, 'deal settled');
    expect(capital.hold!.credits).toBe(sellProceeds(20, offer.unitPrice));
    expect(haulers(room)).toHaveLength(0);
  });

  it('a BUY raided while docked spills the trader cargo and refunds the buyer', { timeout: 20_000 }, async () => {
    const { room, capital, dir, store } = ctx;
    capital.hold = { goods: {}, credits: 3000, blueprints: [] };
    const offer = dir.offersFor(OWNER).find((o) => o.kind === 'buy' && o.good === 'alloy')!;
    const v = dir.acceptOffer(OWNER, SECTOR, {
      type: 'accept_offer', offerId: offer.offerId, networkUid: capital.uid!, qty: 10,
      recurrenceMin: null, visits: null, priceBandPct: 0,
    });
    expect(v.ok, v.message).toBe(true);
    await until(() => capital.hold!.credits === 3000 - buyCost(10, offer.unitPrice), 4000, 'credits in escrow');
    const [hauler] = haulers(room);
    expect(hauler).toBeDefined();

    // Shoot it down for real (shield first — no spillover — then the hull).
    for (let i = 0; i < 4 && haulers(room).length > 0; i++) {
      room._internals.applyDamage(hauler!, 'some-pirate', 5000);
    }
    await until(() => store.getDeal(v.dealId!)?.state === 'failed', 3000, 'deal marked raided');
    expect(capital.hold!.credits).toBe(3000); // refunded in full
    const pods = getHoldStore().inSector(SECTOR, 'pod');
    expect(pods.some((p) => (p.hold.goods.alloy ?? 0) === 10)).toBe(true); // the trader's goods spilled
    expect(store.rep('some-pirate', 'traders')).toBeLessThan(0); // piracy costs standing
  });
});
