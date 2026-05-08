# Snapshot Cadence and Priority

Stage 5 of the network-feel roadmap (`plans/network-feel-roadmap.md`).

> **Status: post-hotfix #4** — the initial Stage 5 design (30 Hz close-tier + 20 Hz far-tier) caused recipient-side cadence breakage and was rolled back to a single 20 Hz cadence. See "Hotfix #4 history" at the bottom of this doc for what was tried and why it failed. The text below describes the **current** post-hotfix design.

## What changed

Pre-Stage-5, every Colyseus client received an identical, full-fleet snapshot every 3 server ticks (20 Hz) — the classic broadcast cadence shipped in Phase 3. That worked, but it bundled four unrelated concerns into one decision:

- **All-clients-same-tick**: every client peaked on the same tick. With N clients, the server did N serializations on tick `T = 3k` and zero on `T = 3k+1, 3k+2`. CPU spikes proportional to client count.
- **Same rate close vs. far**: a ship one screen away got the same 20 Hz update as a ship four screens away — even though the distant ship doesn't move enough on screen to justify the bytes.
- **No idle suppression**: an empty (or motionless) sector still paid the full per-tick snapshot cost.
- **Always-include `lastInput`**: even when the bits hadn't changed for seconds, every snapshot carried a fresh 5-bit `lastInput` per ship.

Stage 5 unbundles these four decisions and lets the server make them per-(recipient, ship) per tick.

## Architecture

Two layers:

### 1. Pure scheduler module — `src/server/net/snapshotScheduler.ts`

Stateless / pure-state primitives that the SectorRoom calls into. No Colyseus, no DOM, no Node-only APIs. Each function tests directly without a harness:

| Function | Returns | Test cases |
|---|---|---|
| `computePhaseOffset(playerId, modulus)` | 0..modulus-1 (FNV-1a) | determinism, distribution, range |
| `shouldBroadcastClose(tick, playerId)` | bool — fires every 2 ticks | exact-cadence, 30 Hz over 60-tick window |
| `shouldBroadcastFar(tick, playerId)` | bool — fires every 3 ticks | exact-cadence, 20 Hz, no-collisions-in-LCM-window |
| `classifyShipTier(state, ...)` | `'close'` \| `'far'` | radius test, hysteresis band, recipient-isolated |
| `noteSectorEvent(tracker, tick)` / `isSectorIdle(...)` | bool | warmup, threshold edges, re-arm |
| `shouldIncludeLastInput(cache, shipId, current)` | bool | first-time, repeat-omit, change-re-include |

27 unit tests, ~30 ms total — runs in the inner loop on every save.

### 2. Glue in `SectorRoom.update()`

The pre-Stage-5 broadcast block (`if (++broadcastCounter >= 3 && serverTick > 0) { ... }`) was replaced with a per-client decision:

```text
1. Update sector idle tracker from motion / projectiles in flight.
2. If sector is idle: skip the entire broadcast block (no states built, no per-client serialization).
3. Otherwise:
   a. Build "all alive ships" digest once per tick.
   b. For each client:
      - shouldBroadcastFar(broadcastCounter, recipientPlayerId)? If not, skip this client this tick.
      - Build per-recipient states map: every alive ship is included.
      - For each included ship: omit lastInput if the bits match this recipient's cache.
      - Per-recipient projectile filter (3×3 cell window, unchanged).
      - Send.
4. Sample the snapshot_broadcast log at every 3rd tick to preserve pre-Stage-5 log volume.
```

## Why broadcastCounter, not serverTick

The scheduling decision uses `broadcastCounter` (incremented once per `update()` call), **not** `serverTick` (read from SAB). Pre-Phase-3 used `SAB tick % 3 === 0` for the cadence and saw ~25% missed broadcasts because the worker (which writes `serverTick`) and the main thread (which reads it via `update()`) are independent 60 Hz loops that drift slightly out of phase. Some `update()` calls would see `serverTick` advance by 1, others by 2 or 3 — making `% 3` unreliable.

`broadcastCounter` is purely main-thread and increments exactly once per `update()`. `(broadcastCounter + offset) % 2` and `% 3` are reliable.

The actual `snap.serverTick` field still carries the SAB tick value — clients align reconciliation against the authoritative simulation tick, which is independent of the scheduling cadence.

## Wire impact

For a sector with 4 clients and 8 ships, after hotfix #4:

