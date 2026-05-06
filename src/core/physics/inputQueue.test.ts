import { describe, it, expect } from 'vitest';
import { tickInputQueue, type QueuedInput } from './inputQueue.js';

/**
 * Regression coverage for the worker's input-queue contract.
 *
 * The held-ack-advance rule is load-bearing for prediction-reconciliation
 * convergence under client-side input throttling (`INPUT_HEARTBEAT_MS`).
 * The 2026-05-06 mobile-lag incident was caused by the held branch NOT
 * advancing `ackedTick`: the worker re-applied held inputs each tick while
 * snapshots reported a stale ack, and the client's reconciler double-applied
 * the inputs the worker had already silently re-held. Drift was 14–70 units
 * per snapshot at a 100 % correction rate. See `docs/LESSONS.md` 2026-05-06
 * for the full incident.
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

    const result = tickInputQueue(0, queue, lastApplied, lastAckTick);

    expect(result.applied).toBeNull();
    expect(result.ackTick).toBeNull();
    expect(lastAckTick.has(0)).toBe(false);
  });

  it('dequeues a single input and surfaces its tick as the ack', () => {
    const queue: QueuedInput[] = [{ ...idle, tick: 100, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    const result = tickInputQueue(0, queue, lastApplied, lastAckTick);

    expect(result.applied).toEqual({ ...idle, tick: 100, thrust: true });
    expect(result.ackTick).toBe(100);
    expect(queue).toHaveLength(0);
    expect(lastApplied.get(0)).toEqual({ ...idle, tick: 100, thrust: true });
    expect(lastAckTick.get(0)).toBe(100);
  });

  it('dequeues FIFO when multiple inputs are queued', () => {
    const queue: QueuedInput[] = [
      { ...idle, tick: 100 },
      { ...idle, tick: 101, thrust: true },
      { ...idle, tick: 102, thrust: true, turnLeft: true },
    ];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    expect(tickInputQueue(0, queue, lastApplied, lastAckTick).ackTick).toBe(100);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick).ackTick).toBe(101);
    expect(tickInputQueue(0, queue, lastApplied, lastAckTick).ackTick).toBe(102);
    expect(queue).toHaveLength(0);
  });
});

describe('tickInputQueue — held-input ack advance (2026-05-06 regression)', () => {
  it('re-applies held input AND advances ack by 1 per empty step', () => {
    // Receive one input at tick 100, then 5 ticks of nothing (client throttled).
    const queue: QueuedInput[] = [{ ...idle, tick: 100, thrust: true }];
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    // Tick 0: dequeue the real message.
    const t0 = tickInputQueue(0, queue, lastApplied, lastAckTick);
    expect(t0.ackTick).toBe(100);

    // Ticks 1-5: queue empty, must re-apply held AND advance ack each step.
    for (let i = 1; i <= 5; i++) {
      const r = tickInputQueue(0, queue, lastApplied, lastAckTick);
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

    tickInputQueue(0, queue, lastApplied, lastAckTick); // dequeue 200
    for (let i = 1; i <= 15; i++) {
      tickInputQueue(0, queue, lastApplied, lastAckTick);
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

    tickInputQueue(0, queue, lastApplied, lastAckTick); // ack 100
    for (let i = 0; i < 5; i++) tickInputQueue(0, queue, lastApplied, lastAckTick); // held → ack 105

    queue.push({ ...idle, tick: 105, thrust: false }); // user released
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick);

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

    tickInputQueue(0, queue, lastApplied, lastAckTick); // 100
    for (let i = 0; i < 10; i++) tickInputQueue(0, queue, lastApplied, lastAckTick); // 110

    queue.push({ ...idle, tick: 103, turnLeft: true });
    const r = tickInputQueue(0, queue, lastApplied, lastAckTick);

    expect(r.applied?.turnLeft).toBe(true); // input applied to physics
    expect(r.ackTick).toBe(110); // ack pinned at the held trail's high-water mark
  });
});

describe('tickInputQueue — multi-slot independence', () => {
  it('keeps per-slot state isolated', () => {
    const lastApplied = new Map<number, QueuedInput>();
    const lastAckTick = new Map<number, number>();

    const slotAQueue: QueuedInput[] = [{ ...idle, tick: 50, thrust: true }];
    const slotBQueue: QueuedInput[] = [{ ...idle, tick: 1000, turnLeft: true }];

    tickInputQueue(0, slotAQueue, lastApplied, lastAckTick);
    tickInputQueue(1, slotBQueue, lastApplied, lastAckTick);

    expect(lastAckTick.get(0)).toBe(50);
    expect(lastAckTick.get(1)).toBe(1000);
    expect(lastApplied.get(0)?.thrust).toBe(true);
    expect(lastApplied.get(1)?.turnLeft).toBe(true);

    // Held step on slot 0 must not touch slot 1.
    tickInputQueue(0, slotAQueue, lastApplied, lastAckTick);
    expect(lastAckTick.get(0)).toBe(51);
    expect(lastAckTick.get(1)).toBe(1000);
  });
});
