# Physics worker

How the authoritative physics worker ([src/core/physics/worker.ts](../../src/core/physics/worker.ts)) applies each player's inputs, hosts several sector worlds, and reports back to the main thread. The rules themselves are in [src/core/CLAUDE.md](../../src/core/CLAUDE.md#physics-worker--input-queue-contract); this page explains why they hold.

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

## One worker, many worlds

`worker.ts` builds each sector world with `createWorld(sab, post)`: its Rapier world, input queues, sleep state and SAB writer all live in that closure.
- **Single-world mode** (`workerData.sab`, untagged messages) is what tests that spawn a bare worker use.
- **Pooled mode** (`workerData.pooled`) takes `ADD_WORLD { worldId, sab }` / `REMOVE_WORLD { worldId }`, routes every other command by its `worldId`, tags every reply with it, posts `POOL_READY` at start and `READY { worldId }` per world, and steps every hosted world once per tick.
- Several sectors share one worker, so per-sector state never goes at module scope. Server side: `src/server/rooms/PhysicsWorkerPool.ts`.

## Worker-to-main messages

The worker posts three discrete message types to the main thread:

- **`READY`**: once Rapier init completes (per world in pooled mode). The main-thread `SectorRoom` resolves its `start()` promise on it.
- **`SLEEP_TRANSITION { entityId, sleeping, tick }`**: whenever a body's effective sleep state crosses the `SLEEP_HYSTERESIS_TICKS` boundary (Phase 5). The main thread re-emits it as `ENTITY_SLEPT` / `ENTITY_WOKE` on the local Bus.
- **`CONTACT_BATCH { tick, contacts: Contact[] }`**: per tick when Rapier's `EventQueue` produced contact-force events above `CONTACT_FORCE_FLOOR` (Stage 2 of the network-feel roadmap). Skipped (no message) when the tick produced no qualifying contacts. The main thread re-emits each contact as `COLLISION_RESOLVED` on the Bus and broadcasts a `collision_resolved` network message.
  - Each `Contact` carries `{ aId, bId, vAxPost, vAyPost, vBxPost, vByPost, forceMagnitude, impactSpeed?, normalSpeed?, aMass?, bMass? }`.
  - `impactSpeed` is the closing speed at impact: the magnitude of the relative velocity from the bodies' PRE-step velocities (the worker keeps a `prevVel` snapshot = last tick's post-step velocities and passes it to `drainContacts`).
  - `normalSpeed` is that relative velocity projected on the contact normal (`event.maxForceDirection()`, a→b, clamped ≥ 0): head-on ≈ impactSpeed, a glancing scrape small.
  - `aMass` / `bMass` are the folded Rapier body masses (`World.getBodyMass`).
  - Post-step velocity is NOT a usable impact measure: a ship that head-on-stops against a static structure has `vPost ≈ 0` yet a hard impact.

