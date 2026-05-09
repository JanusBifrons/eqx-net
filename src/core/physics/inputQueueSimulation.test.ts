/**
 * Worker-loop simulation tests for the input queue.
 *
 * The unit tests in `inputQueue.test.ts` cover discrete contract cases.
 * These tests simulate the *full* per-tick worker loop — many sim ticks
 * with realistic input-arrival patterns — and assert the gate invariant
 * across the entire timeline:
 *
 *   ackTick ≤ simTick (= worker `tick + 1` after the step) for every step.
 *
 * If this invariant ever holds *eventually* but breaks after enough ticks,
 * we have a drift accumulator somewhere. The 2026-05-09 mobile capture
 * `2026-05-09T09-17-37-576Z-ve6lad` showed exactly that pattern: offset
 * starts at 0, drifts to -3 after ~2 s, then -6/-7 after ~7 s. (In that
 * case the running server was pre-fix code; once tsx-watch restart was
 * forced and the gated code was actually loaded, the offset stayed at 0.)
 *
 * These tests run the gated contract for thousands of sim ticks under
 * various input patterns to catch any drift accumulator before it hits
 * production.
 */
import { describe, it, expect } from 'vitest';
import { tickInputQueue, type QueuedInput } from './inputQueue.js';

const idle: Omit<QueuedInput, 'tick'> = {
  thrust: false,
  turnLeft: false,
  turnRight: false,
  boost: false,
  reverse: false,
};

interface SimResult {
  totalSteps: number;
  invariantViolations: Array<{ step: number; ackTick: number; simTick: number }>;
  ackTicks: number[];
}

/**
 * Run the worker per-step loop for `totalSteps` sim ticks, given a
 * function that produces each step's input arrivals. Returns the per-step
 * ack values and any invariant violations.
 *
 * Mirrors `worker.ts:175-211` step structure:
 *   - tickInputQueue(slot, queue, lastApplied, lastAckTick, tick)
 *   - physics.applyInput(...) [skipped — we only care about ack]
 *   - tick++ (after the call, simTick = tick + 1 for the snapshot)
 */
function simulate(
  totalSteps: number,
  arrivalsForStep: (step: number) => QueuedInput[],
): SimResult {
  const queue: QueuedInput[] = [];
  const lastApplied = new Map<number, QueuedInput>();
  const lastAckTick = new Map<number, number>();
  const violations: SimResult['invariantViolations'] = [];
  const ackTicks: number[] = [];

  let tick = 0; // matches the worker's `let tick = 0` in worker.ts:107
  for (let step = 0; step < totalSteps; step++) {
    // Inputs for this step are appended to the queue (FIFO).
    queue.push(...arrivalsForStep(step));

    const result = tickInputQueue(0, queue, lastApplied, lastAckTick, tick);

    // After this call the worker would step physics and increment `tick`.
    // The snapshot emitted after the step reports serverTick = tick + 1.
    const simTickReported = tick + 1;

    if (result.ackTick !== null) {
      if (result.ackTick > simTickReported) {
        violations.push({ step, ackTick: result.ackTick, simTick: simTickReported });
      }
      ackTicks.push(result.ackTick);
    } else {
      ackTicks.push(-1); // no ack yet (pre-first-input)
    }

    tick++;
  }

  return { totalSteps, invariantViolations: violations, ackTicks };
}

