/**
 * weapon-hit-prediction Phase 2 — client predicted-resolution module.
 *
 * The fire-time decision ("what did the shot hit, in the pose the player
 * SEES, and what immediate feedback do we show") is extracted here out of
 * the 3000-line ColyseusClient so it is unit-testable with a fake predWorld
 * + a fake feedback sink + the real (pure) HitPredictionLedger — the
 * client CLAUDE.md Phase-A3 pattern (decision logic in a pure module;
 * Pixi/side-effects stay in the big file).
 *
 * Node env (`*.test.ts`). No Pixi, no Colyseus, no renderer.
 */
import { describe, it, expect } from 'vitest';
import { HitPredictionLedger } from '@core/combat/HitPrediction';
import {
  resolveClosestPredictedHit,
  predictShotOutcome,
  reconcileAckToFeedback,
  reconcileDamageToFeedback,
  type PredHitscanWorld,
  type MountFireGeom,
  type PredictedFeedbackSink,
  type ReconcileFeedbackSink,
} from './HitPrediction.client.js';

/** Fake predWorld: returns a scripted hit per (fromX) so multi-mount
 *  aggregation is deterministic. `null` ⇒ that ray missed. */
function fakeWorld(byFromX: Record<number, { hitId: string; dist: number } | null>): PredHitscanWorld {
  return {
    hitscan: (fromX) => byFromX[fromX] ?? null,
  };
}

function recordingSink(): PredictedFeedbackSink & {
  numbers: Array<{ x: number; y: number; damage: number; tag: string }>;
  flashes: string[];
} {
  const numbers: Array<{ x: number; y: number; damage: number; tag: string }> = [];
  const flashes: string[] = [];
  return {
    numbers,
    flashes,
    pushDamageNumber: (x, y, damage, tag) => numbers.push({ x, y, damage, tag }),
    flashTarget: (id) => flashes.push(id),
  };
}

const mount = (fromX: number): MountFireGeom => ({ fromX, fromY: 0, fwdX: 1, fwdY: 0 });

describe('resolveClosestPredictedHit — aggregate the closest mount-hit (mirrors server hit_ack)', () => {
  it('returns null when no mount ray hits anything', () => {
    const w = fakeWorld({ 0: null, 10: null });
    expect(resolveClosestPredictedHit(w, [mount(0), mount(10)], 500, 'me')).toBeNull();
  });

  it('single mount hit → that hit, with hitX/hitY along the ray', () => {
    const w = fakeWorld({ 5: { hitId: 'swarm-7', dist: 30 } });
    expect(resolveClosestPredictedHit(w, [mount(5)], 500, 'me')).toEqual({
      hitId: 'swarm-7',
      dist: 30,
      hitX: 5 + 30, // fromX + fwdX*dist
      hitY: 0,
    });
  });

  it('two mounts hit → the CLOSEST wins (server reports the closest mount-hit)', () => {
    const w = fakeWorld({
      0: { hitId: 'swarm-far', dist: 100 },
      10: { hitId: 'swarm-near', dist: 40 },
    });
    const r = resolveClosestPredictedHit(w, [mount(0), mount(10)], 500, 'me');
    expect(r).toEqual({ hitId: 'swarm-near', dist: 40, hitX: 50, hitY: 0 });
  });

  it('ties resolve to the first mount in iteration order (deterministic)', () => {
    const w = fakeWorld({
      0: { hitId: 'first', dist: 40 },
      10: { hitId: 'second', dist: 40 },
    });
    expect(resolveClosestPredictedHit(w, [mount(0), mount(10)], 500, 'me')?.hitId).toBe('first');
  });
});

