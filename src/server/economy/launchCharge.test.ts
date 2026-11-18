/**
 * Join flow stage 2 — `chargeLaunch` applies the shared launch verdict: pay,
 * spend a free launch, or go into debt, and every charge is audited. A charge
 * that doesn't go through is a refusal (never an unpaid capital).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chargeLaunch, type LaunchChargeDeps } from './launchCharge.js';
import { Wallet } from './Wallet.js';
import { DEBT_FLOOR, LAUNCH_COST } from '../../shared-types/launch.js';
import { clearAuditRing, getRecentAudit } from '../audit/GameplayAuditLog.js';

const P = 'pilot-1';

function deps(balance: number, free: number, costsOn = true): { d: LaunchChargeDeps; w: Wallet; left: () => number } {
  const w = new Wallet({ persistence: () => null });
  if (balance !== 0) w.hydrate([{ playerId: P, balance }]);
  let n = free;
  const d: LaunchChargeDeps = {
    wallet: w,
    freeLaunches: () => n,
    spendFreeLaunch: () => (n > 0 ? (n--, true) : false),
    costsOn,
  };
  return { d, w, left: () => n };
}

const charged = () => getRecentAudit().filter((e) => e.event === 'launch_charged');

describe('chargeLaunch (join flow stage 2)', () => {
  afterEach(() => clearAuditRing());

  it('pays from the wallet when it covers the price', () => {
    const { d, w, left } = deps(10_000, 5);
    expect(chargeLaunch(d, P, 'destroyer')).toMatchObject({ kind: 'pay', cost: LAUNCH_COST.destroyer });
    expect(w.balance(P)).toBe(10_000 - LAUNCH_COST.destroyer!);
    expect(left()).toBe(5);
    expect(charged()).toMatchObject([{ playerId: P, kind: 'destroyer', how: 'pay', cost: LAUNCH_COST.destroyer }]);
  });

  it('spends a free launch when the wallet is short', () => {
    const { d, w, left } = deps(100, 2);
    expect(chargeLaunch(d, P, 'battleship').kind).toBe('token');
    expect(w.balance(P)).toBe(100);
    expect(left()).toBe(1);
    expect(charged()[0]).toMatchObject({ how: 'token' });
  });

  it('goes into debt once the free launches are gone, down to the floor', () => {
    const { d, w } = deps(0, 0);
    expect(chargeLaunch(d, P, 'battleship').kind).toBe('debt');
    expect(w.balance(P)).toBe(-LAUNCH_COST.battleship!);
    expect(charged()[0]).toMatchObject({ how: 'debt' });
  });

  it('refuses (broke) past the debt floor and charges nothing', () => {
    const { d, w } = deps(DEBT_FLOOR + 10, 0);
    expect(chargeLaunch(d, P, 'battleship')).toMatchObject({ kind: 'refuse', reason: 'broke' });
    expect(w.balance(P)).toBe(DEBT_FLOOR + 10);
    expect(charged()).toHaveLength(0);
  });

  it('free hulls, owned hulls and switched-off costs charge nothing', () => {
    const { d, w, left } = deps(10_000, 5);
    expect(chargeLaunch(d, P, 'fighter').kind).toBe('free');
    expect(chargeLaunch(d, P, 'battleship', true).kind).toBe('owned');
    expect(chargeLaunch({ ...d, costsOn: false }, P, 'battleship').kind).toBe('free');
    expect(w.balance(P)).toBe(10_000);
    expect(left()).toBe(5);
    expect(charged()).toHaveLength(0);
  });

  it('a charge that fails after the verdict is a refusal', () => {
    const { d } = deps(0, 3);
    const racy: LaunchChargeDeps = { ...d, spendFreeLaunch: () => false };
    expect(chargeLaunch(racy, P, 'destroyer')).toMatchObject({ kind: 'refuse', reason: 'broke' });
    expect(charged()).toHaveLength(0);
  });

  it('shipyard-only hulls are refused (they are built, not launched)', () => {
    const { d } = deps(1_000_000, 5);
    expect(chargeLaunch(d, P, 'heavy')).toMatchObject({ kind: 'refuse', reason: 'shipyard' });
  });
});
