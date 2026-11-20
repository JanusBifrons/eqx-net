import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { addPacked, emptyHold, packedItemWeight } from '../../core/cargo/hold.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { Wallet } from './Wallet.js';
import { CAPITAL_CRATE_PRODUCT, capitalCrateBillValue, capitalCratePrice } from './capitalCrateTrade.js';
import { quotePacked } from '../../core/economy/market.js';
import { buyCapitalCrateAtDock, DOCK_CRATE_NO_CREDITS, DOCK_CRATE_NO_ROOM, type DockCrateBuy } from './dockCapitalCrate.js';

function setup(balance: number, capacity = 1e6): { d: DockCrateBuy; holds: HoldStore; wallet: Wallet; groups: PersistOp[][] } {
  const groups: PersistOp[][] = [];
  const sink = {
    enqueueCritical: (op: PersistOp) => groups.push(op.type === 'GROUP' ? op.ops : [op]),
    enqueueVolatile: () => {},
  } as unknown as IPersistenceSink;
  const holds = new HoldStore({ persistence: () => sink, now: () => 1 });
  const wallet = new Wallet({ persistence: () => sink, now: () => 1 });
  if (balance > 0) wallet.credit('p', balance, 'test');
  groups.length = 0;
  const d: DockCrateBuy = {
    holds, wallet, persist: true, playerId: 'p', shipInstanceId: 'ship-1', shipCapacity: capacity, traderRep: 0, volumeLeft: 1e9,
  };
  return { d, holds, wallet, groups };
}

const price = Math.ceil(capitalCratePrice(0));

describe('NPC Freight Dock sells a Capital crate (playable base loop)', () => {
  it('a dock sells a Capital crate for credits', () => {
    const { d, holds, wallet, groups } = setup(price + 10);
    const r = buyCapitalCrateAtDock(d);
    expect(r).toEqual({ ok: true, cost: price });
    expect(wallet.balance('p')).toBe(10);
    const packed = holds.get('ship-1')!.hold.packed!;
    expect(packed).toHaveLength(1);
    expect(packed[0]!.product).toBe(CAPITAL_CRATE_PRODUCT);
    // The board's price rule, not a second one.
    expect(capitalCratePrice(0)).toBe(quotePacked(capitalCrateBillValue(), 0));
    // Hold + wallet land in ONE atomic group.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.some((op) => op.type === 'WALLET_PUT')).toBe(true);
  });

  it('not enough credits is refused', () => {
    const { d, holds, wallet } = setup(price - 1);
    expect(buyCapitalCrateAtDock(d)).toEqual({ ok: false, message: DOCK_CRATE_NO_CREDITS });
    expect(wallet.balance('p')).toBe(price - 1);
    expect(holds.get('ship-1')).toBeUndefined();
  });

  it('no room in the hold is refused', () => {
    const crateWeight = packedItemWeight({ product: CAPITAL_CRATE_PRODUCT, quality: 50 });
    const { d, holds, wallet } = setup(price, crateWeight - 1);
    expect(buyCapitalCrateAtDock(d)).toEqual({ ok: false, message: DOCK_CRATE_NO_ROOM });
    expect(wallet.balance('p')).toBe(price);
    expect(holds.get('ship-1')).toBeUndefined();
  });

  it('the crate bought is fresh (own uid, full bank)', () => {
    const { d, holds, wallet } = setup(price * 2);
    // Already carrying a plain packed item: the new crate is its own one.
    const seed = emptyHold();
    addPacked(seed, 'structure:smelter', 50);
    holds.commit([{ holderUid: 'ship-1', holderType: 'ship', ownerId: 'p', sectorKey: null, x: null, y: null, hold: seed, expiresAt: null }], []);
    expect(buyCapitalCrateAtDock(d).ok).toBe(true);
    expect(buyCapitalCrateAtDock(d).ok).toBe(true);
    expect(wallet.balance('p')).toBe(0);
    const crates = holds.get('ship-1')!.hold.packed!.filter((p) => p.product === CAPITAL_CRATE_PRODUCT);
    expect(crates).toHaveLength(2);
    for (const c of crates) {
      expect(c.uid).toMatch(/^cap-/);
      expect(c.minerals).toBe(CAPITAL_STARTING_MINERALS);
    }
    expect(crates[0]!.uid).not.toBe(crates[1]!.uid);
  });
});