describe('predictShotOutcome — ledger.predict + immediate tagged feedback', () => {
  it('hitscan hit → ledger predicts the target + a TAGGED number + flash; returns the target id', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingSink();
    const w = fakeWorld({ 5: { hitId: 'swarm-7', dist: 30 } });
    const ret = predictShotOutcome({
      ledger,
      sink,
      world: w,
      clientShotId: 'shot-1',
      mode: 'hitscan',
      damage: 20,
      mounts: [mount(5)],
      maxDist: 500,
      excludeId: 'me',
      nowMs: 1000,
    });
    expect(ret).toBe('swarm-7');
    expect(sink.numbers).toEqual([{ x: 35, y: 0, damage: 20, tag: 'shot-1' }]);
    expect(sink.flashes).toEqual(['swarm-7']);
    // The ledger now holds a confirmable hitscan prediction for swarm-7.
    expect(ledger.reconcileAck('shot-1', { hit: true, targetId: 'swarm-7', damage: 20 }, 1100)).toEqual({
      kind: 'confirmed',
      clientShotId: 'shot-1',
      targetId: 'swarm-7',
      damage: 20,
    });
  });

  it('predicted MISS → ledger still records the shot, but NOTHING is pushed (no number, no flash)', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingSink();
    const w = fakeWorld({ 5: null });
    const ret = predictShotOutcome({
      ledger,
      sink,
      world: w,
      clientShotId: 'shot-2',
      mode: 'hitscan',
      damage: 20,
      mounts: [mount(5)],
      maxDist: 500,
      excludeId: 'me',
      nowMs: 1000,
    });
    expect(ret).toBeNull();
    expect(sink.numbers).toEqual([]);
    expect(sink.flashes).toEqual([]);
    // A predicted-miss is still tracked so the ack can resolve it (noop /
    // false_negative) in Phase 3.
    expect(ledger.reconcileAck('shot-2', { hit: false }, 1100)).toEqual({ kind: 'noop', clientShotId: 'shot-2' });
  });

  it('projectile mode is threaded to the ledger (ack ignored; stays pending for DamageEvent/TTL)', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingSink();
    const w = fakeWorld({ 5: { hitId: 'swarm-9', dist: 60 } });
    predictShotOutcome({
      ledger,
      sink,
      world: w,
      clientShotId: 'proj-1',
      mode: 'projectile',
      damage: 10,
      mounts: [mount(5)],
      maxDist: 2400,
      excludeId: 'me',
      nowMs: 1000,
    });
    expect(sink.numbers).toEqual([{ x: 65, y: 0, damage: 10, tag: 'proj-1' }]);
    // Projectile: the (always hit:false) server ack must NOT roll it back.
    expect(ledger.reconcileAck('proj-1', { hit: false }, 1050)).toEqual({ kind: 'noop', clientShotId: 'proj-1' });
    expect(ledger.size()).toBe(1);
    // It reconciles via the authoritative DamageEvent instead.
    expect(ledger.reconcileDamage({ targetId: 'swarm-9', damage: 10 }, true, 1600)).toEqual({
      kind: 'confirmed',
      clientShotId: 'proj-1',
    });
  });

  it('multi-mount: the predicted number/flash use the CLOSEST hit (one aggregate per fire)', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingSink();
    const w = fakeWorld({
      0: { hitId: 'swarm-far', dist: 100 },
      10: { hitId: 'swarm-near', dist: 40 },
    });
    const ret = predictShotOutcome({
      ledger,
      sink,
      world: w,
      clientShotId: 'shot-3',
      mode: 'hitscan',
      damage: 20,
      mounts: [mount(0), mount(10)],
      maxDist: 500,
      excludeId: 'me',
      nowMs: 1000,
    });
    expect(ret).toBe('swarm-near');
    expect(sink.numbers).toEqual([{ x: 50, y: 0, damage: 20, tag: 'shot-3' }]);
    expect(sink.flashes).toEqual(['swarm-near']);
  });
});

// ── Phase 3 — the SINGLE reconcile path (hit_ack / DamageEvent) ─────────────
function recordingReconcileSink(): ReconcileFeedbackSink & {
  cancels: string[];
  flashClears: string[];
} {
  const cancels: string[] = [];
  const flashClears: string[] = [];
  return {
    cancels,
    flashClears,
    cancelPredictedNumber: (id) => cancels.push(id),
    clearPredictedFlash: (tid) => flashClears.push(tid),
  };
}

