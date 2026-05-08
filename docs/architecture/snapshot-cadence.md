# Snapshot Cadence and Priority

Stage 5 of the network-feel roadmap (`plans/network-feel-roadmap.md`).

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
      - Decide closeFires / farFires from broadcastCounter + per-client phase offset.
      - If neither: skip this client this tick.
      - For each ship: classify tier (with hysteresis); include if (close && (closeFires||farFires)) || (far && farFires).
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

For a sector with 4 clients and 8 ships:

| | pre-Stage-5 | Stage 5 (typical) |
|---|---|---|
| client snapshots/sec | 4 × 20 = 80 | 4 × ~40 = 160 (peak; fewer for far ships) |
| ship-state records/sec sent | 4 × 20 × 8 = 640 | varies — close ships at 30 Hz, far at 20 Hz |
| `lastInput` bits/sec/ship | 5 × 20 = 100 | 0..100, depends on input change rate |
| CPU peak per tick | all 4 clients on same tick | spread across LCM-of-2-and-3 = 6-tick cycle |
| empty sector | full per-tick cost | suppressed after 60 ticks idle |

Total network rate is up (clients receive more frequent updates for nearby ships) but each individual snapshot is smaller (per-recipient ship filtering + lastInput omission) and the CPU cost is smoothed across ticks. Stage 7 (wire-format efficiency) makes each snapshot ~50% cheaper, so net bandwidth stays under the bench targets.

## Hysteresis

A ship hovering at exactly `CLOSE_TIER_RADIUS` (= one cell, 2048 u) due to drift jitter would otherwise flip tier every tick — alternating between 30 Hz and 20 Hz cadence, visible to the player as periodic stutter on that ship.

The hysteresis band `[CLOSE_TIER_RADIUS - 512, CLOSE_TIER_RADIUS + 512]` (quarter-cell margin) pins the previous classification while in-band. Outside the band, the tier is recomputed unconditionally.

First-time classification (no prior membership entry) uses the strict `distance < CLOSE_TIER_RADIUS` test — no hysteresis applied.

## What's intentionally NOT here

- **Compression**: per-snapshot wire encoding stays JSON. Stage 7 swaps to delta-encoded int16 quantization.
- **Per-tier projectile filtering**: projectiles still ship in the per-recipient 3×3 cell window regardless of close/far tier. Projectiles move fast enough that the 30 Hz / 20 Hz distinction would create visible artifacts.
- **Per-tier swarm rate**: binary-swarm channel keeps its existing 60 Hz cadence with the SwarmEncoder's keyframe-vs-delta logic. Stage 5 only changes the JSON ship-state snapshot.

## Telemetry

Server logs `snapshot_broadcast` once per ~20 Hz tick (gated to `broadcastCounter % 3 === 0` to preserve pre-Stage-5 log volume). Client dev overlay's `snapshotIntervalMs` is now per-recipient, not per-broadcast — close-tier clients see ~33 ms intervals, far-tier clients still see ~50 ms.

## Verifying it's working

1. **Phase staggering**: hash a few player ids manually with `computePhaseOffset(id, 3)` and confirm distinct values across a small player population.
2. **Tier rate**: count `snapshotIn` entries in a captured diagnostic during steady-state play. Close ships should appear in ~30 Hz of snapshots; far ships in ~20 Hz. The `intervalMs` distribution will show two distinct modes (33 ms and 50 ms).
3. **Idle suppression**: park a ship with no input for ≥ 1 second in an empty sector. The server's `snapshot_broadcast` log entries should stop. First key press resumes them within one tick.
4. **`lastInput` omission**: capture two consecutive snapshots while a ship is idle. The first contains `lastInput: { thrust: false, ... }`; the second omits the field entirely.
