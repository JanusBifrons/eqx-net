/**
 * The wallet (Living World economy v2, plan peppy-jumping-pinwheel W1).
 *
 * Credits are VIRTUAL, as in Eve Online: never in a hold, never dropped,
 * spilled, stolen or lost. Each player (keyed by canonical playerId — guests are
 * full players) has ONE balance, credited and debited automatically by game
 * events wherever they are.
 *
 * Memory is the authority. Every change persists an ABSOLUTE `WALLET_PUT` on
 * the CRITICAL lane. When a credit move must be atomic with a goods move (a
 * trade settlement), the caller folds `putOp(pid)` into the same
 * `HoldStore.commit(…, extraOps)` group via the `*Deferred` variants.
 *
 * Every change is a discrete `wallet_tx` audit event (never per tick).
 */
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';

export interface WalletDeps {
  persistence: () => IPersistenceSink | null;
  now?: () => number;
}

export class Wallet {
  private readonly bal = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: WalletDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Boot hydrate (memory only). Duplicate keys (aliases mapped onto one
   *  canonical id by the caller) SUM. */
  hydrate(rows: ReadonlyArray<{ playerId: string; balance: number }>): void {
    for (const r of rows) {
      if (!Number.isFinite(r.balance) || r.balance <= 0) continue;
      this.bal.set(r.playerId, (this.bal.get(r.playerId) ?? 0) + Math.floor(r.balance));
    }
  }

  balance(playerId: string): number {
    return this.bal.get(playerId) ?? 0;
  }

  /** Add `n` credits (floored; ≤ 0 is a no-op). Returns the new balance. */
  credit(playerId: string, n: number, reason: string): number {
    const amt = Math.floor(n);
    if (amt <= 0 || playerId === '') return this.balance(playerId);
    const next = this.applyDelta(playerId, amt);
    this.persist([this.putOp(playerId)]);
    auditEvent({ event: 'wallet_tx', playerId, delta: amt, balance: next, reason });
    return next;
  }

  /** Take `n` credits, all-or-nothing. False (nothing changes) when short. */
  debit(playerId: string, n: number, reason: string): boolean {
    const amt = Math.ceil(n);
    if (amt <= 0) return true;
    if (playerId === '' || this.balance(playerId) < amt) return false;
    const next = this.applyDelta(playerId, -amt);
    this.persist([this.putOp(playerId)]);
    auditEvent({ event: 'wallet_tx', playerId, delta: -amt, balance: next, reason });
    return true;
  }

  /**
   * Credit in MEMORY only and return the op for the caller to commit in its
   * own atomic group (with goods). The caller MUST commit the op.
   */
  creditDeferred(playerId: string, n: number, reason: string): PersistOp | null {
    const amt = Math.floor(n);
    if (amt <= 0 || playerId === '') return null;
    const next = this.applyDelta(playerId, amt);
    auditEvent({ event: 'wallet_tx', playerId, delta: amt, balance: next, reason });
    return this.putOp(playerId);
  }

  /** Debit in MEMORY only (all-or-nothing) and return the op to commit with
   *  the caller's group; null when short (nothing changes). */
  debitDeferred(playerId: string, n: number, reason: string): PersistOp | null {
    const amt = Math.ceil(n);
    if (amt <= 0 || playerId === '' || this.balance(playerId) < amt) return null;
    const next = this.applyDelta(playerId, -amt);
    auditEvent({ event: 'wallet_tx', playerId, delta: -amt, balance: next, reason });
    return this.putOp(playerId);
  }

  /** Persist `playerId`'s CURRENT balance on its own (after a deferred change
   *  whose intended group never committed). */
  flush(playerId: string): void {
    if (playerId === '') return;
    this.persist([this.putOp(playerId)]);
  }

  /** The absolute persisted row for `playerId`. */
  putOp(playerId: string): PersistOp {
    return { type: 'WALLET_PUT', playerId, balance: this.balance(playerId), ts: this.now() };
  }

  /** Number of funded wallets (inspection). */
  size(): number {
    return this.bal.size;
  }

  private applyDelta(playerId: string, delta: number): number {
    const next = Math.max(0, this.balance(playerId) + delta);
    if (next === 0) this.bal.delete(playerId);
    else this.bal.set(playerId, next);
    return next;
  }

  private persist(ops: PersistOp[]): void {
    const sink = this.deps.persistence();
    if (sink === null) return;
    sink.enqueueCritical(ops.length === 1 ? ops[0]! : { type: 'GROUP', ops });
  }
}
