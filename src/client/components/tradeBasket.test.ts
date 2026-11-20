import { describe, expect, it } from 'vitest';
import { GOOD_DEFS } from '../../shared-types/goods';
import { packedWeightOf } from '../../core/cargo/hold';
import { bump, checkTrade, moneyLine, qtyIn, tradeMoves, tradeSideBySide, type TradeLine } from './tradeBasket';

const W = GOOD_DEFS.alloy.weight;

describe('tradeBasket', () => {
  it('bump adds a line, grows it, and drops it at zero', () => {
    let b: TradeLine[] = [];
    b = bump(b, 'buy', 'g:alloy', 12, 1);
    b = bump(b, 'buy', 'g:alloy', 12, 1);
    expect(qtyIn(b, 'buy', 'g:alloy')).toBe(2);
    b = bump(b, 'sell', 'g:alloy', 9, 1);
    expect(b).toHaveLength(2);
    b = bump(b, 'buy', 'g:alloy', 12, -2);
    expect(b).toEqual([{ dir: 'sell', key: 'g:alloy', qty: 1, unit: 9 }]);
  });

  it('net is sells minus buys; the verb follows the sides', () => {
    const buys: TradeLine[] = [{ dir: 'buy', key: 'g:alloy', qty: 3, unit: 12 }];
    expect(checkTrade(buys, 0, 1000, null)).toMatchObject({ net: -36, verb: 'Purchase', why: null });
    const sells: TradeLine[] = [{ dir: 'sell', key: 'g:salvage', qty: 2, unit: 5 }];
    expect(checkTrade(sells, 50, 1000, null)).toMatchObject({ net: 10, verb: 'Sell' });
    expect(checkTrade([...buys, ...sells], 50, 1000, null)).toMatchObject({ net: -26, verb: 'Confirm' });
  });

  it("fits: buys minus sells against the hold's free room, by the shared weight", () => {
    const b: TradeLine[] = [{ dir: 'buy', key: 'g:alloy', qty: 10, unit: 1 }];
    const used = 100 - 10 * W + 1; // one short of room
    const c = checkTrade(b, used, 100, null);
    expect(c.holdAfter).toBeCloseTo(101);
    expect(c.why).toBe("Won't fit: needs 1 more space");
    // Selling some alloy back in the same deal makes the room.
    const mixed = checkTrade([...b, { dir: 'sell', key: 'g:alloy', qty: 1, unit: 1 }], used, 100, null);
    expect(mixed.why).toBeNull();
  });

  it('packed items weigh what the server says they weigh', () => {
    const b: TradeLine[] = [{ dir: 'buy', key: 'p:hull:capital', qty: 1, unit: 500 }];
    expect(checkTrade(b, 0, 1000, null).holdAfter).toBe(packedWeightOf('hull:capital'));
  });

  it("can't pay: the net cost against the wallet (sells count first)", () => {
    const b: TradeLine[] = [{ dir: 'buy', key: 'g:alloy', qty: 10, unit: 12 }];
    expect(checkTrade(b, 0, 10_000, 100).why).toBe("Can't pay: needs 20¢ more");
    expect(checkTrade([...b, { dir: 'sell', key: 'g:salvage', qty: 4, unit: 5 }], 0, 10_000, 100).why).toBeNull();
    expect(checkTrade(b, 0, 10_000, null).why).toBeNull();
  });

  it('moves: the sells (put) first, then the buys (take), goods counts and packed products', () => {
    const b: TradeLine[] = [
      { dir: 'buy', key: 'g:alloy', qty: 2, unit: 12 },
      { dir: 'buy', key: 'p:hull:capital', qty: 2, unit: 500 },
      { dir: 'sell', key: 'g:salvage', qty: 3, unit: 2 },
    ];
    expect(tradeMoves(b)).toEqual([
      { dir: 'put', items: { goods: { salvage: 3 } } },
      { dir: 'take', items: { goods: { alloy: 2 }, packed: ['hull:capital', 'hull:capital'] } },
    ]);
    expect(tradeMoves([])).toEqual([]);
  });

  it('side by side on a short, wide screen only (a sideways phone); tall screens stack', () => {
    expect(tradeSideBySide(863, 390)).toBe(true); // Pixel 7 sideways
    expect(tradeSideBySide(844, 360)).toBe(true);
    expect(tradeSideBySide(1920, 1080)).toBe(false); // desktop: room to stack
    expect(tradeSideBySide(1024, 768)).toBe(false);
    expect(tradeSideBySide(390, 863)).toBe(false); // upright
  });

  it('the money line always carries the wallet', () => {
    expect(moneyLine(0, true, 20000)).toBe('Wallet 20000¢');
    expect(moneyLine(-20013, false, 20000)).toBe('Pay 20013¢ of 20000¢');
    expect(moneyLine(10, false, 20000)).toBe('Get 10¢ · wallet 20000¢');
    expect(moneyLine(-5, false, null)).toBe('Pay 5¢');
  });
});