describe('inputQueue worker-loop simulation', () => {
  it('steady-state: client sends one input claiming current sim tick, ack stays in lockstep', () => {
    // Client locally applies input at clientTick X and sends claim-X. With
    // zero network delay (best case), it arrives at server during step X.
    // Gate: claim X ≤ currentTick X → drain. ack = X. simTick after = X+1.
    const result = simulate(1000, (step) => [{ ...idle, tick: step, thrust: true }]);
    expect(result.invariantViolations).toEqual([]);
    // ack tracks step exactly, which is one behind simTick — the canonical
    // post-fix steady state. Equivalent to `srvTick - ackedTick = +1`.
    for (let i = 0; i < 1000; i++) {
      expect(result.ackTicks[i]).toBe(i);
    }
  });

  it('client predicts ahead: inputs claim future ticks, ack is gated and never exceeds simTick', () => {
    // Client predicts leadTicks=6 ahead, so claim-X arrives at server
    // around simTick X-6. Gate holds until simTick == X. This is the
    // pathological case the gate was added to fix.
    const LEAD = 6;
    const result = simulate(1000, (step) => {
      // Send input at server step S claiming clientTick S+LEAD.
      return [{ ...idle, tick: step + LEAD, thrust: true }];
    });
    expect(result.invariantViolations).toEqual([]);
  });

  it('drift-over-time stress: 5000 steps with constant lookahead — ack never drifts above simTick', () => {
    // The critical regression test for 2026-05-09: ensure ack does NOT
    // drift up over time under steady prediction lookahead. Pre-fix the
    // offset built up monotonically; gated, it stays bounded.
    const LEAD = 6;
    const result = simulate(5000, (step) => [{ ...idle, tick: step + LEAD }]);
    expect(result.invariantViolations).toEqual([]);
    // Every ack value must be ≤ its corresponding simTick.
    for (let i = 0; i < 5000; i++) {
      const simTick = i + 1;
      expect(result.ackTicks[i]).toBeLessThanOrEqual(simTick);
    }
  });

  it('jittered arrivals: bursts of 2-4 inputs land in single steps; gate prevents early apply', () => {
    // Network jitter packs multiple ticks of inputs into one server step's
    // arrival window. Pre-fix the worker would have drained them all at
    // their arrival sim ticks, applying future-claim inputs early.
    let nextClaim = 0;
    const result = simulate(2000, (step) => {
      const arrivals: QueuedInput[] = [];
      // Every ~5 steps, deliver a burst of 3 inputs claiming successive ticks.
      if (step % 5 === 0) {
        for (let i = 0; i < 3; i++) {
          arrivals.push({ ...idle, tick: nextClaim, thrust: true });
          nextClaim++;
        }
      }
      return arrivals;
    });
    expect(result.invariantViolations).toEqual([]);
  });

  it('throttled idle: one input then 100 ticks of nothing — held trail keeps ack tracking simTick', () => {
    // Client sends one input then idles. Server's held-ack-advance must
    // increment ack by 1 per step (the 2026-05-06 contract), and the gate
    // must not interfere when the queue is empty.
    const result = simulate(100, (step) => (step === 0 ? [{ ...idle, tick: 0 }] : []));
    expect(result.invariantViolations).toEqual([]);
    // Step 0: drain at currentTick=0, ack=0, simTick=1. ackTicks[0]=0.
    // Step 1: held, ack=1, simTick=2. ackTicks[1]=1.
    // Step k: held, ack=k. simTick=k+1.
    for (let k = 0; k < 100; k++) {
      expect(result.ackTicks[k]).toBe(k);
    }
  });

  it('mixed throttle + future-claim: client throttles for 50 ticks then sends a burst predicting forward', () => {
    // Realistic mobile scenario: input idle for many ticks (held key
    // dropped), then a burst of new inputs claiming several future ticks.
    // Ack must track simTick smoothly through both phases.
    const result = simulate(200, (step) => {
      if (step === 0) return [{ ...idle, tick: 0, thrust: true }];
      if (step === 50) {
        // Burst: 5 inputs claiming ticks 56..60 (predicting +6..+10 ahead).
        return Array.from({ length: 5 }, (_, i) => ({
          ...idle,
          tick: 56 + i,
          thrust: true,
          turnLeft: i % 2 === 0,
        }));
      }
      return [];
    });
    expect(result.invariantViolations).toEqual([]);
    // Verify the burst inputs were drained at their claimed ticks, not earlier.
    // After step 50, the queue holds [56, 57, 58, 59, 60]. Steps 51-55 are held.
    // Step 56 (currentTick=56): drain claim-56. simTick=57. ack=56.
    // Step 57 (currentTick=57): drain claim-57. simTick=58. ack=57.
    // ...
    expect(result.ackTicks[56]).toBe(56);
    expect(result.ackTicks[57]).toBe(57);
    expect(result.ackTicks[58]).toBe(58);
    expect(result.ackTicks[59]).toBe(59);
    expect(result.ackTicks[60]).toBe(60);
  });

  it('matches the production data signature: ack offset never goes negative under any pattern', () => {
    // The 2026-05-09 capture had `srvTick - ackedTick = -3` mode (ack 3
    // ticks ahead of sim). With the gate, this offset should never go
    // negative regardless of input timing.
    const LEAD = 10; // exaggerated lookahead to stress-test
    const result = simulate(3000, (step) => {
      // Every other step, send 1-2 inputs claiming forward; sometimes skip.
      if (step % 7 === 0) return []; // throttle gap
      const count = (step % 3) + 1;
      return Array.from({ length: count }, (_, i) => ({
        ...idle,
        tick: step + LEAD + i,
        thrust: true,
      }));
    });
    expect(result.invariantViolations).toEqual([]);
    // Translate to the production-side offset (= simTick - ackTick).
    const offsets = result.ackTicks.map((ack, i) => (i + 1) - ack);
    const minOffset = Math.min(...offsets.filter((o) => !Number.isNaN(o)));
    expect(minOffset).toBeGreaterThanOrEqual(0);
  });
});
