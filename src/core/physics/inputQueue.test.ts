import { describe, it, expect } from 'vitest';
import { tickInputQueue, type QueuedInput } from './inputQueue.js';

/**
 * Regression coverage for the worker's input-queue contract.
 *
 * Two load-bearing rules; flipping either one diverges prediction:
 *
 *   1. **Held-ack-advance** — when the queue is empty (or the head is
 *      future-claimed and gated below), the worker re-applies the held
 *      input AND advances ack by 1. The 2026-05-06 mobile-lag incident was
 *      caused by the held branch NOT advancing ack: the worker re-applied
 *      held inputs each tick while snapshots reported a stale ack, and the
 *      client's reconciler double-applied the inputs the worker had already
 *      silently re-held. Drift was 14–70 units per snapshot at a 100%
 *      correction rate. See `docs/LESSONS.md` 2026-05-06.
 *
 *   2. **Tick-gated dequeue** — only drain inputs whose `claimedTick ≤
 *      currentTick`. Future-claim inputs stay queued until sim tick
 *      catches up. The 2026-05-09 ~10 u correction-burst pathology was
 *      caused by greedy draining: an input claiming tick X applied at
 *      simTick X-2 produced a constant ~10 u position drift on every
 *      snapshot until network jitter cleared. See `docs/LESSONS.md`
 *      2026-05-09. The gate also keeps `ackedTick ≤ serverTick` in
 *      steady state, eliminating the "ack-runs-ahead-of-serverTick"
 *      anomaly visible across all four diagnostic captures from
 *      2026-05-09.
 *
 * If any of these assertions ever flip, prediction will diverge again.
 */

const idle: Omit<QueuedInput, 'tick'> = {
  thrust: false,
  turnLeft: false,
  turnRight: false,
  boost: false,
  reverse: false,
};

describe('tickInputQueue — basic behaviour', () => {
  it('returns nulls when queue is empty AND nothing has been applied yet', () => {
    const queue: QueuedInput[] = [];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    const result = tickInputQueue(0, queue, lastApplied, lastAckTick, 0);

    expect(result.applied).toBeNull();
    expect(result.ackTick).toBeNull();
    expect(lastAckTick.has(0)).toBe(false);
  });

  it('dequeues a single input and surfaces its tick as the ack', () => {
    const queue: QueuedInput[] = [{ ...idle, tick: 100, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    const result = tickInputQueue(0, queue, lastApplied, lastAckTick, 100);

    expect(result.applied).toEqual({ ...idle, tick: 100, thrust: true });
    expect(result.ackTick).toBe(100);
    expect(queue).toHaveLength(0);
    expect(lastApplied.get(0)).toEqual({ ...idle, tick: 100, thrust: true });
    expect(lastAckTick.get(0)).toBe(100);
  });

  it('dequeues FIFO when multiple inputs are queued (one per step)', () => {
    const queue: QueuedInput[] = [
      { ...idle, tick: 100 },
      { ...idle, tick: 101, thrust: true },
      { ...idle, tick: 102, thrust: true, turnLeft: true },
    ];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 100).ackTick).toBe(100);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 101).ackTick).toBe(101);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 102).ackTick).toBe(102);
    expect(queue).toHaveLength(0);
  });
});

