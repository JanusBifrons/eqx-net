/**
 * Join credits (owner 2026-11-21): every joiner can buy a battleship straight
 * away. The once-per-account top-up rides the starter grant's flag pattern.
 */
import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { JOIN_CREDITS, LAUNCH_COST, launchVerdict } from '../../shared-types/launch.js';
import { EconomyStore } from './EconomyStore.js';
import { Wallet } from './Wallet.js';
import { grantJoinCredits } from './starterGrant.js';

const P = '6a7e0000-0000-4000-8000-0000000000d1';

function setup() {
  const ops: PersistOp[] = [];
  const sink = { enqueueCritical: (op: PersistOp) => ops.push(op) } as unknown as IPersistenceSink;
  const econ = new EconomyStore({ persistence: () => sink, now: () => 1000 });
  const wallet = new Wallet({ persistence: () => sink, now: () => 1000 });
  return { ops, sink, econ, wallet, deps: { econ, wallet, persistence: () => sink } };
}

/** The dearest battleship-class hull (battleship and its fits) to launch. */
const BATTLESHIP_PRICE = Math.max(...Object.entries(LAUNCH_COST).filter(([k]) => k.startsWith('battleship')).map(([, c]) => c));

describe('join credits', () => {
  it('the grant is at least 1.2× the dearest battleship launch, a round number', () => {
    expect(BATTLESHIP_PRICE).toBeGreaterThan(0);
    expect(JOIN_CREDITS).toBeGreaterThanOrEqual(BATTLESHIP_PRICE * 1.2);
    expect(JOIN_CREDITS % 5_000).toBe(0);
  });

  it("a fresh join's credits buy a battleship outright", () => {
    const { ops, deps, wallet, econ } = setup();
    expect(grantJoinCredits(deps, P)).toBe(true);
    expect(wallet.balance(P)).toBe(JOIN_CREDITS);
    expect(wallet.balance(P)).toBeGreaterThanOrEqual(BATTLESHIP_PRICE);
    for (const kind of ['battleship', 'battleship-rail']) {
      expect(launchVerdict({ kind, wallet: wallet.balance(P), freeLaunches: econ.freeLaunches(P), ownedHere: false, costsOn: true }).kind).toBe('pay');
    }
    // One atomic group: the wallet row and the "given" flag together.
    expect(ops).toHaveLength(1);
    const group = ops[0] as Extract<PersistOp, { type: 'GROUP' }>;
    expect(group.type).toBe('GROUP');
    expect(group.ops.map((o) => o.type).sort()).toEqual(['ECON_PLAYER_PUT', 'WALLET_PUT']);
  });

  it('once per account: spending it down never refills it', () => {
    const { deps, wallet } = setup();
    grantJoinCredits(deps, P);
    wallet.debit(P, LAUNCH_COST.battleship!, 'launch');
    expect(grantJoinCredits(deps, P)).toBe(false);
    expect(wallet.balance(P)).toBe(JOIN_CREDITS - LAUNCH_COST.battleship!);
  });

  it('an existing pilot below the grant is topped up to it; one above keeps theirs', () => {
    const { deps, wallet, econ } = setup();
    wallet.credit(P, 10_000, 'earned');
    expect(grantJoinCredits(deps, P)).toBe(true);
    expect(wallet.balance(P)).toBe(JOIN_CREDITS);

    const rich = '6a7e0000-0000-4000-8000-0000000000d2';
    wallet.credit(rich, JOIN_CREDITS + 1, 'earned');
    expect(grantJoinCredits(deps, rich)).toBe(true);
    expect(wallet.balance(rich)).toBe(JOIN_CREDITS + 1);
    expect(econ.joinCreditsGranted(rich)).toBe(true);
  });

  it('the flag survives a restart (hydrated from the player row)', () => {
    const { ops, deps } = setup();
    grantJoinCredits(deps, P);
    const group = ops[0] as Extract<PersistOp, { type: 'GROUP' }>;
    const row = group.ops.find((o) => o.type === 'ECON_PLAYER_PUT') as Extract<PersistOp, { type: 'ECON_PLAYER_PUT' }>;
    expect(JSON.parse(row.payloadJson).joinCreditsGranted).toBe(true);
  });

  it('no economy or no player id: nothing changes', () => {
    const { wallet, sink } = setup();
    expect(grantJoinCredits({ econ: null, wallet, persistence: () => sink }, P)).toBe(false);
    expect(wallet.balance(P)).toBe(0);
  });
});
