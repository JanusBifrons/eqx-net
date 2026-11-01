/**
 * Economy v2 W4b (plan peppy-jumping-pinwheel) — buying a PACKED structure
 * from traders and placing it, through a real SectorRoom, the real
 * TradeDirector and the real `place_structure` message.
 *
 * The user's ruling: most players buy packed structures from NPC traders
 * rather than make them; placing one costs nothing but time.
 *  1. without a packed item, placing a non-starter kind is refused with a
 *     notice that says how to get one;
 *  2. a packed-structure offer is on the trader board, priced from its pack
 *     recipe; buying it is a one-off deal (recurring is refused);
 *  3. the hauler delivers it into the Capital; the wallet pays at dock;
 *  4. placing now works: the packed item is consumed, the structure is
 *     PREPAID and builds with no minerals; deconstructing it returns none.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore, getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { PACKED_HULL_OFFERS_ON_BOARD, TradeDirector } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import { buyCost } from '../../../src/core/economy/deals.js';
import { quotePacked } from '../../../src/core/economy/market.js';
import { CONSTRUCTION_PULSE_AMOUNT } from '../../../src/core/structures/structureGridConstants.js';
import { hullBillValue, packBillValue } from '../../../src/shared-types/recipes.js';
import type { ShipKindId } from '../../../src/shared-types/shipKinds.js';
import type { StructureKindId } from '../../../src/shared-types/structureKinds.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

const SECTOR = 'trade-test';

async function until(pred: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${label}`);
}

describe('SectorRoom integration — buying + placing packed structures (economy v2 W4b)', () => {
  let harness: SectorTestHarness;
  let dir: TradeDirector;
  const owner = randomUUID();

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: SECTOR, droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
      prebuiltStructuresOwner: owner,
    } as never);
  }, 20_000);
  afterEach(async () => {
    setTradeSink(null);
    dir?.stop();
    await harness.cleanup();
  }, 10_000);

  it('refused without one; bought from a trader; placed prepaid; built for free', { timeout: 40_000 }, async () => {
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 1500, shipKind: 'fighter' });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internal = room._internals;
    const capital = [...internal.structureRegistry.all()].find((s) => s.kind === 'capital')!;
    const store = new EconomyStore({ persistence: getPersistence });
    dir = new TradeDirector(new Map([[SECTOR, room]]), store, getHoldStore(), {
      controlIntervalMs: 50, dockMs: 300, departMs: 300, dockRadius: 100_000, wallet: getWallet(),
    });
    dir.start();
    setTradeSink(dir);

    // The board carries packed-structure offers, priced from the pack recipe.
    // W5b — packed HULLS have their own slots on the board, priced from the
    // Shipyard recipe like structures are from their pack recipe.
    const hulls = dir.offersFor(owner).filter((o) => o.product?.startsWith('hull:') === true);
    expect(hulls).toHaveLength(PACKED_HULL_OFFERS_ON_BOARD);
    for (const h of hulls) expect(h.unitPrice).toBe(quotePacked(hullBillValue(h.product!.slice('hull:'.length) as ShipKindId), 0));
    const offer = dir.offersFor(owner).find((o) => o.product?.startsWith('structure:') === true);
    expect(offer, 'a packed-structure offer is on the board').toBeDefined();
    expect(offer!.kind).toBe('buy');
    expect(offer!.good).toBeNull();
    const kind = offer!.product!.slice('structure:'.length) as StructureKindId;
    expect(offer!.unitPrice).toBe(quotePacked(packBillValue(kind), 0));

    // 1. Without one: refused, and told why.
    const notices: string[] = [];
    cr.onMessage('notice', (m: { text: string }) => notices.push(m.text));
    const count = (): number => [...internal.structureRegistry.all()].length;
    const before = count();
    cr.send('place_structure', { type: 'place_structure', kind, x: 0, y: -1600 });
    await until(() => notices.some((t) => t.includes('Packed')), 3000, 'refusal notice');
    expect(count()).toBe(before);
    expect(notices.join(' ')).not.toContain('structure:');

    // 2. Recurring is refused; a one-off is agreed.
    getWallet().credit(owner, 100_000, 'test_seed');
    const deal = (recurrenceMin: 10 | null) => dir.acceptOffer(owner, SECTOR, capital.uid!, {
      type: 'accept_offer', offerId: offer!.offerId, networkEntityId: 0, qty: 1,
      recurrenceMin, visits: null, priceBandPct: 0,
    });
    expect(deal(10).ok).toBe(false);
    const v = deal(null);
    expect(v.ok, v.message).toBe(true);

    // 3. The hauler delivers it into the Capital; the wallet pays.
    await until(() => store.getDeal(v.dealId!)?.state === 'settled', 8000, 'deal settled');
    expect(capital.hold?.packed?.map((p) => p.product)).toEqual([offer!.product]);
    expect(getWallet().balance(owner)).toBe(100_000 - buyCost(1, offer!.unitPrice));

    // 4. Placing it now consumes the packed item; the build is prepaid.
    const minerals = capital.minerals;
    cr.send('place_structure', { type: 'place_structure', kind, x: 0, y: -1600 });
    await until(() => count() === before + 1, 3000, 'placed');
    const placed = [...internal.structureRegistry.all()].find((s) => s.kind === kind)!;
    expect(placed.prepaid).toBe(true);
    expect(capital.hold?.packed ?? []).toEqual([]);
    // The kind is whatever the board offers; the biggest take thousands of pulses.
    const maxPulses = Math.ceil(placed.constructionCost / CONSTRUCTION_PULSE_AMOUNT) + 10;
    for (let i = 0; i < maxPulses && !placed.isConstructed; i++) internal.pulseStructureGrid();
    expect(placed.isConstructed).toBe(true);
    expect(capital.minerals).toBe(minerals); // unpacking cost nothing but time

    // Taking it down returns no minerals (they were never paid).
    placed.isDeconstructing = true;
    for (let i = 0; i < maxPulses && internal.structureRegistry.get(placed.id); i++) internal.pulseStructureGrid();
    expect(internal.structureRegistry.get(placed.id)).toBeUndefined();
    expect(capital.minerals).toBe(minerals);
  });

  it('a packed item in the builder’s ship hold works too', { timeout: 30_000 }, async () => {
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 1500, shipKind: 'fighter' });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internal = room._internals;
    let shipId = '';
    for (const [, s] of (room.state as SectorState).ships) if (s.playerId === owner && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    getHoldStore().put({
      holderUid: shipId, holderType: 'ship', ownerId: owner, sectorKey: null, x: null, y: null,
      hold: { goods: {}, blueprints: [], packed: [{ product: 'structure:missile_turret', quality: 40 }] }, expiresAt: null,
    }, false);
    const before = [...internal.structureRegistry.all()].length;
    cr.send('place_structure', { type: 'place_structure', kind: 'missile_turret', x: 400, y: -900 });
    await until(() => [...internal.structureRegistry.all()].length === before + 1, 3000, 'placed from the ship hold');
    expect(getHoldStore().get(shipId)).toBeUndefined(); // the only item: the row is gone
  });
});
