/**
 * Per-slot input-queue tick: the worker's per-step decision of which input to
 * apply and what tick to acknowledge.
 *
 * Extracted from `worker.ts` so the contract (especially the held-input
 * ack-advance rule that is load-bearing for prediction-reconciliation
 * convergence under client-side input throttling) can be unit-tested.
 *
 * See `src/core/CLAUDE.md` → "Physics Worker — Input Queue Contract" for the
 * invariant; see `docs/LESSONS.md` for the 2026-05-06 mobile-lag incident
 * that motivated the held-ack-advance rule.
 */

export interface QueuedInput {
  tick: number;
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  /** Drifty-arcade reverse — S / Down arrow held. Optional in the wire schema
   *  for back-compat; missing = `false`. */
  reverse: boolean;
}

export interface InputTickResult {
  /** Input to apply to physics this tick. `null` only when both the queue is
   *  empty AND no input has ever been applied for this slot (fresh spawn). */
  applied: QueuedInput | null;
  /** Tick value to surface as `ackedTick` (via SAB → snapshot). `null` mirrors
   *  `applied: null`. The dequeue path returns the message's own `tick`; the
   *  held path returns the prior ack + 1 (synthesised). */
  ackTick: number | null;
}

/**
 * Process one physics tick of input for a single slot. Mutates `queue`,
 * `lastApplied`, and `lastAckTick` as a deliberate side effect (cheap; no
 * allocation; matches how the worker uses these maps).
 *
 * Behaviour contract:
 * - **Queue non-empty AND `head.tick ≤ currentTick`**: dequeue head, store as
 *   held, advance ack to `max(message.tick, prior ack)` so out-of-order
 *   packets never regress ack. Stale claims (`head.tick < currentTick`,
 *   e.g. a delayed retransmit) are still drained — the input is better
 *   applied late than dropped.
 * - **Queue non-empty BUT `head.tick > currentTick`**: hold. The client
 *   sent an input claiming a future sim tick (normal under client-side
 *   prediction with positive `leadTicks`); applying it now would change
 *   the slot's velocity at the wrong sim tick, producing the ~10 u
 *   reconcile drifts diagnosed on 2026-05-09. Behave as if the queue
 *   were empty — re-apply held, ack+1 — and try again next step.
 * - **Queue empty + held input present**: re-apply held, advance ack by 1.
 *   This synthesises an "implicit re-send" matching what the throttled client
 *   would have sent at that tick under the old send-every-tick model.
 * - **Queue empty + no held**: no-op (fresh spawn, never received an input).
 *
 * The tick-gate (added 2026-05-09) is the structural fix for the
 * "ack-runs-ahead-of-serverTick" pathology — see `docs/LESSONS.md`. The
 * client locally applies input I_X at clientTick X, producing state
 * s_(X+1). For prediction-reconciliation to converge, the server must
 * apply I_X to state s_X (= state at simTick X), producing state s_(X+1)
 * at simTick X+1. The pre-2026-05-09 contract drained the queue greedily
 * regardless of `head.tick`, applying I_X at whichever sim tick the queue
 * happened to be drained — typically `simTick = X − 2` or so, two ticks
 * early. Reconciliation then compared server state-at-(X-2) (which had
 * I_X already applied) against client state-at-(X-2) (which had not), so
 * pure-position drift accumulated by ~10 u per snapshot under network
 * jitter. The gate keeps inputs queued until sim tick reaches their
 * claimed tick, eliminating the divergence.
 *
 * The held-ack-advance rule is essential. Without it, a client that throttles
 * redundant input sends (see `ColyseusClient.tickPhysics()` and the
 * `INPUT_HEARTBEAT_MS` constant) leaves the queue empty for many ticks while
 * a key is held, the worker silently re-applies the held input, but the
 * snapshot reports a stale `ackedTick`, and the client's reconciler then
 * REPLAYS the same inputs the worker just re-applied. Per-snapshot drift of
 * 14–70 units results, with a 100 % correction rate. See `docs/LESSONS.md`
 * for the 2026-05-06 incident.
 */
export function tickInputQueue(
  slot: number,
  queue: QueuedInput[],
  lastApplied: Map<number, QueuedInput>,
  lastAckTick: Map<number, number>,
  currentTick: number,
): InputTickResult {
  if (queue.length > 0 && queue[0]!.tick <= currentTick) {
    const entry = queue.shift()!;
    lastApplied.set(slot, entry);
    const baseline = lastAckTick.get(slot) ?? -1;
    const newAck = entry.tick > baseline ? entry.tick : baseline;
    lastAckTick.set(slot, newAck);
    return { applied: entry, ackTick: newAck };
  }
  const held = lastApplied.get(slot);
  if (!held) return { applied: null, ackTick: null };
  const next = (lastAckTick.get(slot) ?? held.tick) + 1;
  lastAckTick.set(slot, next);
  return { applied: held, ackTick: next };
}