**Ramming.** These fields drive the impact-based ramming model in `core/combat/Ramming.ts`: `aggregateRamming` takes the max `normalSpeed` per pair, `E = ½·μ·(vN − RAM_MIN_IMPACT_SPEED)²` (μ = reduced mass), and `damageTo(self) = min(RAM_DAMAGE_MAX, RAM_DAMAGE_PER_ENERGY · E · mOther/(mSelf+mOther))`: equal ships both hurt equally, the lighter takes more, a slow bump is free (`RamPair.damageA` / `damageB` per side). A full-speed fighter head-on deals ~291 to each (~55 % of its 525 pool) at the 2× default scale; both ram constants were scaled ×1.75 with the arcade toughness layer. Full curve: [collision-layers.md](collision-layers.md#damage-curve--impact-based-ramming-as-a-weapon-2026-11-13).

**Adding a fourth variant:** extend the worker's `parentPort!.postMessage` site and the SectorRoom message handler's discriminator (`msg.type`), and update this list. The main→worker direction has its own discriminated union (`WorkerCommand`); the reverse direction is informally typed because the handler narrows explicitly on receive.

## Main-to-worker commands

The authoritative list is the `WorkerCommand` union plus the header docstring in [src/core/physics/worker.ts](../../src/core/physics/worker.ts). Keep the worker union, `SectorRoom.WorkerCmd` and this note in sync.

**Current set:** `SPAWN`, `DESPAWN`, `INPUT`, `SPAWN_OBSTACLE` (a drone's optional `shipKindId` = its catalogue index, stored as the body's `pilotKind`), `AI_INTENT`, `AI_INPUTS { count, slots: Uint16Array, bits: Uint8Array }` (pilot layer: every AI slot flown by control keys this tick in ONE message, packed `AiInputBits` from `contracts/IAiBehaviour.ts`; each runs `World.applyAiInput` → `applyShipInput`, the same seam as a pilot's `INPUT`, and the first call gives the body its kind's damping; a `BOT_WARP` that owns the body drops it like an `AI_INTENT`. `AiController` routes an intent with `input` set into the sink's `postInput` / `flushInputs` batch, `AiInputBatch`), `CLOCK_RATE`, `SET_POSITION`, `REKEY_SHIP`, `SET_HULL_EXPOSED`, `SET_STAT_MUL`, `MISSILE_IMPULSE`, `WRECK_KICK { entityId, dvx, dvy, dw }` (a capital wreck piece's separating kick after the crack delay: adds velocity and spin via `World.addVelocity`, whatever the mass), `WRECK_IMPULSE { entityId, jx, jy, px, py }` (an overkill hit's impulse on a wreck piece at world point (px, py) via `World.applyImpulseAtPoint`, so an off-centre hit also turns it), `WRECK_RIGID_IMPULSE { entityIds, jx, jy, px, py }` (the same hit during the crack hold, on the whole wreck as one rigid body via `World.applyRigidGroupImpulse`; gone ids skipped), `SPAWN_WALL`, `SET_WALL_ACTIVE`, `REMOVE_WALL`, `SET_PAD_FIELD`, `REMOVE_PAD_FIELD` (v4 T2: a teleporter pad's closing push, `PhysicsWorld.setPadField`, applied before every fixed step from the shared `padPushDir`; the client predWorld runs the same from the room-state phase), `BOT_WARP { slot, x?, y? }` (W2a NPC warp-to: holds a bot's warp target, run through `World.botWarp`, the same `stepWarp` machine as a pilot; while it owns the body the slot's AI intent is dropped), and in pooled mode the dev-only `GC` (collect now, for `/dev/memory?gc=1`; a no-op without `--expose-gc`). (`SPAWN_BASE` / `SET_BASE_DEAD` were removed with the Tier A base geometry in phase E.) `SET_HULL_EXPOSED { id, exposed, kindId, tick }` (shield/hull refactor) swaps a body between its cheap circle collider and its exact hull-polygon compound on the shield 0-cross; `kindId` is carried in the command (server-authoritative — no worker-side kind map). `SET_STAT_MUL { id, topSpeed?, turnRate? }` (Equinox Phase 4 WS-B2) sets a ship instance's per-instance PHYSICS stat multipliers on its worker body so `applyShipInput` scales movement by the upgraded factors; both undefined ⇒ reset. The client predWorld runs the SAME `World.setStatMultipliers` directly, so prediction stays in lockstep (risk #1). `SPAWN_WALL { id, ax, ay, bx, by, thickness }` / `SET_WALL_ACTIVE { id, active }` / `REMOVE_WALL { id }` (shield-fence plan) manage a **shield-wall span** — a STATIC cuboid between two pylon poses that blocks ships; `SET_WALL_ACTIVE` toggles its collider (`setEnabled`) on stun / power loss without churning the body. The wall is NOT a swarm entity (no SAB slot) — it's a derived collider; the same `PhysicsWorld.spawnWall` runs in the client predWorld so local-player blocking is predicted.

## History

- **2026-05-06, held-ack-advance.** The original code left the ack at the last dequeued tick (`// Don't update appliedTicks — ackedTick stays at last-dequeued tick.`). It worked only because the client then sent every tick, so the held branch never fired in practice. Once client-side input throttling landed (network-discipline P4), the stale ack caused double-applied inputs. See [docs/LESSONS.md](../LESSONS.md) (2026-05-06).
- **2026-05-09, tick gate.** Before this the queue drained greedily without the gate, and a client predicting forward (claimedTick > simTick at receive time) saw its inputs applied early: every snapshot reported `ackedTick > serverTick` and drift accumulated at ~10 u per snapshot. See [docs/LESSONS.md](../LESSONS.md) (2026-05-09, "server input queue drained inputs claiming future ticks").
- **2026-11-07, one step per acked tick.** The old `max(claim, prior)` rule applied a late input as a second step while the ack stayed put, so the snapshot pose sat one tick ahead of its `ackedTick`. Every late arrival then showed as a prediction correction of exactly one tick of motion, flipping back later: the showcase "jitter" (0 corrections per take after the fix, 9-61 before).
- **2026-06-07:** `impactSpeed` added to contacts.
- **2026-11-07:** one worker, many worlds (pooled mode).
- **2026-11-13:** `normalSpeed` and the impact-based ramming model (owner decision, "ramming as a weapon") replaced the 2026-06-12 mass-differential model, where equal ships dealt 0 and angle was ignored.
