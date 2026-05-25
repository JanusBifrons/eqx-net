# FIELD_OWNERSHIP — `ColyseusClient.ts` decomposition

**Status**: reviewer artefact for commits 16-19 of the god-file refactor
(see [`docs/plans/refactor-god-files.md`](../../../../docs/plans/refactor-god-files.md)). Each
private field in the current monolithic `src/client/net/ColyseusClient.ts`
is assigned to the target collaborator it will migrate to. Reviewers
verify the seams BEFORE the extractions land.

**Field-name source**: `git show origin/main:src/client/net/ColyseusClient.ts` at
HEAD = `8ab9946` (post-`feat/perf-floor` merge, 132 commits).

**Reading rules**:
- "→ X" means the field migrates to collaborator X.
- "(scratch)" denotes a pooled per-frame scratch added by the perf-floor
  GC-discipline ship. These MUST stay pooled (no per-frame allocation)
  after extraction; `pnpm bench` and the heap-growth E2Es enforce.
- "(diagnostics)" denotes a field that feeds `stats.*` or `streamingDiag`,
  NOT the live-loop. They live in `ColyseusClientDiagnostics`, NOT
  `PredictionStateManager` — even when they look like prediction state.
- "(reset-cluster)" denotes a field that `IPredictionState.reset()` MUST
  clear atomically. Per LESSONS.md 2026-05-16 + merges `d77a59f` /
  `51cac44`, drift accumulates if any reset-cluster field is missed.

---

## Target collaborators (10 modules)

1. **`PredictionStateManager.ts`** — owns `predWorld`, `reconciler`, RTT
   cluster, clock anchor. Composes `correctionSmoothing`,
   `inputTickRecovery`, `lookaheadController`, `snapshotDropDetector`,
   `applyCollisionResolved`, `remotePredictionGuard`, `Clock`.
2. **`LingeringPredBodyManager.ts`** — owns `tryEnsureLingerPredBody` +
   the lingering-ship offset map.
3. **`RttClockSampler.ts`** — reads from PredictionStateManager via
   accessors; composes `Clock.ts`.
4. **`SnapshotApplier.ts`** — extracts the inline snapshot-coalesce path
   + the lingering eviction loop + the pooled `laser_fired` per-fire
   entry (remote-shot ingest).
5. **`MirrorUpdater.ts`** — sole `interpolateSwarmPose` caller for
   drones (kind===1); writes resolved pose into `entry.x/y/angle` once
   per frame. Owns the 1Hz HUD dispatch loop (imports `useUIStore`
   directly — documented violation, 1Hz rate keeps it off the per-frame
   budget).
6. **`ClientPhysicsBridge.ts`** — owns `syncSwarmIntoPredWorld` +
   pooled scratches from perf-floor step 5.
7. **`CombatFeedbackBridge.ts`** — implements caller side of
   `ICombatFeedbackSink`; owns pooled damage-reconcile scratch from
   step 8.
8. **`GhostProjectileManager.ts`** — composes `HitPredictionLedger` from
   `@core/combat/HitPrediction` (the pure ledger). The `laser_fired`
   pool belongs to SnapshotApplier (remote shots), NOT here (local
   ghosts only).
9. **`WarpClientOrchestrator.ts`** — sole caller of `rearmJoinReadiness`.
10. **`ColyseusClientDiagnostics.ts`** — composes `perfStats.ts` and
    `streamingDiag.ts`; owns diagnostic scratches + per-event metrics
    that look prediction-shaped but aren't.

---

## Field assignment table

Line numbers reference `ColyseusClient.ts` at HEAD `8ab9946`.

### Reset-cluster (PredictionStateManager owns; reset clears atomically)

| Field | Line | Target | Notes |
|---|---|---|---|
| `predWorld` | 676 | PredictionStateManager | accessed via `getPredWorld()` |
| `reconciler` | 677 | PredictionStateManager | accessed via `getReconciler()` |
| `_rttWelford` | 562 | PredictionStateManager (reset-cluster) | accessed via `getRttSampler()` |
| `_lookaheadCtrl` | 567 | PredictionStateManager | composes `lookaheadController.ts` |
| `_dropDetector` | 572 | PredictionStateManager | composes `snapshotDropDetector.ts` |
| `_anchorInitialised` | 538 | PredictionStateManager (reset-cluster) | |
| `clockAnchorServerTick` | 534 | PredictionStateManager (reset-cluster) | |
| `clockAnchorPerfNow` | 535 | PredictionStateManager (reset-cluster) | |
| `leadTicks` | 551 | PredictionStateManager (reset-cluster) | |
| `lastFiredAtTick` | 649 | PredictionStateManager (reset-cluster) | |
| `_localPoseResolvedLogged` | 544 | PredictionStateManager (reset-cluster) | one-shot flag |
| `inputTick` | 513 | PredictionStateManager (reset-cluster) | |
| `serverTickAtWelcome` | 520 | PredictionStateManager (reset-cluster) | |
| `welcomePerfNow` | 527 | PredictionStateManager (reset-cluster) | |
| `lastSnapshotPos` | 515 | PredictionStateManager (reset-cluster) | |

