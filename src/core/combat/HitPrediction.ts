/**
 * weapon-hit-prediction Phase 1 — the pure predicted-hit ledger.
 *
 * THE INVARIANT-#13 CANARY. Client-side favor-the-shooter hit prediction
 * shows immediate hit feedback at fire time, then reconciles it against
 * the server's authority. The entire "did we predict right, and if not how
 * do we undo it without double-counting" decision lives in THIS class —
 * deliberately isolated from the renderer, the network, and the wall
 * clock so the regression lock (`HitPrediction.test.ts`) is deterministic
 * and exhaustive.
 *
 * Zone purity (src/core, the blind zone):
 *  - No wire types. The ledger reads only narrow value inputs
 *    (`PredictedAck`, `AuthoritativeDamage`); the client adapter maps the
 *    real `HitAckMessage` / `DamageEvent` onto them (Interface Segregation
 *    — the canary depends only on the fields it decides on).
 *  - Time is injected (`nowMs` on every mutator). No `performance.now()` /
 *    `Date.now()` — forbidden in core, and untestable for TTL behaviour.
 *  - Steady-path allocation-free: entries are pooled and reused, so a
 *    fire-rate predict→reconcile loop does not churn the GC. `tick()`
 *    returns a shared frozen empty array when nothing expired.
 *
 * Design note — `reconcileDamage` signature deviates intentionally from
 * the plan's `reconcileDamage(key, DamageEvent, nowMs)` sketch. The
 * DamageEvent is a *broadcast* (no clientShotId), so requiring the caller
 * to pre-resolve a key would push the prediction↔damage MATCHING — the
 * exact place "double-counted / not de-duped" bugs live — out of the
 * tested canary and into the client. Keeping the match in-core (by
 * predicted target, FIFO, self-shooter gated) is the same shape (one
 * method reconciles authoritative damage, de-dupes confirmed, closes
 * projectiles, leaves `handleDamage` the sole HP authority) but locks the
 * load-bearing logic where the regression test can see it.
 */
import type { WeaponMode } from './WeaponCatalogue.js';

/** Narrow subset of the wire `HitAckMessage` the ledger decides on. A
 *  server-rejected shot arrives as `{ hit: false }` (same as a miss — both
 *  must cancel the optimistic feedback), so `rejected` is not needed here. */
export interface PredictedAck {
  hit: boolean;
  targetId?: string;
  damage?: number;
}

/** Narrow subset of the wire `DamageEvent` the ledger decides on. */
export interface AuthoritativeDamage {
  targetId: string;
  damage: number;
}

/** Outcome of reconciling a hitscan `hit_ack` against a prediction. The
 *  client maps each kind onto a presentation action via its stored
 *  per-`clientShotId` handles. */
export type AckResult =
  | { kind: 'confirmed'; clientShotId: string; targetId: string; damage: number }
  | { kind: 'corrected'; clientShotId: string; fromTargetId: string | null; toTargetId: string; damage: number }
  | { kind: 'rolled_back'; clientShotId: string; targetId: string }
  | { kind: 'false_negative'; clientShotId: string; targetId: string; damage: number }
  | { kind: 'noop'; clientShotId: string };

/** Outcome of reconciling an authoritative `DamageEvent`. `handleDamage()`
 *  stays the SOLE HP/HUD authority — these only tell it whether a number
 *  it is about to show was already shown predictively. */
export type DamageResult =
  | { kind: 'dedupe'; clientShotId: string } // ack-confirmed already; suppress this duplicate number
  | { kind: 'confirmed'; clientShotId: string } // unconfirmed prediction now authoritative; replace in place
  | { kind: 'passthrough' }; // no matching prediction — behave exactly as today

export interface ExpiredShot {
  clientShotId: string;
  predictedTargetId: string | null;
}

export interface HitPredictionLedgerOptions {
  /** A still-`pending` prediction older than this is failsafe-cancelled by
   *  `tick()` (projectile that never landed; hitscan whose ack was lost). */
  pendingTtlMs?: number;
  /** A `settled` (ack-confirmed) prediction whose de-duping `DamageEvent`
   *  never arrived is dropped silently after this — NEVER cancelled (the
   *  ack already authoritatively confirmed the number). */
  settledTtlMs?: number;
}

type Status = 'pending' | 'settled';

interface Entry {
  clientShotId: string;
  mode: WeaponMode;
  predictedTargetId: string | null;
  predictedDamage: number;
  status: Status;
  /** Instant the current `status` window opened — predict time while
   *  pending, ack time once settled. TTL is measured from here. */
  sinceMs: number;
}

const NO_EXPIRY: readonly ExpiredShot[] = Object.freeze([]);

const DEFAULT_PENDING_TTL_MS = 2000;
const DEFAULT_SETTLED_TTL_MS = 5000;

export class HitPredictionLedger {
  /** Insertion-ordered (Map guarantees this) → FIFO match/de-dupe. */
  private readonly active = new Map<string, Entry>();
  private readonly pool: Entry[] = [];
  private readonly pendingTtlMs: number;
  private readonly settledTtlMs: number;
  /** Count of Entry objects ever constructed (vs reused from the pool).
   *  The steady-path allocation probe asserts this stays bounded. */
  private allocCount = 0;

  constructor(opts: HitPredictionLedgerOptions = {}) {
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.settledTtlMs = opts.settledTtlMs ?? DEFAULT_SETTLED_TTL_MS;
  }

