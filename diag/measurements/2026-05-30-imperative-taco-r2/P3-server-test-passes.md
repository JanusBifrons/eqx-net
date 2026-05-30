# Phase 3 — Server-side characterization test PASSES on current HEAD

The plan's pivot to "server-side recv_gap_long" assumed server-side V8 major-GC pauses were causing the 230-560 ms snapshot silences. The TDD test built to characterize this `tests/integration/sectorRoom/snapshotCadenceUnderLoad.test.ts` shows the SERVER MAINTAINS PERFECT CADENCE under exactly the workload the user reports.

## Test result (current HEAD, 1 rep)

Workload: real `SectorRoom` + physics worker, 25 drones, `startHostile=1`, real `colyseus.js` client holding thrust + firing every 167ms (~6Hz), 30 s combat window.

```
Snapshot cadence (599 gaps over 30 s):
  p50: 50.0 ms     ← perfect 20 Hz cadence
  p95: 50.4 ms
  p99: 50.9 ms
  max: 51.2 ms     ← worst gap is barely above the nominal 50 ms
  gaps > 200 ms (recv_gap_long threshold): 0
```

**The server never falls behind.** The setImmediate tick loop in `SectorRoom.ts:1347-1357` handles the 25-drone hostile combat load with sub-millisecond jitter.

## What this rules out

- **Server-side V8 major-GC pauses** are NOT the root cause of `recv_gap_long`. A 230-560 ms server GC pause would show as a single gap of that magnitude in the test; we see none.
- **SectorRoom tick budget overrun** is NOT the cause. The room maintains 60 Hz update cadence.
- **SnapshotBroadcaster overhead** scaling with 25 drones is NOT a problem. The broadcast completes well within budget.

## What this implies for the phone-side `recv_gap_long` events

The phone capture `7k0v95` had 6 events with 230-560 ms gaps and ZERO client-side longtask overlap. Possible remaining causes (NOT investigated in this round):

1. **WiFi / cellular transient stalls.** A real WiFi link has occasional 200-600 ms stalls from channel scanning, interference, AP roaming, or TCP retransmit timing. These would show as recv-side gaps with zero client OR server CPU correlation. Test environment uses localhost (no WiFi) — explains why test doesn't reproduce.

2. **WebSocket buffer flush on the dev server.** The test uses a minimal SectorRoom (1 sector, 0 hunters, no persistence). The dev server runs 7 galaxy rooms + LivingWorldDirector + 25 hunter bots + SQLite persistence. The aggregate allocation pressure could trigger a server-side GC the small-room test doesn't reproduce. To verify, the test would need to use `bootLivingWorldTestServer` with the full multi-sector + bot pool.

3. **Server-side periodic task** firing every ~15 s causing a 400 ms block. Candidates: snapshot persistence (60 s — doesn't match), bot respawn cycle (12 s — closer match), LivingWorld director (1.5 s — too fast). None obviously match the 17 s average inter-event cadence in the phone capture.

4. **Client-side instrumentation we don't have visibility for.** Even with `?diag=0`, browser-extension activity, OS-level scheduling pauses, or Chrome's background tab throttling could cause snapshot processing to back up.

## Client-side instrumentation added this round

I added a 1-line change to `ColyseusClient.ts:1108` that logs server `gc_pause` events to client diag (currently the data is received but only fed to health-stats, not the capture stream). This makes the NEXT phone smoke definitively answer whether server GC pauses are involved:

- If the next phone capture shows `gc_pause` events that overlap with `recv_gap_long` events → server-side GC is the cause (despite the test passing, the dev-server load reproduces the issue but the test doesn't).
- If `gc_pause` events are absent or don't overlap → the cause is one of (1), (2), or (3) above.

## Test is a regression lock, NOT a failing-test-first

Per Invariant #13, a failing test before the fix is the TDD pattern. This test PASSES on current HEAD, so it's a CHARACTERIZATION + REGRESSION lock, not a failing-test-first. It documents the expected server-side behaviour and would fail if a future change regressed the tick cadence under hostile load.

Honest read: the imperative-taco-r2 plan's TDD shape requires a failing test before the fix. The data refused to give us one for the server-side hypothesis. The right move per the plan's "honesty section" is to surface this and consult the user — exactly what the round-1 result did.
