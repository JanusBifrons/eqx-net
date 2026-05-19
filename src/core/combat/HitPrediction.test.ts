/**
 * weapon-hit-prediction Phase 1 — the deterministic invariant-#13 canary.
 *
 * `HitPredictionLedger` is the pure decision core of client-side
 * favor-the-shooter hit prediction. The bug class this feature exists to
 * kill — "hit feedback waits a full RTT" and "a mispredicted hit is never
 * rolled back / a confirmed hit is double-counted" — lives ENTIRELY in
 * this transition logic. Isolating it here, with injected time and narrow
 * value inputs (no wire types, no renderer, no `performance.now()`), is
 * what makes the regression lock fast, deterministic, and exhaustive.
 *
 * Every reconcile transition is asserted, including the adversarial ones:
 * mispredict rollback, server-rejected shot, false-negative (predicted a
 * miss, server says hit), out-of-order DamageEvent-before-ack, projectile
 * TTL expiry, double-fire in one frame, and the steady-path allocation
 * probe (pooled entries must not churn the GC at fire-rate).
 */
import { describe, it, expect } from 'vitest';
import { HitPredictionLedger } from './HitPrediction.js';

const TTL = { pendingTtlMs: 2000, settledTtlMs: 5000 };

describe('HitPredictionLedger — hitscan ack reconcile', () => {
  it('predicted hit confirmed by a same-target ack → confirmed + settled (awaits DamageEvent de-dupe)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100);
    expect(r).toEqual({ kind: 'confirmed', clientShotId: 's1', targetId: 'swarm-7', damage: 20 });
    // Settled, NOT consumed — the imminent DamageEvent must still find it to de-dupe.
    expect(l.size()).toBe(1);
  });

  it('a confirmed prediction is de-duped (not double-counted) when the authoritative DamageEvent lands', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100);
    const d = l.reconcileDamage({ targetId: 'swarm-7', damage: 20 }, true, 1150);
    expect(d).toEqual({ kind: 'dedupe', clientShotId: 's1' });
    expect(l.size()).toBe(0); // consumed — exactly one number for a confirmed hit
  });

  it('predicted hit, server says MISS → rolled_back (hard-cancel) + consumed', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = l.reconcileAck('s1', { hit: false }, 1100);
    expect(r).toEqual({ kind: 'rolled_back', clientShotId: 's1', targetId: 'swarm-7' });
    expect(l.size()).toBe(0);
  });

  it('predicted hit, server REJECTED the shot (cooldown/temporal) → rolled_back', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = l.reconcileAck('s1', { hit: false, /* rejected form */ }, 1100);
    expect(r.kind).toBe('rolled_back');
  });

  it('predicted hit on A, server hit a DIFFERENT target B → corrected (from A to B)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = l.reconcileAck('s1', { hit: true, targetId: 'swarm-9', damage: 20 }, 1100);
    expect(r).toEqual({
      kind: 'corrected',
      clientShotId: 's1',
      fromTargetId: 'swarm-7',
      toTargetId: 'swarm-9',
      damage: 20,
    });
    expect(l.size()).toBe(0);
  });

  it('predicted a MISS, server says HIT → false_negative (let authoritative path show it; no spurious rollback)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', null, 0, 1000);
    const r = l.reconcileAck('s1', { hit: true, targetId: 'swarm-9', damage: 20 }, 1100);
    expect(r).toEqual({ kind: 'false_negative', clientShotId: 's1', targetId: 'swarm-9', damage: 20 });
    expect(l.size()).toBe(0);
    // The subsequent authoritative DamageEvent must pass straight through —
    // there was no predicted number to de-dupe.
    expect(l.reconcileDamage({ targetId: 'swarm-9', damage: 20 }, true, 1150)).toEqual({ kind: 'passthrough' });
  });

  it('predicted a MISS, server confirms MISS → noop', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', null, 0, 1000);
    expect(l.reconcileAck('s1', { hit: false }, 1100)).toEqual({ kind: 'noop', clientShotId: 's1' });
    expect(l.size()).toBe(0);
  });

  it('ack for an unknown clientShotId → noop (no throw, nothing created)', () => {
    const l = new HitPredictionLedger(TTL);
    expect(l.reconcileAck('ghost', { hit: true, targetId: 'x', damage: 5 }, 1000)).toEqual({
      kind: 'noop',
      clientShotId: 'ghost',
    });
    expect(l.size()).toBe(0);
  });

  it('a duplicate predict for the same clientShotId is ignored (first prediction wins)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    l.predict('s1', 'hitscan', 'swarm-9', 99, 1001); // ignored
    const r = l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100);
    expect(r).toEqual({ kind: 'confirmed', clientShotId: 's1', targetId: 'swarm-7', damage: 20 });
    expect(l.size()).toBe(1);
  });
});