### Lingering-pred-body state

| Field | Line | Target |
|---|---|---|
| `predLingeringIds` | 366 | LingeringPredBodyManager |
| `_lingeringShipOffsets` | 447 | LingeringPredBodyManager |
| `_lingeringSeenScratch` | 638 (scratch) | SnapshotApplier — used inside the eviction loop in `handleSnapshot`, NOT in `tryEnsureLingerPredBody` |
| `_lingeringToEvictScratch` | 643 (scratch) | SnapshotApplier — same reason |

### Snapshot-apply path (coalesce + remote-pre-reset + remote-laser)

| Field | Line | Target |
|---|---|---|
| `_pendingSnapshot` | 739 | SnapshotApplier (extracts inline coalesce) |
| `_coalesceEnabled` | 740 | SnapshotApplier |
| `_coalescedSinceLastProcess` | 741 | SnapshotApplier |
| `_preResetRemotePosScratch` | 587 (scratch) | SnapshotApplier |
| `_preResetRemotePosEntries` | 592 (scratch) | SnapshotApplier |
| `predRemoteShipIds` | 353 | SnapshotApplier |
| `predWreckIds` | 358 | SnapshotApplier |
| `predSwarmKeys` | 318 | SnapshotApplier |
| (pooled per-fire entry for `laser_fired`) | ~1258-1322 | SnapshotApplier — REMOTE shots; NOT GhostProjectileManager |

### Mirror update + HUD dispatch

| Field | Line | Target |
|---|---|---|
| `mirror` | 288 | MirrorUpdater (owner; ColyseusClient still exposes it as `readonly`) |
| `_swarmInterpScratch` | 344 (scratch) | MirrorUpdater — sole `interpolateSwarmPose` caller for drones |
| `_aimInterpScratch` | 350 (scratch) | MirrorUpdater (used by aim-target builder consumed by LocalMountAimer) |
| `_lastPushedSwarmCount` | 617 | MirrorUpdater (HUD dispatch dedupe) |
| `_pendingHullPct` | 630 | MirrorUpdater (HUD dispatch) |
| `_pendingShieldPct` | 631 | MirrorUpdater (HUD dispatch) |
| `_lastPushedHullPct` | 623 | MirrorUpdater (HUD dispatch dedupe) |
| `_lastPushedShieldPct` | 624 | MirrorUpdater (HUD dispatch dedupe) |
| `_lastHudDispatchAtMs` | 632 | MirrorUpdater (1Hz gate) |
| `HUD_DISPATCH_INTERVAL_MS` (static) | 633 | MirrorUpdater (constant; 1000ms) |

### Physics bridge

| Field | Line | Target |
|---|---|---|
| `_swarmKinematicScratch` | 598 (scratch) | ClientPhysicsBridge |
| `_swarmBodyKeyCache` | 603 (scratch) | ClientPhysicsBridge |
| `_swarmSyncSeenScratch` | 607 (scratch) | ClientPhysicsBridge |

### Combat feedback

| Field | Line | Target |
|---|---|---|
| `_damageReconcileScratch` | 612 (scratch) | CombatFeedbackBridge |
| `_scheduledDamageSpawns` | 787 (scratch) | CombatFeedbackBridge |
| `_lastHitscanFireMs` | 800 | CombatFeedbackBridge (or GhostProjectileManager — TBD during commit 18 review) |

### Ghost projectile

| `_hitLedger` (separate field — see grep) | n/a explicit | GhostProjectileManager (composes `HitPredictionLedger` from `@core/combat/HitPrediction`) |

### Input dispatch + local mount aim