describe('reconcileAckToFeedback — hitscan hit_ack is the single correction path', () => {
  it('confirmed ack: NO cancel/flash-clear, then the authoritative DamageEvent de-dupes (no double-count)', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    ledger.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = reconcileAckToFeedback(ledger, 's1', { hit: true, targetId: 'swarm-7', damage: 20 }, sink, 1100);
    expect(r.kind).toBe('confirmed');
    expect(sink.cancels).toEqual([]);
    expect(sink.flashClears).toEqual([]);
    // The predicted number stays on screen; the imminent DamageEvent must
    // be suppressed so exactly one number shows for the confirmed hit.
    expect(reconcileDamageToFeedback(ledger, { targetId: 'swarm-7', damage: 20 }, true, 1150)).toBe(true);
    expect(ledger.size()).toBe(0);
  });

  it('rolled_back ack (predicted hit, server says miss): hard-cancel number + clear flash', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    ledger.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = reconcileAckToFeedback(ledger, 's1', { hit: false }, sink, 1100);
    expect(r.kind).toBe('rolled_back');
    expect(sink.cancels).toEqual(['s1']);
    expect(sink.flashClears).toEqual(['swarm-7']);
  });

  it('corrected ack (server hit a different target): hard-cancel the mispredicted number + clear its flash', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    ledger.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    const r = reconcileAckToFeedback(ledger, 's1', { hit: true, targetId: 'swarm-9', damage: 20 }, sink, 1100);
    expect(r.kind).toBe('corrected');
    expect(sink.cancels).toEqual(['s1']);
    expect(sink.flashClears).toEqual(['swarm-7']); // the WRONG (predicted) target
  });

  it('false_negative ack (predicted miss, server says hit): NO spurious rollback; authoritative path untouched', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    ledger.predict('s1', 'hitscan', null, 0, 1000);
    const r = reconcileAckToFeedback(ledger, 's1', { hit: true, targetId: 'swarm-9', damage: 20 }, sink, 1100);
    expect(r.kind).toBe('false_negative');
    expect(sink.cancels).toEqual([]);
    expect(sink.flashClears).toEqual([]);
    // The real DamageEvent must NOT be suppressed (there was no predicted
    // number) — handleDamage shows it exactly as today.
    expect(reconcileDamageToFeedback(ledger, { targetId: 'swarm-9', damage: 20 }, true, 1150)).toBe(false);
  });

  it('noop ack (unknown clientShotId): nothing emitted', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    const r = reconcileAckToFeedback(ledger, 'ghost', { hit: true, targetId: 'x', damage: 1 }, sink, 1000);
    expect(r.kind).toBe('noop');
    expect(sink.cancels).toEqual([]);
    expect(sink.flashClears).toEqual([]);
  });

  it('projectile: the ack is a noop (never rolled back); the DamageEvent confirms + de-dupes', () => {
    const ledger = new HitPredictionLedger();
    const sink = recordingReconcileSink();
    ledger.predict('p1', 'projectile', 'swarm-9', 10, 1000);
    const r = reconcileAckToFeedback(ledger, 'p1', { hit: false }, sink, 1050);
    expect(r.kind).toBe('noop');
    expect(sink.cancels).toEqual([]); // NOT rolled back on the (always-false) projectile ack
    expect(ledger.size()).toBe(1);
    expect(reconcileDamageToFeedback(ledger, { targetId: 'swarm-9', damage: 10 }, true, 1600)).toBe(true);
    expect(ledger.size()).toBe(0);
  });
});

describe('reconcileDamageToFeedback — handleDamage stays the sole authority; only the dup number is gated', () => {
  it('a DamageEvent from another shooter is never suppressed (passthrough)', () => {
    const ledger = new HitPredictionLedger();
    ledger.predict('s1', 'hitscan', 'swarm-7', 20, 1000);
    reconcileAckToFeedback(ledger, 's1', { hit: true, targetId: 'swarm-7', damage: 20 }, recordingReconcileSink(), 1100);
    // shooterIsSelf=false → handleDamage must behave exactly as today.
    expect(reconcileDamageToFeedback(ledger, { targetId: 'swarm-7', damage: 20 }, false, 1150)).toBe(false);
  });

  it('a DamageEvent with no matching prediction is never suppressed (passthrough)', () => {
    const ledger = new HitPredictionLedger();
    expect(reconcileDamageToFeedback(ledger, { targetId: 'swarm-3', damage: 20 }, true, 1000)).toBe(false);
  });
});
