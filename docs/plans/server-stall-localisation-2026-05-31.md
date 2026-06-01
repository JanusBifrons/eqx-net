# Plan: Localise + fix the 2.2-second server-side dispatch stalls

## Context

User report (2026-05-31, phone smoke after worker=0 + label-removal session):
> "Two massive show-stopping lag spikes. We need to get to the bottom of this.
> It must be in the data!"

The user is right — the data is decisive. Capture `2026-05-31T20-11-13Z-jfd81u` (worker=0, autocapture=1, galaxy-sol-prime, 70 s) shows **two `recv_gap_long` events of 2214 ms and 2210 ms** — gaps in WebSocket snapshot arrival, NOT phone-side render hitches:

```
ts=41205.7  recv_gap_long  via=ws  recvGapMs=2214   heapUsedMb=65   wsBufferedAmountBytes=0
ts=64755.0  recv_gap_long  via=ws  recvGapMs=2210   heapUsedMb=52   wsBufferedAmountBytes=0
```

Both are isolated by 23.5 s of normal play. Both span 2.2 s. The user perceives a 2.2-second freeze (world doesn't update) as a "show-stopping lag spike." This matches their report exactly: **two** spikes, **massive**.

**Critical: this is server-side, not network.** Each `recv_gap_long` event carries `serverSendPerfNow` (the SERVER's `perf.now()` when it dispatched the snapshot). For both events the server-side delta to the previous send equals the client-side recv delta (~2214 ms). The server itself paused dispatch for 2.2 s. The client kept running at 90 Hz throughout (`effectiveHz` in surrounding `heap_sample` events). `wsBufferedAmountBytes=0` rules out send-side WS backpressure.

**Relationship to existing work:** task #24 (committed in 0deed58, "perf(server): pool AI hot-loop allocators") identified server dispatch jitter and pooled per-tick AI literals — that reduced `aiTick`-phase hitches but left chronic 200-500 ms hitches across other phases (snapshotBroadcast, swarmEncode, sabRead, droneMounts). Today's capture shows a different magnitude class: **single events 5-10× larger** than the chronic hitches. The pool fix didn't reach them.

**Workload-scaling clue:** the capture ends with `swarm_decode_slow: { decodeMs: 9.4, swarmCount: 34 }` at ts=67773. The sector has grown from ~16 drones (the count measured in task #24's probe) to 34 drones. Living World Director has migrated bots in. Server-side dispatch cost scales with swarm count: per-recipient `swarmEncode` writes 33 bytes per drone, and AI `aiTick` ticks every drone.

**The two CLUSTERS in this capture, separated by their cause:**

1. **CLUSTER A — session-start Vite chunk eval (ts=7-8 s, ~1.3 s total blocking):** LoAF script attribution = `chunk-D3Q55BJL.js` from `node_modules/.vite/deps/`. 679 ms + 392 ms back-to-back `import.then` resolve. DEV-MODE ARTIFACT (Vite lazy-bundles dependencies on first import). Hidden by the spawn-handshake curtain — user did NOT feel this.

2. **CLUSTER B — two 2.2 s recv_gap_longs (ts=41 s, ts=64 s):** server-side stall. THE FOCUS OF THIS PLAN.

3. **CLUSTER C — five longtasks 50-140 ms (ts=67-69 s):** AFTER `visibilitychange: hidden` at ts=67479. The tab was backgrounded — Chrome RAF throttle bursting accumulated work. User cannot perceive lag in a backgrounded tab. Not a bug.

---

## Diagnosis: what is the server doing for 2.2 s?

We don't know yet. Earlier probe data (`tests/diag/server-dispatch-gap-probe.ts`, ran 20 s combat, ~16 drones) showed max tick_hitch 333 ms. 2.2 s is far beyond that. Either:

- A subsystem we didn't exercise in the 20 s probe runs occasionally and blocks for 2.2 s
- Multiple stacked smaller hitches sum to 2.2 s in a way the prior probe didn't surface
- Workload (34 drones vs 16) crosses a perf cliff in some subsystem

**Hostile-review-hardened candidate list** (each must be either confirmed or ruled out by the probe in Phase 1 below):

| Candidate | Mechanism | Disqualifier signal |
|---|---|---|
| **Living World Director cross-room bot transit** | Director runs every 1.5 s; transit batches up to 4 migrations/tick (`maxMigrationsPerTick` in `LivingWorldDirector.ts`); each migration evicts from source room + spawns at dest. Heavy when many bots converge. | NO 23-s clean periodicity in 1.5-s ticks — but irregular bursts when many bots cluster. |
| **Phase 7 persistence batch flush** | `WorkerBackedSink` coalesces 50 ms CRITICAL batches; main thread POSTs to worker. Posts are async. Worker thread does writes. | Should not block main thread. If main does sync work inside `BATCH` build (currently does — `enqueueCritical` walks the op list synchronously), large batches could block. |
| **Sector snapshot save** | Galaxy sectors save snapshot every 60 s; the 23.5-s spike interval doesn't match 60 s. | Save runs in `index.ts` and routes to dbWorker — shouldn't block main. |
| **Rapier physics worker SAB contention** | Main thread reads SAB at top of `update()`; worker writes mid-tick. Possible memory-fence stall if worker is doing heavy compound-collider step. | Earlier `tickBudget` showed sabRead occasionally taking 100 ms+ — could go higher under heavy swarm. |
| **Snapshot broadcast iteration** | Per-client `SnapshotBroadcaster.broadcast` iterates all alive ships + builds per-recipient state map + writes binary swarm encode + builds projectiles/missiles/drones slice. O(clients × ships × drones). | `swarmEncode` phase already hit 491 ms in the earlier probe. With 34 drones × N recipients × encode overhead, could spike. |
| **Pino logging burst** | `serverLogEvent` writes to a 500-entry ring buffer. If a sub-system spams events, this allocates per-call. Synchronous. | Would correlate with a recent event flood in `/dev/events`. |
| **Node major GC pause** | V8 GC pauses are caught by `GcMonitor` (5 ms threshold). Earlier 20-s probe saw 1 pause of 253 ms. A 2.2-s pause would be exceptional but possible under heap pressure. | If the gap correlates with a `gc_pause` event of similar duration. |
| **Event loop blocked by socket I/O** | Colyseus internally does `client.send()` per recipient per broadcast. The `colyseus` lib calls `ws.send()` which is technically async but with large messages on slow links could block. | Would correlate with `wsBufferedAmountBytes` rising on the client side — but it's 0 in our data. Unlikely. |

**The plan does NOT speculate on which is right — Phase 1 captures the evidence.**

---

## Phase 1 — Replicate with full server-side instrumentation

**Goal:** capture ONE 2.2-s stall event with enough server-side instrumentation to identify the subsystem at fault.

**Why this matters:** the existing probe (`tests/diag/server-dispatch-gap-probe.ts`) ran 20 s with ~16 drones. The user's 2.2-s stalls happened at 41 s and 64 s in a 70-s session with 34+ drones. The probe window was too short and the workload too light. We need a longer probe with a heavier sector and richer server-side capture.

**1.1. Extend the server-dispatch probe.** Modify `tests/diag/server-dispatch-gap-probe.ts`:
- Boot into `galaxy-sol-prime` (matches user smoke environment, includes LW Director)
- Drive 90 s of combat (instead of 20 s) — long enough to catch a 23-s-interval event
- After the drive, fetch `/dev/events?limit=500` AND read the client-side `__eqxLogs.recv_gap_long` events
- Cross-correlate: for each client `recv_gap_long > 1000 ms`, find server events within ±2 s of the corresponding `serverSendPerfNow`
- Report the matched server events with full phase breakdown

**1.2. Add a per-broadcast wall-clock-gap event server-side.** In `SectorRoom.update()`, after `snapshotBroadcaster.broadcast()`, compute `now - lastBroadcastWallClock`. If > 500 ms (3× expected at 20 Hz), emit a NEW `serverLogEvent('broadcast_gap', { gapMs, swarmCount, playerCount, lastPhases })`. This is the SERVER's view of the same event the client sees as `recv_gap_long`. Captures the server-side context AT the dispatch boundary. **Reuse `phasesSnapshot` shape already used by `tick_hitch`** (`src/server/rooms/TickBudgetTelemetry.ts` line 112).

**1.3. Add LWDirector control-loop timing.** In `LivingWorldDirector.tick()`, bracket the body with `performance.now()` and emit `serverLogEvent('director_tick', { ms, decisions: { migrations, respawns } })` when total > 50 ms. Director runs every 1.5 s — if its tick exceeds 50 ms, that's the smoking gun. Lives in `src/server/livingworld/LivingWorldDirector.ts`.

**1.4. Add Persistence worker BATCH-build timing.** In `WorkerBackedSink`'s flush path (`src/server/db/WorkerBackedSink.ts`), measure the synchronous `BATCH` build (the ops array iteration before `worker.postMessage`). If > 50 ms, emit `serverLogEvent('persistence_flush', { ms, opCount })`. Persistence shouldn't block main but if it does, this catches it.

**1.5. Run the probe, capture the artefact.** Boot fresh servers, run the extended probe, save the full output to `diag/measurements/2026-05-31-server-stall-localisation/`. The artefact MUST contain either: (a) a server-side event correlated with one of the client `recv_gap_long > 1000 ms` events, OR (b) a clear "no server events in the 2-s window" finding (which would mean the server is blocked at the JS level without firing any of our instrumentation — pointing at V8 GC or extension code).

**Verification gate:** Phase 1 ships when we have either a localised subsystem OR a verified "no instrumented work fires during the stall" finding. Do not start Phase 2 until Phase 1 lands an answer.

---

## Phase 2 — Fix the identified subsystem

Branches based on Phase 1's finding. Each branch's plan is in a separate sub-section to be filled in once Phase 1 has data. Sketches:

**Branch A (LW Director migrations):** if a migration burst correlates, change `maxMigrationsPerTick` from 4 to 1 OR move the cross-room hop work onto a setImmediate (defer the dest-room `spawnLivingWorldBot` outside the director tick). Files: `src/server/livingworld/LivingWorldDirector.ts`, `src/server/livingworld/BotTransitController.ts`.

**Branch B (snapshot broadcast iteration / swarmEncode):** if broadcast phases hit 1+ s, the per-recipient iteration is the bottleneck. Possible: (i) decimate far-tier broadcasts further at high swarm counts; (ii) move `BinarySwarmBroadcast.encode` into a worker; (iii) defer projectile/missile slice build for out-of-AOI recipients. Files: `src/server/rooms/SnapshotBroadcaster.ts`, `src/server/net/BinarySwarmBroadcast.ts`.

**Branch C (Persistence batch build sync time):** if `persistence_flush` events show > 1 s, the ops array is too large per batch. Cap CRITICAL batch size to 100 ops + flush more often. Files: `src/server/db/WorkerBackedSink.ts`.

**Branch D (Rapier physics worker SAB stall):** if `sabRead` phase shows the stall, the worker's `world.step()` is the source. Mitigations: (i) cap maxSolverIterations under load (currently 16, raised for ramming); (ii) sleep heavy compound colliders out of interest range. Files: `src/core/physics/World.ts`, `src/core/physics/contactDrain.ts`.

**Branch E (V8 major GC pause):** if `gc_pause` events show a 1-s+ pause aligned with the stall, server allocation pressure is the source. Continue the Invariant-#14 audit — likely targets `SnapshotBroadcaster`'s per-recipient `_stateEntryPool` retention or per-broadcast literal allocations. Files: `src/server/rooms/SnapshotBroadcaster.ts`.

---

## Phase 3 — Phone smoke verification

After Phase 2 lands, repeat the user's exact smoke setup:
- Servers: `pnpm dev:server` + `pnpm dev:client` (matches user's env)
- URL: `http://192.168.1.96:5173/?room=galaxy-sol-prime&worker=0&autocapture=1`
- Window: ~70 s of combat (matching the original report)
- Goal: zero `recv_gap_long > 1000 ms` events

If a 2.2-s stall still appears, the fix was wrong; loop back to Phase 1 with the new capture.

---

## Critical files to inspect / modify

| File | Why |
|---|---|
| `tests/diag/server-dispatch-gap-probe.ts` | Extend window + cross-correlate (Phase 1) |
| `src/server/rooms/SectorRoom.ts` | Add `broadcast_gap` event in `update()` (Phase 1) |
| `src/server/rooms/SnapshotBroadcaster.ts` | Phase-time inspection + likely fix site (Phase 2 Branch B) |
| `src/server/rooms/TickBudgetTelemetry.ts` | Existing `tick_hitch` pattern — reuse for phase capture |
| `src/server/livingworld/LivingWorldDirector.ts` | Add `director_tick` timing (Phase 1.3); likely fix site (Phase 2 Branch A) |
| `src/server/livingworld/BotTransitController.ts` | Cross-room hop (Phase 2 Branch A) |
| `src/server/db/WorkerBackedSink.ts` | Add `persistence_flush` timing (Phase 1.4); likely fix site (Phase 2 Branch C) |
| `src/server/debug/GcMonitor.ts` | Threshold for GC pause correlation — already 5 ms (low enough) |

## Hostile-review checks (defended)

| Challenge | Defence |
|---|---|
| "Could be a phone-side WS issue — Chrome / WiFi / firewall." | `serverSendPerfNow` deltas (server-side clock) and `clientRecvPerfNow` deltas are equal. Server-side clock advanced 2.2 s between consecutive snapshot dispatches. Network can't fake server-side wall-clock. |
| "Could be the snapshot coalescer holding back snapshots." | `recv_gap_long` measures wire-arrival time (the `room.onMessage('snapshot')` callback time), set inside `logSnapshotRecvTelemetry` BEFORE coalescing. Coalescer affects apply timing, not recv timing. See `src/client/CLAUDE.md` § "Snapshot transport — DataChannel + WebSocket coalescing", rule 3 ("`intervalMs` MUST be wire-arrival time"). |
| "Could be the Vite dev-mode dynamic-import (Cluster A) the user actually felt." | Cluster A is at ts=7-8 s, hidden by spawn-handshake curtain (`load_curtain_change: active=true` at ts=6592, drops at ~ts=8.2 s when `arrival_acked` fires). User reports the spikes after combat had started — they felt the 2.2-s events at ts=41 and ts=64. |
| "Could be the background-tab burst (Cluster C)." | Cluster C is AFTER `visibilitychange: hidden` at ts=67479 — page is backgrounded, user cannot perceive lag. Discounted. |
| "Earlier probe showed max 333 ms tick_hitches — could the 2.2 s just be a phone-side artefact?" | 333 ms was the worst seen in 20 s × 16 drones. Today's session: 70 s × 34 drones (a `swarm_decode_slow` at ts=67773 confirms 34). Different workload; the earlier probe didn't exercise it. Phase 1 must extend the probe to match. |
| "Could be a single huge V8 GC, not a server stall." | `GcMonitor` only fires for `gc` PerformanceObserver entries, which run during the V8 STW pause. Phase 1 will surface this directly. If the gap correlates with a 2-s `gc_pause` event, that's our answer. |
| "Why TWO 2.2-s gaps not one? Random?" | Two events of EXACTLY 2.2 s separated by 23.5 s suggests a periodic but not 60-s-aligned mechanism. Whatever fires it, fires consistently. Phase 1 must catch a third occurrence to confirm pattern + identify the source. |
| "How do you know this isn't a smoke-environment artefact (dev server, sole client, etc.)?" | The user's phone smoke is the production-equivalent path for testing this game. The dev server IS what production uses for the smoke loop. A 2.2-s stall in dev = will appear in production. |
| "Plan assumes the fix is one of branches A-E. What if it's E2 (something we haven't listed)?" | The 'no instrumented work fires' verification gate (1.5) catches this — if Phase 1 instrumentation sees no server events during a stall, the stall is OUTSIDE our instrumented paths. Plan then expands instrumentation. |
| "What if the user's two spikes were actually the Vite chunk eval (Cluster A) split visually?" | Cluster A's two LoAFs (679 + 392 ms) are back-to-back during the loading curtain. The user said "two massive lag spikes" — Cluster B's two 2.2-s gaps are the natural match (also two, also massive). Confirming the user's specific perception is part of Phase 3 verification (ask them when they felt the spikes). |
| "Why is the diag system not already capturing the server-side context?" | `tick_hitch` only emits when `update()` total > 12 ms, rate-limited 1/250 ms. If a 2.2-s stall fires ONE big tick_hitch, it should appear in `/dev/events`. Phase 1 fetches `/dev/events` to test this hypothesis — if no `tick_hitch` is present in the gap window, the stall is somewhere OUTSIDE `update()`. That's a critical signal. |

## What this plan deliberately does NOT do

- It does NOT touch the Cluster-A Vite dev-mode artefact. That's a separate symptom (only visible during loading, not during combat); a fix is "force pre-bundling via `optimizeDeps.include`" but not blocking the user's reported issue.
- It does NOT speculate the fix without Phase 1 data. Branches A-E are sketches; only the one Phase 1 implicates gets implemented.
- It does NOT add new client-side instrumentation. The capture data we already have is decisive on the WHERE (server) and WHEN (mid-combat, 2.2 s, scales with swarm count); we need server-side WHO.

## Verification (end-to-end)

1. **Phase 1 probe passes** = produces an artefact at `diag/measurements/2026-05-31-server-stall-localisation/` containing AT LEAST ONE event of the form `{ recv_gap_long > 1000 ms, correlated server events within ±2 s }`. Inner-loop green: `pnpm typecheck && pnpm lint`. Run: `pnpm tsx tests/diag/server-dispatch-gap-probe.ts`.
2. **Phase 2 fix passes** = the unit/integration test covering the identified subsystem stays green, AND a re-run of the Phase 1 probe shows ZERO server-side gaps > 1000 ms in 90 s of combat at 34-drone workload.
3. **Phase 3 smoke passes** = user runs the smoke URL again, plays for ≥ 60 s of combat, AND the resulting capture has ZERO `recv_gap_long > 1000 ms` events. Visible "world freeze" symptom is gone.
