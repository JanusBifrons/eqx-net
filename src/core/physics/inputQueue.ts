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
 * - **Queue non-empty**: dequeue head, store as held, advance ack to
 *   `max(message.tick, prior ack)` so out-of-order packets never regress ack.
 * - **Queue empty + held input present**: re-apply held, advance ack by 1.
 *   This synthesises an "implicit re-send" matching what the throttled client
 *   would have sent at that tick under the old send-every-tick model.
 * - **Queue empty + no held**: no-op (fresh spawn, never received an input).
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
): InputTickResult {
  if (queue.length > 0) {
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
