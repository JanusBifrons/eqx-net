/**
 * PR 3a — account-bound player identity: registry rules, the boot merge of
 * historical per-browser playerIds, and the single-use transit identity token.
 */
import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import { AccountPlayerRegistry } from './AccountPlayerRegistry.js';
import { mergeAccountPlayerIds } from './accountPlayerMerge.js';
import {
  _clearTransitIdentities,
  consumeTransitIdentity,
  issueTransitIdentity,
} from './TransitIdentityTokens.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

class Capture implements IPersistenceSink {
  ops: PersistOp[] = [];
  enqueueCritical(op: PersistOp): void { this.ops.push(op); }
  enqueueVolatile(op: PersistOp): void { this.ops.push(op); }
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> { this.ops.push(op); return Promise.resolve({}); }
  shutdown(): Promise<{ drained: number }> { return Promise.resolve({ drained: 0 }); }
}

describe('AccountPlayerRegistry', () => {
  it('a first login adopts the browser id; later logins ignore the claim', () => {
    const sink = new Capture();
    const reg = new AccountPlayerRegistry({ persistence: sink });
    expect(reg.resolveForUser('u1', A)).toBe(A);
    expect(reg.resolveForUser('u1', B)).toBe(A);
    expect(sink.ops.filter((o) => o.type === 'ACCOUNT_PLAYER_PUT')).toHaveLength(1);
  });

  it('never adopts an id another account owns (mints a fresh one)', () => {
    const reg = new AccountPlayerRegistry({ generateId: () => C });
    reg.resolveForUser('u1', A);
    expect(reg.resolveForUser('u2', A)).toBe(C);
    expect(reg.userForPlayer(A)).toBe('u1');
    expect(reg.userForPlayer(C)).toBe('u2');
  });

  it('mints a fresh id when the claim is not a UUID', () => {
    const reg = new AccountPlayerRegistry({ generateId: () => C });
    expect(reg.resolveForUser('u1', 'not-a-uuid')).toBe(C);
  });

  it('aliases resolve to the canonical id and count as account-bound', () => {
    const reg = new AccountPlayerRegistry();
    reg.bind('u1', A);
    reg.addAlias(B, A, 'u1');
    expect(reg.resolve(B)).toBe(A);
    expect(reg.resolve(C)).toBe(C);
    expect(reg.isAccountBound(B)).toBe(true);
    expect(reg.isAccountBound(C)).toBe(false);
    expect(reg.userForPlayer(B)).toBe('u1');
  });
});

describe('mergeAccountPlayerIds', () => {
  function makeStore(): { store: PlayerShipStore; clock: { t: number } } {
    const clock = { t: 1000 };
    let n = 0;
    const store = new PlayerShipStore({ generateShipId: () => `ship-${++n}`, now: () => clock.t });
    return { store, clock };
  }

  it('folds an account\'s browser ids into the one with the newest ship', () => {
    const { store, clock } = makeStore();
    store.create({ playerId: A, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    clock.t = 2000;
    store.create({ playerId: B, userId: 'u1', kind: 'scout', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();

    const r = mergeAccountPlayerIds(reg, store);

    expect(reg.canonicalForUser('u1')).toBe(B); // B was used last
    expect(reg.resolve(A)).toBe(B);
    expect(store.listByPlayer(B)).toHaveLength(2);
    expect(store.listByPlayer(A)).toHaveLength(0);
    expect(r).toEqual({ bound: 1, aliased: 1, shipsMoved: 1 });
  });

  it('is idempotent — a second pass changes nothing', () => {
    const { store } = makeStore();
    store.create({ playerId: A, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.create({ playerId: B, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();
    mergeAccountPlayerIds(reg, store);
    expect(mergeAccountPlayerIds(reg, store)).toEqual({ bound: 0, aliased: 0, shipsMoved: 0 });
  });

  it('keeps an existing binding as canonical even if another id is newer', () => {
    const { store, clock } = makeStore();
    store.create({ playerId: A, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    clock.t = 5000;
    store.create({ playerId: B, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();
    reg.bind('u1', A);
    mergeAccountPlayerIds(reg, store);
    expect(store.listByPlayer(A)).toHaveLength(2);
  });

  it('never moves anonymous ships or another account\'s id', () => {
    const { store } = makeStore();
    store.create({ playerId: A, userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.create({ playerId: B, userId: 'u2', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.create({ playerId: C, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    // A ship stamped u1 but under u2's canonical id (shared browser) stays put.
    store.create({ playerId: B, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();
    reg.bind('u2', B);
    mergeAccountPlayerIds(reg, store);
    expect(store.listByPlayer(A)).toHaveLength(1);
    expect(store.listByPlayer(B)).toHaveLength(2);
    expect(reg.canonicalForUser('u1')).toBe(C);
  });

  it('never folds a test-fixture (exempt) account — the shared E2E login', () => {
    const { store } = makeStore();
    store.create({ playerId: A, userId: 'e2e', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    store.create({ playerId: B, userId: 'e2e', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();
    reg.hydrate([], [], ['e2e']);
    expect(mergeAccountPlayerIds(reg, store)).toEqual({ bound: 0, aliased: 0, shipsMoved: 0 });
    expect(reg.canonicalForUser('e2e')).toBeNull();
    expect(store.listByPlayer(A)).toHaveLength(1);
  });

  it('does not delete ships when a merged roster exceeds the cap', () => {
    const { store } = makeStore();
    for (let i = 0; i < 10; i++) store.create({ playerId: A, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    for (let i = 0; i < 3; i++) store.create({ playerId: B, userId: 'u1', kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
    const reg = new AccountPlayerRegistry();
    mergeAccountPlayerIds(reg, store);
    expect(store.size()).toBe(13);
  });
});

describe('transit identity tokens', () => {
  it('is single-use and bound to the issued player', () => {
    _clearTransitIdentities();
    issueTransitIdentity('t1', A, 0);
    expect(consumeTransitIdentity('t1', B, 1)).toBe(false); // wrong player burns it
    expect(consumeTransitIdentity('t1', A, 1)).toBe(false);
    issueTransitIdentity('t2', A, 0);
    expect(consumeTransitIdentity('t2', A, 1)).toBe(true);
    expect(consumeTransitIdentity('t2', A, 2)).toBe(false);
  });

  it('expires', () => {
    _clearTransitIdentities();
    issueTransitIdentity('t3', A, 0);
    expect(consumeTransitIdentity('t3', A, 60_000)).toBe(false);
  });
});