| Field | Line | Target |
|---|---|---|
| `keyboard` | 647 | InputDispatcher |
| `touchInput` | 648 | InputDispatcher |
| `_joystickInputState` | 654 | InputDispatcher (composes `joystickToInput.ts`) |
| `_localSlotTarget` | 661 | LocalMountAimer |
| `lastSentInputState` | 670 | InputDispatcher |
| `lastSentInputAtMs` | 671 | InputDispatcher |
| `lastFrameMs` | 673 | InputDispatcher |

### Remote prediction

| Field | Line | Target |
|---|---|---|
| `_remoteShipOffsets` | 438 | RemotePredictionBridge |
| `_collisionGuard` | 455 | RemotePredictionBridge (composes `applyCollisionResolved.ts`) |
| `_remoteLastInputs` | 461 | RemotePredictionBridge |
| `_remoteForwardTicks` | 469 | RemotePredictionBridge |
| `_predGuard` | 473 | RemotePredictionBridge (composes `remotePredictionGuard.ts`) |

### Diagnostics (NOT prediction state — do NOT put in PredictionStateManager.reset)

| Field | Line | Target |
|---|---|---|
| `stats` | 476 | ColyseusClientDiagnostics |
| `transitInstr` | 315 | ColyseusClientDiagnostics |
| `_swarmNearbyIds` | 578 (scratch, diagnostics) | ColyseusClientDiagnostics |
| `_swarmNearbySwapScratch` | 583 (scratch, diagnostics) | ColyseusClientDiagnostics |
| `_lastLocalTickAtMs` | 689 | ColyseusClientDiagnostics |
| `_lastSnapshotRecvAtMs` | 697 | ColyseusClientDiagnostics |
| `_lastRafStallAtMs` | 706 | ColyseusClientDiagnostics |
| `_lastRafStallHeapMb` | 707 | ColyseusClientDiagnostics |
| `_lastReconcileMs` | 714 | ColyseusClientDiagnostics |
| `_lastReplayWindow` | 715 | ColyseusClientDiagnostics |
| `_rafSampleCounter` | 744 | ColyseusClientDiagnostics |
| `_swarmDecodeMaxMs` | 752 | ColyseusClientDiagnostics |
| `_swarmDecodeTotalMs` | 753 | ColyseusClientDiagnostics |
| `_swarmDecodeCount` | 754 | ColyseusClientDiagnostics |
| `_swarmBinaryLastMs` | 769 | ColyseusClientDiagnostics |
| `_swarmBinaryEwma` | 770 | ColyseusClientDiagnostics |

### AI hostility ledger (kept inline — server→client mirror, never re-simulated)

| Field | Line | Target |
|---|---|---|
| `_aiSink` | 330 | ColyseusClient (the orchestrator; mostly no-op since drones are snapshot-interpolated post-2026-05-18) |
| `_aiController` | 331 | ColyseusClient (hostility ledger only — `markHostile`/`isEntityHostileToPlayer`) |
| `_aiRegisteredIds` | 338 | ColyseusClient (matches the registered set on the ledger) |

### Orchestrator (stays in ColyseusClient.ts)

| Field | Line | Target |
|---|---|---|
| `clock` | 261 (readonly) | ColyseusClient |
| `audio` | 286 | ColyseusClient |
| `room` | 505 | ColyseusClient |
| `disposed` | 644 | ColyseusClient |

---

## Open questions for reviewer attention

1. **`_lastHitscanFireMs` (line 800)** — currently used by both
   `tickLocalMountAim` (for the slew-back-to-rest gate) AND ghost
   projectile fade timing. The plan assigns it tentatively to
   `CombatFeedbackBridge`; commit 18 may pull it into `LocalMountAimer`
   if the ghost-fade reference turns out to be incidental.
2. **`_hitLedger`** — verify with `grep -n "_hitLedger" ColyseusClient.ts`
   during commit 18; the field is referenced but its exact line is below
   the grep window used to build this table.
3. **1Hz HUD dispatch import direction** — MirrorUpdater imports
   `useUIStore` directly (a documented violation of "renderer never
   subscribes to bus" rule). Alternative: emit a discrete `HUD_UPDATED`
   bus event and have `gameScalarsSlice` subscribe. Plan picks direct
   import (writes, not subscribes; 1Hz keeps it off per-frame budget).
   Reviewer: confirm this trade.

## Update protocol

Each of commits 16-19 updates this table to mark a row as `MIGRATED`
once the field is gone from `ColyseusClient.ts` and lives in its target
collaborator. Commit 17's `PredictionStateManager.resetCoverage.test.ts`
specifically asserts every reset-cluster row above is cleared by
`reset()`.

Final commit 23 verifies the table has zero unmigrated rows.