describe('HitPredictionLedger — projectile reconcile (DamageEvent / TTL, never the ack)', () => {
  it('projectile ack is always hit:false (server contract) → noop, prediction STAYS pending', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('p1', 'projectile', 'swarm-7', 10, 1000);
    const r = l.reconcileAck('p1', { hit: false }, 1050);
    expect(r).toEqual({ kind: 'noop', clientShotId: 'p1' });
    expect(l.size()).toBe(1); // NOT rolled back — projectile ignores the ack entirely
  });

  it('projectile confirmed by the eventual authoritative DamageEvent for its target → confirmed + consumed', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('p1', 'projectile', 'swarm-7', 10, 1000);
    l.reconcileAck('p1', { hit: false }, 1050);
    const d = l.reconcileDamage({ targetId: 'swarm-7', damage: 10 }, true, 1600);
    expect(d).toEqual({ kind: 'confirmed', clientShotId: 'p1' });
    expect(l.size()).toBe(0);
  });

  it('projectile with no confirming DamageEvent → tick() expires it past TTL (hard-cancel list)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('p1', 'projectile', 'swarm-7', 10, 1000);
    expect(l.tick(2999)).toEqual([]); // within pendingTtlMs (1000 + 2000)
    const expired = l.tick(3001); // past TTL
    expect(expired).toEqual([{ clientShotId: 'p1', predictedTargetId: 'swarm-7' }]);
    expect(l.size()).toBe(0);
    expect(l.tick(4000)).toEqual([]); // already consumed — not re-reported
  });

  it('a pending hitscan that never gets an ack is failsafe-cancelled by tick() (lost-packet guard)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const expired = l.tick(3001);
    expect(expired).toEqual([{ clientShotId: 's1', predictedTargetId: 'swarm-7' }]);
    expect(l.size()).toBe(0);
  });

  it('a settled (ack-confirmed) prediction whose DamageEvent never lands is dropped silently — NOT cancelled', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100);
    // settledTtlMs = 5000 from the ack-at 1100.
    expect(l.tick(6099)).toEqual([]); // still within settled grace
    expect(l.tick(6101)).toEqual([]); // dropped, but NEVER in the hard-cancel list
    expect(l.size()).toBe(0); // freed
  });
});

describe('HitPredictionLedger — adversarial ordering & isolation', () => {
  it('DamageEvent arriving BEFORE the hit_ack (reorder) confirms the pending hitscan; the late ack is a noop (no double count)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const d = l.reconcileDamage({ targetId: 'swarm-7', damage: 20 }, true, 1080);
    expect(d).toEqual({ kind: 'confirmed', clientShotId: 's1' });
    expect(l.size()).toBe(0);
    // The hit_ack that arrives after the broadcast finds nothing to do.
    expect(l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1090)).toEqual({
      kind: 'noop',
      clientShotId: 's1',
    });
  });

  it('a DamageEvent from a shot that is not mine → passthrough (handleDamage stays sole authority)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100);
    const d = l.reconcileDamage({ targetId: 'swarm-7', damage: 20 }, false /* not self */, 1150);
    expect(d).toEqual({ kind: 'passthrough' });
    expect(l.size()).toBe(1); // untouched — that damage belonged to another shooter
  });

  it('double-fire in one frame at the same target: both reconcile independently, FIFO de-dupe order', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    l.predict('s2', 'hitscan', 'swarm-7', 20, 1000); // same frame, same target, distinct shot id
    expect(l.reconcileAck('s1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100).kind).toBe('confirmed');
    expect(l.reconcileAck('s2', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100).kind).toBe('confirmed');
    expect(l.size()).toBe(2);
    // Two authoritative DamageEvents for the same target de-dupe oldest-first.
    expect(l.reconcileDamage({ targetId: 'swarm-7', damage: 20 }, true, 1150)).toEqual({
      kind: 'dedupe',
      clientShotId: 's1',
    });
    expect(l.reconcileDamage({ targetId: 'swarm-7', damage: 20 }, true, 1151)).toEqual({
      kind: 'dedupe',
      clientShotId: 's2',
    });
    expect(l.size()).toBe(0);
  });

  it('two pending projectiles at one target confirm oldest-first (deterministic FIFO)', () => {
    const l = new HitPredictionLedger(TTL);
    l.predict('p1', 'projectile', 'swarm-7', 10, 1000);
    l.predict('p2', 'projectile', 'swarm-7', 10, 1010);
    expect(l.reconcileDamage({ targetId: 'swarm-7', damage: 10 }, true, 1500)).toEqual({
      kind: 'confirmed',
      clientShotId: 'p1',
    });
    expect(l.reconcileDamage({ targetId: 'swarm-7', damage: 10 }, true, 1520)).toEqual({
      kind: 'confirmed',
      clientShotId: 'p2',
    });
  });

  it('time is fully injected — behaviour depends only on the nowMs argument, never a wall clock', () => {
    const l = new HitPredictionLedger(TTL);
    // Drive "time" purely via args; the same nowMs always yields the same decision.
    l.predict('s1', 'hitscan', 'swarm-7', 20, 50_000);
    expect(l.tick(51_999)).toEqual([]);
    expect(l.tick(52_001)).toEqual([{ clientShotId: 's1', predictedTargetId: 'swarm-7' }]);
  });
});

describe('HitPredictionLedger — steady-path allocation probe (invariant: no per-shot GC churn)', () => {
  it('serial predict→reconcile cycles reuse pooled entries (allocations bounded, not O(cycles))', () => {
    const l = new HitPredictionLedger(TTL);
    for (let i = 0; i < 200; i++) {
      const id = `s${i}`;
      l.predict(id, 'hitscan', 'swarm-7', 20, 1000 + i);
      l.reconcileAck(id, { hit: false }, 1001 + i); // rolled_back → entry released to the pool
    }
    // A serial fire/reconcile loop should never grow past a tiny pool.
    expect(l.allocations()).toBeLessThanOrEqual(4);
    expect(l.size()).toBe(0);
  });
});