| | pre-Stage-5 | Stage 5 (post-hotfix #4) |
|---|---|---|
| client snapshots/sec | 4 × 20 = 80 | 4 × 20 = 80 (unchanged) |
| ship-state records/sec | 4 × 20 × 8 = 640 | 4 × 20 × 8 = 640 (unchanged) |
| `lastInput` bits/sec/ship | 5 × 20 = 100 | 0..100, depends on input change rate (savings) |
| CPU peak per tick | all 4 clients on same tick | spread across 3-tick cycle (per-client phase offset) |
| empty sector | full per-tick cost | suppressed after 60 ticks idle |

Net bandwidth roughly equal to pre-Stage-5 (idle suppression and lastInput omission save bytes; no rate change). Net CPU smoother — phase staggering spreads serialisation across the 3-tick window instead of bunching it.

## Tier classification (currently unused in production)

The `classifyShipTier` / `createTierState` helpers in `snapshotScheduler.ts` exist with full hysteresis logic and unit-test coverage but are **not called from the SectorRoom hot path** after hotfix #4. They're preserved for a future Stage 5b that may revive a single-cadence-with-selective-inclusion design (e.g. 30 Hz global with far ships dropped from every other snapshot). When that lands, the recipient-side `cadence-fairness.spec.ts` E2E must land in the same PR.

## What's intentionally NOT here

- **Compression**: per-snapshot wire encoding stays JSON. Stage 7 swaps to delta-encoded int16 quantization.
- **Per-tier projectile filtering**: projectiles still ship in the per-recipient 3×3 cell window regardless of close/far tier. Projectiles move fast enough that the 30 Hz / 20 Hz distinction would create visible artifacts.
- **Per-tier swarm rate**: binary-swarm channel keeps its existing 60 Hz cadence with the SwarmEncoder's keyframe-vs-delta logic. Stage 5 only changes the JSON ship-state snapshot.

## Telemetry

Server logs `snapshot_broadcast` once per ~20 Hz tick (gated to `broadcastCounter % 3 === 0` to preserve pre-Stage-5 log volume). Client dev overlay's `snapshotIntervalMs` is now per-recipient, not per-broadcast — close-tier clients see ~33 ms intervals, far-tier clients still see ~50 ms.

## Verifying it's working

1. **Phase staggering**: hash a few player ids manually with `computePhaseOffset(id, 3)` and confirm distinct values across a small player population.
2. **Recipient cadence**: in a captured diagnostic during steady-state play, `snapshotIntervalMs` should sit at ~50 ms median with low jitter (< 10 ms). If you see jitter > 30 ms or median pulled below 35 ms, suspect a regression of the hotfix #4 cadence-union bug.
3. **Idle suppression**: park a ship with no input for ≥ 1 second in an empty sector. The server's `snapshot_broadcast` log entries should stop. First key press resumes them within one tick.
4. **`lastInput` omission**: capture two consecutive snapshots while a ship is idle. The first contains `lastInput: { thrust: false, ... }`; the second omits the field entirely.

---

## Hotfix #4 history (2026-05-08)

The first Stage 5 implementation gated sends on `closeFires || farFires` where `closeFires = (broadcastCounter + closeOffset) % 2 === 0` and `farFires = (broadcastCounter + farOffset) % 3 === 0`. Each predicate alone produced a clean cadence; the union did **not**.

Over a 6-tick LCM window, the union firing pattern is `{0, 2, 3, 4, 6, 8, 9, 10, ...}` with intervals `2, 1, 1, 2, 2, 1, 1, 2` ticks = 33, 17, 17, 33, 33, 17, 17, 33 ms. The recipient sees bursts of two snapshots 33 ms apart, then back-to-back 17 ms intervals, then 33 ms gaps. Median = 21 ms; jitter = 40 ms.

This broke the reconciler's lerp (built around a steady ~50 ms cadence). Diagnostic `2026-05-08T19-30-14-034Z-zw6exn.json` captured a correction landing 17 u past the server pose in the wrong direction — the lerp blended across two too-close-together snapshots and overshot.

**Why unit tests didn't catch it**: 27 tests in `snapshotScheduler.test.ts` covered each predicate in isolation. The bug lived in the **union** at the recipient — which no unit test asserted. The plan called for `cadence-fairness.spec.ts` measuring recipient-side `intervalMs` distribution; I deferred it on the (false) belief that "the math is unit-tested". The math was. The wire wasn't.

**Lesson**: any future "two cadences for different priorities" design MUST land with the recipient-side cadence E2E test. Unit tests on individual predicates are insufficient.

See `docs/LESSONS.md` 2026-05-08 entry for the full mechanism.