  /** Record an optimistic prediction made at fire time. A duplicate
   *  `clientShotId` is ignored (first prediction wins — a shot is
   *  predicted exactly once). */
  predict(
    clientShotId: string,
    mode: WeaponMode,
    predictedTargetId: string | null,
    predictedDamage: number,
    nowMs: number,
  ): void {
    if (this.active.has(clientShotId)) return;
    const e = this.acquire();
    e.clientShotId = clientShotId;
    e.mode = mode;
    e.predictedTargetId = predictedTargetId;
    e.predictedDamage = predictedDamage;
    e.status = 'pending';
    e.sinceMs = nowMs;
    this.active.set(clientShotId, e);
  }

  /** Reconcile a hitscan `hit_ack`. Projectile predictions ignore the ack
   *  entirely (the server's projectile ack is always `hit:false`; the
   *  projectile's sole reconcile authority is the eventual `DamageEvent`
   *  or TTL) — so a projectile entry is never rolled back here. */
  reconcileAck(clientShotId: string, ack: PredictedAck, nowMs: number): AckResult {
    const e = this.active.get(clientShotId);
    if (!e) return { kind: 'noop', clientShotId };
    if (e.mode === 'projectile') return { kind: 'noop', clientShotId }; // entry stays pending

    const predicted = e.predictedTargetId;
    // Hardening: a `hit:true` with no targetId can't be attributed — treat
    // it as a non-hit (the server always sends targetId on hit:true).
    const serverHit = ack.hit && ack.targetId != null;

    if (serverHit) {
      const tid = ack.targetId as string;
      const damage = ack.damage ?? e.predictedDamage;
      if (predicted === null) {
        this.evict(clientShotId, e);
        return { kind: 'false_negative', clientShotId, targetId: tid, damage };
      }
      if (predicted === tid) {
        e.status = 'settled';
        e.sinceMs = nowMs; // settled-TTL runs from the ack
        return { kind: 'confirmed', clientShotId, targetId: tid, damage };
      }
      this.evict(clientShotId, e);
      return { kind: 'corrected', clientShotId, fromTargetId: predicted, toTargetId: tid, damage };
    }

    // Server says nothing was hit (miss or rejected shot).
    this.evict(clientShotId, e);
    return predicted === null
      ? { kind: 'noop', clientShotId }
      : { kind: 'rolled_back', clientShotId, targetId: predicted };
  }

  /** Reconcile an authoritative `DamageEvent`. Matches by predicted
   *  target, oldest-first (FIFO), among the caller's own shots only. */
  reconcileDamage(damage: AuthoritativeDamage, shooterIsSelf: boolean, nowMs: number): DamageResult {
    void nowMs; // reserved: a future match window; signature stays injected-time
    if (!shooterIsSelf) return { kind: 'passthrough' };

    for (const e of this.active.values()) {
      if (e.predictedTargetId !== damage.targetId) continue;
      const clientShotId = e.clientShotId;
      // hitscan + settled → the ack already confirmed & the number was
      // shown: suppress this duplicate. Anything else still matching
      // (projectile pending, or hitscan pending under ack/damage reorder)
      // is being confirmed by this event for the first time.
      const kind: DamageResult['kind'] = e.mode === 'hitscan' && e.status === 'settled' ? 'dedupe' : 'confirmed';
      this.evict(clientShotId, e);
      return { kind, clientShotId };
    }
    return { kind: 'passthrough' };
  }

  /** Advance the TTL clock. Returns predictions to HARD-CANCEL (a pending
   *  prediction that never resolved). Settled-but-un-deduped predictions
   *  are dropped silently (the ack already confirmed them) and are NEVER
   *  in the returned list. Allocation-free when nothing expired. */
  tick(nowMs: number): readonly ExpiredShot[] {
    let out: ExpiredShot[] | null = null;
    for (const [id, e] of this.active) {
      if (e.status === 'pending') {
        if (nowMs - e.sinceMs > this.pendingTtlMs) {
          (out ??= []).push({ clientShotId: id, predictedTargetId: e.predictedTargetId });
          this.evict(id, e);
        }
      } else if (nowMs - e.sinceMs > this.settledTtlMs) {
        this.evict(id, e); // silent — ack already authoritatively confirmed
      }
    }
    return out ?? NO_EXPIRY;
  }

  /** Live (un-reconciled) prediction count. */
  size(): number {
    return this.active.size;
  }

  /** Entry objects ever allocated (vs pool-reused). Steady-path probe. */
  allocations(): number {
    return this.allocCount;
  }

  // ── pool ──────────────────────────────────────────────────────────────

  private acquire(): Entry {
    const reused = this.pool.pop();
    if (reused) return reused;
    this.allocCount++;
    return { clientShotId: '', mode: 'hitscan', predictedTargetId: null, predictedDamage: 0, status: 'pending', sinceMs: 0 };
  }

  /** Deleting the current key during a Map `for…of` is well-defined (the
   *  spec skips not-yet-visited deleted keys), so callers may evict inline
   *  while iterating `this.active`. */
  private evict(clientShotId: string, e: Entry): void {
    this.active.delete(clientShotId);
    e.clientShotId = '';
    e.predictedTargetId = null; // don't retain target-id strings in the pool
    this.pool.push(e);
  }
}
