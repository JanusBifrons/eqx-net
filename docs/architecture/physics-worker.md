# Physics worker: the input queue

How the authoritative physics worker ([src/core/physics/worker.ts](../../src/core/physics/worker.ts)) applies each player's inputs. The rules themselves are in [src/core/CLAUDE.md](../../src/core/CLAUDE.md#physics-worker--input-queue-contract); this page explains why each one holds.

## Input queue contract

Per-slot input handling lives in [src/core/physics/inputQueue.ts](../../src/core/physics/inputQueue.ts) and is invoked once per slot per physics step from `worker.ts`. The contract has four equally load-bearing rules:

1. **Tick-gated dequeue. Queue non-empty AND `head.tick ≤ currentTick` → dequeue head, apply, ack = its tick.** The gate is the structural alignment: the client locally applies input I_X at clientTick X to produce state s_(X+1); the server must apply I_X at simTick X to produce its own s_(X+1) so reconciliation converges. Stale claims are still honoured (better late than dropped), but a claim for a tick already simulated never gets its own step (rule 4), so the ack never regresses and never stalls.
2. **Queue non-empty BUT `head.tick > currentTick` → hold (treat as queue-empty).** The future-claim input stays queued until sim tick catches up. The slot continues on the held input via rule 3.
3. **Queue empty (or gated above) + held input present → re-apply held AND advance ack by 1.** The ack synthesises an "implicit re-send" matching what the throttled client (`INPUT_HEARTBEAT_MS` in `ColyseusClient.tickPhysics()`) would have sent at that tick under a send-every-tick model.
4. **One sim step = one acked tick.** An input whose tick the worker already simulated (it arrived late, after the held input stood in for it) is NOT applied as another step: its content becomes the held input, and the step acks the next tick.

### Why rule 3 advances the ack

Newcomers will be tempted to "fix" rule 3 by leaving the ack pinned to the last received message. Don't. With client-side input throttling the held branch fires for ~94 % of ticks while a key is held, and a stale `ackedTick` makes the client's reconciler **double-apply** every input the worker has just silently re-held.

### Why rule 1 gates on the tick

Without the gate, reconcile vs replay diverges by exactly one input application worth of velocity (~10 u of position) on every snapshot whose `ackedTick` exceeds `serverTick`. If you want to "drain greedily for lower latency", remember: the application latency (~RTT/2 ticks of held input on the server) is exactly what client-side prediction buffers against, so the round-trip cost is zero. Skipping the gate breaks reconciliation alignment, which is much worse than a few ticks of authoritative-side latency.

### Locks

[src/core/physics/inputQueue.test.ts](../../src/core/physics/inputQueue.test.ts) locks all four rules:
- reverting the held-ack-advance rule fails "advances ack across many held ticks";
- removing the tick gate fails "holds dequeue when head.tick > currentTick" and "steady state: ack tracks currentTick";
- applying a late input as its own step fails "one sim step, one acked tick".

## History

- **2026-05-06, held-ack-advance.** The original code left the ack at the last dequeued tick (`// Don't update appliedTicks — ackedTick stays at last-dequeued tick.`). It worked only because the client then sent every tick, so the held branch never fired in practice. Once client-side input throttling landed (network-discipline P4), the stale ack caused double-applied inputs. See [docs/LESSONS.md](../LESSONS.md) (2026-05-06).
- **2026-05-09, tick gate.** Before this the queue drained greedily without the gate, and a client predicting forward (claimedTick > simTick at receive time) saw its inputs applied early: every snapshot reported `ackedTick > serverTick` and drift accumulated at ~10 u per snapshot. See [docs/LESSONS.md](../LESSONS.md) (2026-05-09, "server input queue drained inputs claiming future ticks").
- **2026-11-07, one step per acked tick.** The old `max(claim, prior)` rule applied a late input as a second step while the ack stayed put, so the snapshot pose sat one tick ahead of its `ackedTick`. Every late arrival then showed as a prediction correction of exactly one tick of motion, flipping back later: the showcase "jitter" (0 corrections per take after the fix, 9-61 before).
