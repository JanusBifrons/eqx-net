import { describe, expect, it } from 'vitest';
import { Wallet } from './Wallet.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { migrateLegacyCredits } from './walletMigration.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

function recordingSink(): { sink: IPersistenceSink; groups: PersistOp[][] } {
  const groups: PersistOp[][] = [];
  const sink = {
    enqueueCritical: (op: PersistOp) => groups.push(op.type === 'GROUP' ? op.ops : [op]),
  } as unknown as IPersistenceSink;
  return { sink, groups };
}

describe('Wallet (economy v2 W1 — credits are virtual)', () => {
  it('credits and debits all-or-nothing, persisting the ABSOLUTE balance', () => {
    const { sink, groups } = recordingSink();
    const w = new Wallet({ persistence: () => sink, now: () => 7 });
    expect(w.balance('p')).toBe(0);
    expect(w.credit('p', 120.9, 'kill_bounty')).toBe(120);
    expect(w.debit('p', 500, 'repair')).toBe(false); // short ⇒ nothing changes
    expect(w.balance('p')).toBe(120);
    expect(w.debit('p', 20, 'repair')).toBe(true);
    expect(w.balance('p')).toBe(100);
    expect(groups.flat()).toEqual([
      { type: 'WALLET_PUT', playerId: 'p', balance: 120, ts: 7 },
      { type: 'WALLET_PUT', playerId: 'p', balance: 100, ts: 7 },
    ]);
  });

  it('deferred variants change memory and hand back the op for the caller\'s group', () => {
    const { sink, groups } = recordingSink();
    const w = new Wallet({ persistence: () => sink });
    const op = w.creditDeferred('p', 50, 'trade_sell');
    expect(op).toMatchObject({ type: 'WALLET_PUT', playerId: 'p', balance: 50 });
    expect(groups).toHaveLength(0); // the caller commits it
    expect(w.debitDeferred('p', 80, 'trade_buy')).toBeNull(); // short ⇒ null, unchanged
    expect(w.balance('p')).toBe(50);
    w.flush('p');
    expect(groups.flat().at(-1)).toMatchObject({ type: 'WALLET_PUT', balance: 50 });
  });

  it('hydrate sums aliases folded onto one canonical id and ignores junk', () => {
    const w = new Wallet({ persistence: () => null });
    w.hydrate([
      { playerId: 'p', balance: 100 },
      { playerId: 'p', balance: 25 },
      { playerId: 'q', balance: -5 },
      { playerId: 'r', balance: Number.NaN },
    ]);
    expect(w.balance('p')).toBe(125);
    expect(w.balance('q')).toBe(0);
    expect(w.balance('r')).toBe(0);
  });
});

describe('legacy hold-credits migration (economy v2 W1, boot)', () => {
  it('moves owned hold credits into the owner\'s wallet ONCE, in the same group as the rewritten row', () => {
    const { sink, groups } = recordingSink();
    const holds = new HoldStore({ persistence: () => sink });
    const wallet = new Wallet({ persistence: () => sink });
    holds.hydrate([
      { holderUid: 'ship-1', holderType: 'ship', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: { goods: { alloy: 2 }, blueprints: [] }, expiresAt: null },
      { holderUid: 'pod-1', holderType: 'pod', ownerId: null, sectorKey: 's', x: 0, y: 0, hold: { goods: { salvage: 3 }, blueprints: [] }, expiresAt: null },
      { holderUid: 'bounty:t:p1', holderType: 'bounty', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: { goods: {}, blueprints: [] }, expiresAt: null },
    ]);
    const legacy = [
      { uid: 'ship-1', owner: 'p1', credits: 300 },
      { uid: 'pod-1', owner: null, credits: 40 }, // ownerless: the credits vanish
      { uid: 'bounty:t:p1', owner: 'p1', credits: 200 }, // old escrow: refunded, row removed
    ];
    expect(migrateLegacyCredits(holds, wallet, legacy)).toEqual({ rows: 3, credited: 500 });
    expect(wallet.balance('p1')).toBe(500);
    // Goods untouched; the old bounty escrow row is gone.
    expect(holds.get('ship-1')?.hold.goods.alloy).toBe(2);
    expect(holds.get('pod-1')?.hold.goods.salvage).toBe(3);
    expect(holds.get('bounty:t:p1')).toBeUndefined();
    // Each owned row is ONE group: the rewritten row + the wallet balance.
    const shipGroup = groups.find((g) => g.some((o) => o.type === 'HOLD_PUT' && o.holderUid === 'ship-1'))!;
    expect(shipGroup.map((o) => o.type).sort()).toEqual(['HOLD_PUT', 'WALLET_PUT']);
    // Idempotent: the list is consumed; a second run moves nothing.
    expect(migrateLegacyCredits(holds, wallet, legacy)).toEqual({ rows: 0, credited: 0 });
    expect(wallet.balance('p1')).toBe(500);
  });
});
