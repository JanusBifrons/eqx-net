# Handoff — Server-side 2.2-s dispatch stalls localised, plan written, no impl yet (2026-05-31 EOD)

## TL;DR

Session ended on `feat/pixi-heap-bisect` with a **hostile-reviewed, user-approved** plan to localise + fix the 2.2-s server-side snapshot-dispatch stalls the user reported in their final phone smoke. Plan file lives at [`docs/plans/server-stall-localisation-2026-05-31.md`](plans/server-stall-localisation-2026-05-31.md). **No implementation code yet** — picks up next session with Phase 1 (extend the probe + add three server-side timing events).

The user's perception ("two massive show-stopping lag spikes") matches exactly TWO `recv_gap_long` events of ~2214 ms in capture `2026-05-31T20-11-13Z-jfd81u`. Both are SERVER-SIDE (the server's `perf.now()` advanced 2.2 s between consecutive snapshot dispatches — see plan §Context for the disqualifier math).

## What this session produced — code committed

Branch: `feat/pixi-heap-bisect` (UNPUSHED). 7 commits today on top of the morning's work:

| Commit | Change | Status |
|---|---|---|
| `7ad60fd` | `fix(server)`: rebind path joins the crispy-kazoo handshake | Closes pinning-after-respawn (Task #22) |
| `0deed58` | `perf(server)`: pool AI hot-loop allocators (Invariant #14) | Closes ~1800 allocs/sec in AI tick; partial recv_gap_long fix |
| `2cef7fb` | `test(server)`: respawn-input pipeline cleanliness lock | Server-side regression lock — both cases pass on current code (proves bug was client-side cascade) |
| `1540dcb` | `fix(render)`: Text destroys pass `{texture:true, textureSource:true}` | Pixi v8 hygiene |
| `4d3d8f1` | `perf(render)`: pool BackgroundGrid label Texts | 39% heap-leak reduction |
| `97037f7` | `feat(render)`: remove BackgroundGrid coord labels (user direction) | Net heap delta 3 MB → 1.4-2 MB per 60s combat |
| `7fda8d8` | `perf(render)`: pool HealthBars Graphics | Preventive — scales with combat intensity |
| `56cce3c` | `test(perf)`: worker-vs-main-thread renderer A/B spec | Desktop + mobile-emu data — worker wins on desktop, main-thread default still right for touch |

Two E2E specs added for regression locks:
- [`tests/integration/sectorRoom/respawnInputApplies.test.ts`](../tests/integration/sectorRoom/respawnInputApplies.test.ts)
- [`tests/e2e/respawn-cascade-input-routing.spec.ts`](../tests/e2e/respawn-cascade-input-routing.spec.ts)

Three diag probes added:
- [`tests/diag/server-dispatch-gap-probe.ts`](../tests/diag/server-dispatch-gap-probe.ts) — drives 20 s combat + fetches `/dev/events`
- [`tests/diag/active-combat-heap-diff.ts`](../tests/diag/active-combat-heap-diff.ts) — 60 s survived combat heap-snapshot diff
- [`tests/diag/idle-vs-combat-heap-diff.ts`](../tests/diag/idle-vs-combat-heap-diff.ts) — isolates combat-only allocators from idle baseline

## What this session produced — diagnosis (data-driven)

User's final smoke capture `diag/captures/2026-05-31T20-11-13Z-jfd81u/` (worker=0, autocapture=1, galaxy-sol-prime, 70 s) decisively localises the symptom:

### THREE clusters in the capture (read carefully — they are NOT all the same thing)

| Cluster | Window | Symptom | Cause | User-felt? |
|---|---|---|---|---|
| **A** — Vite chunk eval | ts=7-8 s | 679 ms + 392 ms back-to-back `import.then` LoAFs on `chunk-D3Q55BJL.js` | DEV-MODE Vite lazy-bundles deps on first import | NO — hidden by spawn-handshake curtain |
| **B** — **THE 2.2-s SPIKES** | ts=41 s + ts=64 s | Two `recv_gap_long` events of ~2214 ms; server `perf.now()` advanced 2.2 s between consecutive snapshot dispatches | **UNKNOWN — what the plan investigates** | **YES — these are the "show-stopping" spikes** |
| **C** — background-tab burst | ts=67-69 s (after `visibilitychange: hidden` at ts=67479) | 5 longtasks 50-140 ms | Chrome RAF throttle on backgrounded tab releasing accumulated work | NO — page is hidden |

### Why we know Cluster B is server-side (not network)

Each `recv_gap_long` event carries:
- `serverSendPerfNow` — server's `perf.now()` when it dispatched the snapshot
- `clientRecvPerfNow` — client's `perf.now()` when it received

For both 2.2-s events, the SERVER-SIDE delta between consecutive sends is ≈ the CLIENT-SIDE delta between consecutive receives. The server itself paused dispatch for 2.2 s. The client was running at 90 Hz (`effectiveHz` from surrounding `heap_sample`). `wsBufferedAmountBytes=0` rules out send-side WS backpressure. **Network can't fake server-side wall-clock.**

### Workload-scaling clue

`swarm_decode_slow: { decodeMs: 9.4, swarmCount: 34 }` at ts=67773. The sector has 34 drones — up from ~16 in our earlier session probe. Living World Director migrated bots in. Server dispatch cost scales with swarm count (per-recipient `swarmEncode` + per-drone `aiTick`). The earlier 20-s probe didn't exercise this workload.

### Relationship to earlier work

Task #24 was open. The 0deed58 commit pooled AI allocs and reduced `aiTick` hitches. The 2.2-s events are 5-10× larger than the chronic 200-500 ms `tick_hitch` events seen earlier — different magnitude class. The pool fix didn't reach them.

## The plan — what next session does

Three phases ([full plan](plans/server-stall-localisation-2026-05-31.md)):

**Phase 1 (REQUIRED before any fix):** capture ONE 2.2-s stall event WITH server-side context.
- 1.1 Extend `tests/diag/server-dispatch-gap-probe.ts` to 90 s in `galaxy-sol-prime` (matches user smoke env)
- 1.2 Add `broadcast_gap` server event in `SectorRoom.update()` — emits when wall-clock-since-last-broadcast > 500 ms
- 1.3 Add `director_tick` server event in `LivingWorldDirector.tick()` — emits when tick > 50 ms
- 1.4 Add `persistence_flush` server event in `WorkerBackedSink` — emits when BATCH-build > 50 ms
- 1.5 Run probe + cross-correlate client `recv_gap_long > 1000 ms` with server events within ±2 s of `serverSendPerfNow`

**Phase 1 verification gate:** either (a) a server subsystem is localised by correlation, OR (b) NO server event fires during the stall window (which would tell us it's OUTSIDE `update()` — V8 GC or extension code).

**Phase 2 (only after Phase 1 lands data):** fix the identified subsystem. Five sketched branches (A=LW Director migrations, B=snapshot broadcast, C=persistence batch, D=Rapier SAB, E=V8 GC). Plan deliberately does NOT speculate further until Phase 1 evidence picks the branch.

**Phase 3:** phone smoke verification — user runs the same URL, gets ZERO `recv_gap_long > 1000 ms` events in 60 s+ of combat.

## What the plan deliberately does NOT do

- It does NOT touch Cluster A (Vite dev-mode artefact). Real fix is `optimizeDeps.include` in `vite.config.ts` — but Cluster A is hidden by the loading curtain, not user-felt during combat.
- It does NOT speculate which of Branches A-E is right. Phase 1 picks one.
- It does NOT add new client-side instrumentation. The capture data is decisive on WHERE (server) and WHEN (mid-combat, scales with swarm). We need server-side WHO.

## Picking up next session

1. Read [`docs/plans/server-stall-localisation-2026-05-31.md`](plans/server-stall-localisation-2026-05-31.md) (the full plan with hostile-review defences).
2. Verify branch state: `git status` → should show `feat/pixi-heap-bisect`. Working tree has ONE uncommitted change: `tests/diag/server-dispatch-gap-probe.ts` carries an in-progress addition to extract `gc_pause` events alongside `tick_hitch` / `tick_budget` (made during today's diagnosis but not yet committed — it's part of the Phase 1.1 work). Either keep + extend, or `git stash` before starting fresh.
3. Confirm captures still in place: `ls diag/captures/2026-05-31T20-11-13Z-jfd81u/` — the load-bearing capture for Phase 1 cross-correlation.
4. Start Phase 1.1 — extend the dispatch probe to 90 s + galaxy-sol-prime + cross-correlation.

## Risk register

| Risk | Mitigation |
|---|---|
| User runs another smoke before Phase 1 lands; we lose the chance to instrument | Phase 1.5's verification gate accepts EITHER a localised subsystem OR a "no server events in the stall window" finding. The latter is itself a strong signal. |
| Phase 1 probe doesn't repro the stall (35-drone workload not hit in 90 s) | The plan explicitly says "if a 2.2-s stall still appears [in Phase 3], the fix was wrong; loop back to Phase 1 with the new capture." Same loop applies if Phase 1 itself can't repro — extend the probe further. |
| User wants to keep iterating on other heap-leak work mid-Phase-1 | Plan explicitly does NOT block on that — those are separate symptoms. The 2.2-s stalls are the priority because they're the only ones the user perceived as "show-stopping". |
| LWDirector / persistence is the wrong branch — fix removes a feature | Each branch sketch is a tuning change (caps, batching, deferrals), not a feature removal. Phase 2 has unit-test green-bar before merge. |

## Related context

- Earlier `tests/diag/server-dispatch-gap-probe.ts` output (20 s, 16 drones): max tick_hitch ~333 ms with `aiTick`/`sabRead`/`droneMounts`/`swarmEncode` as the dominant phases. GcMonitor caught 1 pause of 253 ms.
- The combat-fx-hunt work today (commits `1540dcb` through `7fda8d8`) cut JS-heap pressure on CLIENT side: 3 MB → 1.4-2 MB / 60 s. That addresses a different symptom class (client-side stutters from major GC). Independent of the server-side 2.2-s stalls.
- Branch ancestor: `feat/pixi-heap-bisect` based on `main`, includes crispy-kazoo handshake work shipped earlier today and the imperative-taco / lazy-mochi / swift-otter work already in `main`.

## Files referenced

- Plan: [`docs/plans/server-stall-localisation-2026-05-31.md`](plans/server-stall-localisation-2026-05-31.md)
- Capture (load-bearing): `diag/captures/2026-05-31T20-11-13Z-jfd81u/`
- Existing probe (to extend): `tests/diag/server-dispatch-gap-probe.ts`
- Server event log (existing pattern): `src/server/debug/ServerEventLog.ts`
- Tick-budget telemetry (existing pattern to reuse): `src/server/rooms/TickBudgetTelemetry.ts`
