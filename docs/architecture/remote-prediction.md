# Remote-Entity Forward-Prediction

Stage 3 of the network-feel roadmap. Pre-Stage 3, every remote ship in the client's `predWorld` was reset to its server-tick pose on each snapshot and integrated forward only via Rapier damping (no thrust, no turn). The visible result was a ~50 ms lag between a remote pilot's actual position and where the client rendered them — the dogfight-feel ceiling that limited how decisively combat could read.

Stage 3 forward-predicts remote ships using the **input vector the server is currently applying to that ship**, broadcast as part of the snapshot. The client applies that input to its `predWorld` each tick during reconciliation replay and during `tickPhysics`, so remote bodies advance in lockstep with the local input loop.

## The chain of contracts

```
                          ┌──────────────┐
                          │ Worker       │  applyInput dequeues / re-applies held
                          │ (Rapier)     │  → bits 3-7 of FLAGS slot in SAB
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐  read FLAGS slot
                          │ SectorRoom   │  → states[playerId].lastInput
                          │ (snapshot)   │     in SnapshotMessage
                          └──────┬───────┘
                                 │ broadcast 'snapshot'
                                 ▼
        ┌────────────────────────────────────────────────────────┐
        │ ColyseusClient.handleSnapshot                          │
        │   _remoteLastInputs[remoteId] = state.lastInput        │
        │   _remoteForwardTicks[remoteId] = 0                    │
        │   reconciler.reconcile(..., perReplayTick=             │
        │     () => applyRemoteInputs())                         │
        └──────────────────────┬─────────────────────────────────┘
                               │
                               ▼
        ┌────────────────────────────────────────────────────────┐
        │ tickPhysics input loop (60 Hz)                         │
        │   apply local input → applyRemoteInputs() →            │
        │   predWorld.tick(1/60)                                 │
        └────────────────────────────────────────────────────────┘
```

The client's `applyRemoteInputs` is gated by:

1. **Hysteresis** (`shouldForwardPredict` in `remotePredictionGuard.ts`). Tracks the last 3 reconcile-correction magnitudes per remote. Three consecutive corrections > 5 u disable forward-prediction for that remote (their input intent isn't tracking — extrapolation makes things worse). Three consecutive corrections < 5 u re-enable. Boundary-crossing corrections reset the streak — sticky thresholds, no oscillation.

2. **Lookahead cap** (`STAGE_3_MAX_LOOKAHEAD_TICKS = 8`). Per-remote `_remoteForwardTicks` counter, reset on every snapshot. Once ≥ 8 we stop applying input for that remote until the next snapshot — the body integrates with damping only. Bounds runaway speculation during long network stalls (e.g. a 500 ms snapshot gap would otherwise let us speculate 30 ticks of "they're still thrusting" without any authoritative confirmation).

## Why this is *not* a separate `PhysicsWorld` per remote

The roadmap's plan-agent suggested giving each remote ship a tiny `PhysicsWorld`-of-one. We didn't take that path because:

- The existing `predWorld` *already contains every remote ship* (per `src/client/CLAUDE.md`: "Remote ships must be in predWorld."). Spawning 32 additional Rapier worlds would burn memory for no obvious correctness gain.
- Stage 2 (collision events) handles the cross-body coupling concern. If a local-vs-remote collision happens in `predWorld`, the server's `collision_resolved` patches both bodies' velocities directly — the speculative collision in predWorld doesn't accumulate error.
- Re-using one world means one `world.step()` per tick rather than 32, and the spring-correction (Stage 1) and collision-event (Stage 2) machinery applies uniformly to every body without per-world plumbing.

The actual forward-prediction surface is just two maps (`_remoteLastInputs`, `_remoteForwardTicks`) and one method (`applyRemoteInputs`).

## SAB layout

`src/shared-types/sabLayout.ts` reserves bits 3–7 of `SLOT_FLAGS_OFF` for the 5 input bits (thrust, turn-left, turn-right, boost, reverse). Bits 0–2 are pre-existing (`FLAG_SLEEPING`, `FLAG_IS_SWARM`, `FLAG_KIND_DRONE`). The worker writes the input bits each tick after applying input; the server's snapshot builder reads them back and packs them into `states[playerId].lastInput`.

Held inputs (a key down across many ticks) work correctly because `inputQueue.ts`'s held-input branch keeps `lastApplied` populated even when the client's idle-throttle suppresses redundant `'input'` messages.

## What this does *not* do

- **Drones are not forward-predicted via this path.** Drones live in `mirror.swarm`, not `predWorld.bodies` — their poses come through the binary swarm channel at 60 Hz already. (A future stage could deterministically forward-predict drones using their shared AI behaviour tree, but that's outside Stage 3's scope.)
- **No projectile prediction.** Projectile ghosts (Phase 4) already render the local shooter's bolts immediately; remote-shooter bolts arrive with the next snapshot. Forward-predicting projectiles would require their own input-intent equivalent and is out of scope.
- **Per-client toggle UI.** The plan-agent's "A/B toggle behind a Zustand UI flag" is deferred — the unit-test property + production wire-up are the verification surface for Stage 3.

## Observability

The `'correction'` log entries already carry per-snapshot drift; pre-Stage-3 user diagnostics showed ~50 ms remote-ship lag manifesting as small periodic corrections. Post-Stage-3 those correction magnitudes should drop close to zero for remote ships under stable input. Look at `eqxLogs.filter(e => e.tag === 'correction')` and watch `driftUnits`: a remote pilot in a sustained thrust-and-turn pattern should produce ~0.1 u corrections instead of multi-unit ones.

The hysteresis is per-remote and not currently surfaced in `PredictionStats`; if Stage 4 needs that signal, expose `_predGuard.enabled.size` as a stat.

## Files

- `src/shared-types/sabLayout.ts` — input flag bits in `SLOT_FLAGS_OFF`.
- `src/shared-types/messages.ts` — `SnapshotMessage.states[*].lastInput`.
- `src/core/physics/worker.ts` — writes input bits to SAB each tick.
- `src/core/prediction/Reconciler.ts` — `perReplayTick` callback hook.
- `src/server/rooms/SectorRoom.ts` — reads SAB FLAGS, populates snapshot.
- `src/client/net/remotePredictionGuard.ts` — pure hysteresis + cap module.
- `src/client/net/remoteForwardPrediction.test.ts` — lockstep-property tests.
- `src/client/net/remotePredictionGuard.test.ts` — hysteresis + cap tests.
- `src/client/net/ColyseusClient.ts` — `applyRemoteInputs`, snapshot integration.