describe('tickInputQueue — held-input ack advance (2026-05-06 regression)', () => {
  it('re-applies held input AND advances ack by 1 per empty step', () => {
    // Receive one input at tick 100, then 5 ticks of nothing (client throttled).
    const queue: QueuedInput[] = [{ ...idle, tick: 100, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    // Tick 100: dequeue the real message.
    const t0 = tickInputQueue(0, queue, lastApplied, lastAckTick, 100);
    expect(t0.ackTick).toBe(100);

    // Ticks 101-105: queue empty, must re-apply held AND advance ack each step.
    for (let i = 1; i <= 5; i++) {
      const r = tickInputQueue(0, queue, lastApplied, lastAckTick, 100 + i);
      expect(r.applied?.thrust).toBe(true); // held re-application
      expect(r.ackTick).toBe(100 + i); // ack advances by 1 each tick
    }

    expect(lastAckTick.get(0)).toBe(105);
  });

  it('continues advancing ack across many held ticks (15-tick stretch)', () => {
    // Mirrors the worst case from the 2026-05-06 mobile diagnostic: 15
    // consecutive held re-applications between actual sends.
    const queue: QueuedInput[] = [{ ...idle, tick: 200, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    tickInputQueue(0, queue, lastApplied, lastAckTick, 200); // dequeue 200
    for (let i = 1; i <= 15; i++) {
      tickInputQueue(0, queue, lastApplied, lastAckTick, 200 + i);
    }

    // After 15 held re-applications, ack must be 215. If this regresses to
    // 200 (the pre-fix behaviour), the client's reconciler will double-apply
    // 15 ticks of input every snapshot and the player will feel ~70 units of
    // per-snapshot pull-back.
    expect(lastAckTick.get(0)).toBe(215);
  });

  it('a freshly-arrived input picks up the ack from the held trail', () => {
    // Throttle scenario: input at 100, held for 5 ticks, then a new input at
    // 105 arrives. The new ack must be 105 (the message's own tick), not 106
    // (the held trail's next value) — the message's authority dominates.
    const queue: QueuedInput[] = [{ ...idle, tick: 100, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    tickInputQueue(0, queue, lastApplied, lastAckTick, 100); // ack 100
    for (let i = 1; i <= 5; i++) tickInputQueue(0, queue, lastApplied, lastAckTick, 100 + i); // held → ack 105

    queue.push({ ...idle, tick: 105, thrust: false }); // user released
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick, 105);

    expect(r.applied?.thrust).toBe(false);
    expect(r.ackTick).toBe(105);
    expect(lastAckTick.get(0)).toBe(105);
  });

  it('does not regress ack when an out-of-order packet arrives with an older tick', () => {
    // Held trail has reached 110. A delayed packet from tick 103 arrives.
    // Apply the input (it's still authoritative for its tick) but keep the
    // ack at 110 — regressing it would tell the client to replay inputs the
    // worker has already applied.
    const queue: QueuedInput[] = [{ ...idle, tick: 100 }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    tickInputQueue(0, queue, lastApplied, lastAckTick, 100); // 100
    for (let i = 1; i <= 10; i++) tickInputQueue(0, queue, lastApplied, lastAckTick, 100 + i); // 110

    queue.push({ ...idle, tick: 103, turnLeft: true });
    // currentTick = 110 (sim has progressed past 103). 103 ≤ 110 → drain.
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick, 110);

    expect(r.applied?.turnLeft).toBe(true); // input applied to physics
    expect(r.ackTick).toBe(110); // ack pinned at the held trail's high-water mark
  });
});

describe('tickInputQueue — tick-gated dequeue (2026-05-09 regression)', () => {
  it('holds dequeue when head.tick > currentTick', () => {
    // Client sent input claiming tick 110 (predicting ahead). Server is at
    // currentTick 105. The greedy pre-2026-05-09 contract would dequeue and
    // apply, jumping ack to 110 while serverTick is still 105 — producing
    // the "ack-runs-ahead-of-serverTick" anomaly. The gated contract holds.
    const queue: QueuedInput[] = [{ ...idle, tick: 110, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    // No held input yet, so first call returns nulls (queue gated, nothing to fall back to).
    const r0 = tickInputQueue(0, queue, lastApplied, lastAckTick, 105);
    expect(r0.applied).toBeNull();
    expect(r0.ackTick).toBeNull();
    expect(queue).toHaveLength(1); // input still queued

    // Add a held baseline by applying an earlier input at currentTick=100.
    queue.unshift({ ...idle, tick: 100 });
    tickInputQueue(0, queue, lastApplied, lastAckTick, 100);
    expect(lastAckTick.get(0)).toBe(100);
    expect(queue).toHaveLength(1); // future-claim input remains queued

    // Now ticks 101-109: held trail advances ack but the future-claim input
    // STAYS queued (not drained early).
    for (let t = 101; t <= 109; t++) {
      const r = tickInputQueue(0, queue, lastApplied, lastAckTick, t);
      expect(r.applied?.thrust).toBe(false); // held = the original {tick:100, idle} input
      expect(r.ackTick).toBe(t);
      expect(queue).toHaveLength(1); // future-claim still gated
    }
    expect(lastAckTick.get(0)).toBe(109);

    // currentTick reaches 110: gate opens, the future-claim drains.
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick, 110);
    expect(r.applied?.thrust).toBe(true);
    expect(r.ackTick).toBe(110);
    expect(queue).toHaveLength(0);
  });

  it('drains stale inputs (head.tick < currentTick) immediately', () => {
    // A network-delayed input arrives long after its claimed tick. Better
    // late than never — apply it. ack is bounded by max(claim, prior); the
    // out-of-order test above covers the regression-prevention semantics.
    const queue: QueuedInput[] = [{ ...idle, tick: 50, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    // Sim has progressed to 200; a packet from tick 50 finally arrives.
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick, 200);
    expect(r.applied?.thrust).toBe(true);
    expect(r.ackTick).toBe(50); // first message — ack starts at the claim
    expect(queue).toHaveLength(0);
  });

  it('steady state: ack tracks currentTick when client sends one input per tick at currentTick', () => {
    // Models the post-fix steady state. Client sends input claiming tick X
    // when sim is at tick X. With the gate, every input drains in the same
    // physics step its claim arrives, ack == currentTick == claimTick. The
    // pre-fix contract would have ack drift +leadTicks above serverTick.
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    for (let t = 0; t < 30; t++) {
      const queue: QueuedInput[] = [{ ...idle, tick: t, thrust: true }];
      const r = tickInputQueue(0, queue, lastApplied, lastAckTick, t);
      expect(r.applied?.thrust).toBe(true);
      expect(r.ackTick).toBe(t);
    }

    expect(lastAckTick.get(0)).toBe(29);
  });

  it('multi-step batch arrival drains one-per-tick at the matching sim tick', () => {
    // Network jitter delivers four inputs in one server-tick window. The
    // pre-fix contract would have applied all four at successive sim ticks
    // starting from currentTick (e.g., applied input-claim-110 at simTick
    // currentTick), producing the 10 u-per-snapshot drift.
    //
    // The gate keeps each input queued until its claimed tick is reached.
    const queue: QueuedInput[] = [
      { ...idle, tick: 110, thrust: true },
      { ...idle, tick: 111, thrust: true, turnLeft: true },
      { ...idle, tick: 112, thrust: true, turnLeft: true },
      { ...idle, tick: 113, thrust: true },
    ];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    // Seed a held input first.
    const seed: QueuedInput[] = [{ ...idle, tick: 100 }];
    tickInputQueue(0, seed, lastApplied, lastAckTick, 100);

    // Sim advances 101..109 with held trail; the batch stays queued.
    for (let t = 101; t <= 109; t++) {
      tickInputQueue(0, queue, lastApplied, lastAckTick, t);
      expect(queue).toHaveLength(4);
    }

    // 110: drain head only.
    const r110 = tickInputQueue(0, queue, lastApplied, lastAckTick, 110);
    expect(r110.applied?.tick).toBe(110);
    expect(queue).toHaveLength(3);

    // 111-113: drain successively, one per tick.
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 111).applied?.tick).toBe(111);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 112).applied?.tick).toBe(112);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick, 113).applied?.tick).toBe(113);

    expect(queue).toHaveLength(0);
    expect(lastAckTick.get(0)).toBe(113);
  });
});

describe('tickInputQueue — multi-slot independence', () => {
  it('keeps per-slot state isolated', () => {
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    const slotAQueue: QueuedInput[] = [{ ...idle, tick: 50, thrust: true }];
    const slotBQueue: QueuedInput[] = [{ ...idle, tick: 1000, turnLeft: true }];

    tickInputQueue(0, slotAQueue, lastApplied, lastAckTick, 50);
    tickInputQueue(1, slotBQueue, lastApplied, lastAckTick, 1000);

    expect(lastAckTick.get(0)).toBe(50);
    expect(lastAckTick.get(1)).toBe(1000);
    expect(lastApplied.get(0)?.thrust).toBe(true);
    expect(lastApplied.get(1)?.turnLeft).toBe(true);

    // Held step on slot 0 must not touch slot 1.
    tickInputQueue(0, slotAQueue, lastApplied, lastAckTick, 51);
    expect(lastAckTick.get(0)).toBe(51);
    expect(lastAckTick.get(1)).toBe(1000);
  });
});
