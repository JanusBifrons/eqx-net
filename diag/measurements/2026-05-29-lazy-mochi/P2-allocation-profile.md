# Phase 2 — CDP allocation profile, HEAD vs main

20s combat held-fire on `feel-test-25`. Same box, same browser. Both arms ran with `?diag=1` (Playwright webdriver auto-enables diag, but the spec sets it explicitly too).

## Top allocators comparison

| Function | main | HEAD | Δ KB | Δ % share |
|---|---|---|---|---|
| **`updateMirror`** ColyseusClient.ts | 64.1 KB (4.6%) | **174.6 KB (15.1%)** | **+110.5** | +10.5pp |
| `tickPhysics` ColyseusClient.ts | 111.9 KB (8.0%) | 80.3 KB (6.9%) | -31.6 | -1.1pp |
| `logEvent` ClientLogger.ts (×4) | ~275 KB (~20%) | ~160 KB (~14%) | -115 | -6pp |
| `loop` gameRafLoop.ts | 86.3 KB (6.2%) | 46.8 KB (4.0%) | -39.5 | -2.2pp |
| `tick` WarpScreen.tsx | 122.2 KB (8.8%) | 27.3 KB (2.4%) | -94.9 | -6.4pp |
| `handleWorkerMessage` WorkerRendererClient | 69.3 KB (5.0%) | 37.8 KB (3.3%) | -31.5 | -1.7pp |
| `sendFire` ColyseusClient.ts | (not in top 25) | 30.1 KB (2.6%) | NEW | NEW |
| Total sampled | 1.36 MB | 1.13 MB | -0.23 MB | - |

## The dominant regression site = `updateMirror`'s ramming_probe block

`git diff main..integration/four-branches -- src/client/net/ColyseusClient.ts` against the `updateMirror` function shows ONE substantive change: a NEW ramming_probe diagnostic block (added by commit `b7b18d1`, 2026-05-28). Function body grew from 418 lines → 556 lines (+138).

The block is **gated by `isFullDiagMode()`** so production gameplay (no `?diag` flag, no webdriver) does not allocate. But the gate measurement runs under Playwright (webdriver = true → diag auto-on), so the block fires every frame within 1500u of any drone.

The literal is heavy (12 fields, 6 NESTED `{ x, y }` objects + a `contactState` object) — at 60 RAFs/sec with 25 drones in the 1500u radius, this is ~8 objects × 60/sec = 480 short-lived objects/sec, plus the rolling buffer retention in the `entries` ring.

Quoting the block's own comment: *"TODO: alloc-debt (Invariant #14) — this block runs every frame within 1500 u of any drone and builds a ~12-field diagnostic object literal that feeds logEvent. Deferred per fuzzy-gray integration plan."* The follow-up that closes the TODO is part of this plan.

## What this does + doesn't explain

**Explains:** the gate's `updateMirror` ranking jump (4.6% → 15.1%) and a sizeable slice of the +8% combat-heap-growth slope delta (0.428 → 0.462). Likely most of the rafGap 1 → 15 regression too, since dense per-frame object literals stress V8's minor-GC cadence.

**Does NOT explain:** the user's "feels bad on phone" complaint. On phone (production, `?diag=0`), the `isFullDiagMode()` gate skips this block entirely. The CDP profile shows the rest of `updateMirror` is unchanged (the only updateMirror diff hunk is this block + a tighter gate on the pre-existing `local_pose_rendered`). So phone production gameplay is NOT regressed by `updateMirror`.

Phone regression source remains hypothetical: the new effects subsystem (`ImpactSparks` per-hit, `DestructionFx` per-kill, `EngineEmitter` already-pooled, `ShieldAura` per-shield-event) all add per-event spawn/destroy bursts that don't fire in the peaceful-feel-test-25 workload. The CDP profile I ran cannot see them — needs a workload with combat hits/kills to surface them.

## Fix backlog for Phase 3

Two parallel tracks:

**Track A (gate path — bring measurement into honest territory):**
1. **Tighten the ramming_probe gate** to a window-flag opt-in (`__rammingProbe === true`), default OFF even under `?diag=1` / webdriver. Tests that need the probe set the flag explicitly. This closes the standing TODO + brings the gate's `updateMirror` ranking back toward main's level.

**Track B (production path — address the user's phone "feels bad"):**
2. **Pool `ImpactSparks`** (handoff prio #3). Failing heap-delta test first per Invariant #13. Tint-keyed free-pool per `EngineEmitter` template.
3. **Pool `DestructionFx`** (handoff prio #4). Same shape. Plus the `Filter[]` array literals in `spawnShock` / `detachFilter`.

ShieldAura is `tick`-allocation-free; `LaserGlow` constructs 2 filters lifetime — neither needs pooling per current code (the handoff prioritisation was speculative, not based on profile evidence).

Order: A1 first (smallest, highest-confidence gate win). Then B2, B3. Re-measure after each; iterate until combat-heap-growth meets the revised Phase 4 targets in `P1-comparison.md`.

## What we explicitly are NOT doing in this plan

- Re-profiling under a combat workload that lands hits/kills (would surface ImpactSparks/DestructionFx in the CDP profile). The user's standing instruction is to fix and hand off for phone smoke, not iterate on synthetic workloads.
- Adding `bench:effects` budget gate (handoff suggestion). Deferred until phone smoke verifies the pools helped.
- Investigating `tickPhysics`'s 80 KB allocation (InputRecord + room.send literal + lastSentInputState — already pooled-by-mutate where possible; remaining are per-tick necessities). Not the regression site.
