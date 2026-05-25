# EQX Peri God-File Refactor — Single-PR Plan (Hardened v2, post-`8ab9946`)

## Context

Four hot-path files have grown into orchestrator monoliths that any feature work has to load wholesale: `SectorRoom.ts` (4348 LOC), `ColyseusClient.ts` (**4237**), `PixiRenderer.ts` (2272), `App.tsx` (1263). Together with secondary-tier files (diagRouter 765, shipKinds 738, HaloRadar 625, WorkerRendererClient 556, World 553, store 540, messages 525), they cost ~16k LOC ≈ 160k tokens to read before an agent can make a coherent edit to weapons, prediction, rendering, or perf.

Goal: decompose all 11 files using SOLID seams already implicit in the code, into thin orchestrators (~300–500 LOC) plus named collaborators (~150–350 LOC each), so a typical AI agent reads ~10–20k tokens for the same task. User decisions (re-confirmed for this v2): full sweep, single mega-refactor PR, structural + module-level redesign latitude.

### Post-merge baseline (HEAD = `8ab9946`, 2026-05-25)

This plan was re-evaluated against the post-merge state of `origin/main` after the large `feat/perf-floor` integration landed (132 commits, 8 perf probes, mobile-perf reconciliation, GC-discipline ship including ObjectPool / mutate-in-place mirror rebuild / snapshot coalescing / pooled per-fire scratches / heap-growth E2E gates). Consequences for this refactor:

- **God-file sizes changed by the merge**: SectorRoom 4291→4348, ColyseusClient 3265→**4237** (+972, second-largest now), PixiRenderer 2201→2272, App.tsx 1126→1263, diagRouter 527→765 (newly in significant tier), WorkerRendererClient 543→556, World 536→553. shipKinds, HaloRadar, store, messages unchanged.
- **Two refactor patterns, kept distinct in this plan**:
  1. **Compose external module** — sibling already exists on disk as a SOLID-shaped exportable module; the new collaborator imports it. Modules in this class (verified existence + LOC via `git show origin/main:<path> | wc -l`): `src/client/perf/frameRateCap.ts` (56), `src/client/render/perFrameTriggers.ts` (55), `src/core/clock/Clock.ts` (54), `src/client/net/perfStats.ts` (130), `src/client/debug/streamingDiag.ts` (247), `src/client/debug/deviceInfo.ts` (197), `src/client/components/rosterPoller.ts` (151), `src/client/input/joystickToInput.ts` (146), `src/client/net/swarmDisplayPose.ts`, `lookaheadController.ts`, `snapshotDropDetector.ts`, `transitClient.ts`, `clockAnchor.ts`, `remotePredictionGuard.ts`, `correctionSmoothing.ts`, `inputTickRecovery.ts`, `applyCollisionResolved.ts`, `swarmInterpolation.ts`, `BinarySwarmDecoder.ts`, `src/core/combat/HitPrediction.ts` (the pure `HitPredictionLedger`), `src/client/combat/HitPrediction.client.ts` (reconcile helpers: `resolveClosestPredictedHit`, `reconcileAckToFeedback`, `reconcileDamageToFeedback`), `src/client/combat/GhostProjectile.ts`, `src/client/combat/LocalBeam.ts`.
  2. **Extract inline pattern, re-point existing test** — the pattern lives inline in `ColyseusClient.ts` today; only the regression-lock test exists as a standalone file. Cases in this class: the snapshot-coalescing path (`_pendingSnapshot` + `_coalesceEnabled` + `_coalescedSinceLastProcess` fields at `:739-741`, `room.onMessage('snapshot')` branch at `:1116-1130`, `processPendingSnapshot()` at `:1869-1903` — locked by the existing `tests/.../snapshotCoalesce.test.ts`, 200 LOC); the mutate-in-place mirror-entry pattern inside `updateMirror()` and `syncProjectiles()` (locked by `mirrorEntryPooling.test.ts` 166 LOC + `probe8Pooling.test.ts` 255 LOC, whose own docstrings say "mirror the inline pooling patterns in ColyseusClient"); the pooled remote-laser per-fire entry inside the `room.onMessage('laser_fired')` handler (`:1258-1322`); the 1Hz HUD dispatch loop inside `updateMirror()` (`:2895-2920`). For each, the extraction commit ports the inline code into a private method of the new collaborator AND re-points the existing test (a 2-line import change per test) at the new home.
- **Netgate gate (root CLAUDE.md invariant #8, AMENDED post-merge)**: any change touching the live-loop (client `net/`, `prediction/`, physics, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot) MUST run `pnpm e2e:netgate` baseline-relative-green. This plan touches every one of those surfaces; netgate is on the verification protocol (step 12) and in commit 26's CI workflow. Netgate infrastructure: `tests/netgate/run-netgate.ts` (309 LOC), `eqxLatencyProxy.ts`, `latencyProfile.ts`, `netHealthBudget.ts`, `tests/e2e/netcode-health.spec.ts`, `.claude/skills/netgate/SKILL.md`. It boots two worktrees + two vite servers and asserts `rollingCorrRate`/`ticksAhead`/`maxDriftUnits`/`meanDriftUnits`/`droppedSnapshotsRecent` are not regressed.
- **Test-harness philosophy (root CLAUDE.md, new ~60-line section)**: E2E tests target 1-2 seconds wall-clock. When > 30s is needed, add a bespoke gameplay trigger (`initialHull`, `initialShield`, `testTimeScale`, `testId` + `filterBy`) — do NOT bump `setTimeout` or `test.setTimeout(N_MUCH_LARGER)`. Anti-patterns explicitly forbidden in code review. Every new E2E spec in this PR (commits 12, 15, 17, 22) MUST enumerate which bespoke triggers it uses; commits that introduce an E2E without a documented trigger are rejected.
- **One-pose-per-frame is LOAD-BEARING ENFORCED** (was claimed; per merge `e99d73d` + the rewritten paragraph in `src/client/CLAUDE.md` lines 131–132). The greppable seam is `resolveDroneDisplayPose` in `src/client/net/swarmDisplayPose.ts`. Every consumer (`PixiRenderer` for `kind===1`, predWorld collision body, turret/laser aim `buildLocalAimTargets`, health bars, labels) MUST read the resolved `entry.x/y/angle` and MUST NOT call `interpolateSwarmPose` again. Asteroid (`kind===0`) carve-out preserved. The plan's `MirrorUpdater` performs the single resolution; the lock tests are `tests/unit/swarmPoseConsistency.test.ts` (deterministic per-frame), `tests/scenarios/droneOnePoseAcrossFrames.test.ts` (across-frames boundary), `tests/unit/swarmInterpolation.smoothness.test.ts` (per-frame canary, deterministic), `src/core/prediction/Reconciler.reconcile.test.ts` (no-drone-seed signature).
- **Retired surface — do NOT reference in the plan**: `tickClientAi`, `AiController.tickOnly`, `partitionDronesByRelevance`, `droneRelevance.ts`, `DRONE_RESIM_BUDGET`, `_droneSnapshotAnchored`, `_droneRenderOffsets`, `_droneLastSnapDist`, `swarm_snap_diagnostics`, the `Reconciler.reconcile` 6th drone-replay-seed param, `anchoredDroneReseedSmoothing`. The `perReplayTick` hook now does ONLY `applyRemoteInputs()`.
- **GC discipline is now an invariant.** Per the perf-floor merge: ObjectPool primitives, mutate-in-place mirror rebuild (probes 7-8 — `mirrorEntryPooling.test.ts`, `probe8Pooling.test.ts`), snapshot coalescing (probe 6 — `snapshotCoalesce.test.ts`), pooled per-frame containers in `PixiRenderer.update()` (step 6), pooled `setShipState` + swarm-kinematic + cached swarm keys (step 5), pooled per-fire entry in laser_fired (step 7), pooled damage-reconcile scratch (step 8), 1Hz HUD dispatch (step 10). The plan must NOT regress these — every extraction commit runs `pnpm bench` (against `benchmarks/baseline.json`) and the heap-growth E2E gates (`tests/e2e/heap-growth-gate.spec.ts`, `combat-heap-growth.spec.ts`, `combat-allocation-profile.spec.ts`).
- **Touch devices DEFAULT to the main-thread `PixiRenderer`, NOT the worker** (per `src/client/CLAUDE.md` 2026-05-22 entry). `App.tsx` selection logic: `?worker=1` forces worker; `?worker=0` forces main-thread; default = `!isTouchDevice() && supportsOffscreenRenderer()`. The plan's `AppBootstrap.ts` preserves this branch exactly.
- **Work-loop cap at 10 ms** (`src/client/perf/frameRateCap.ts`, `DEFAULT_MIN_FRAME_INTERVAL_MS = 10.0`). `App.tsx` RAF loop early-returns when `deltaMs < cap`. The plan's `AppBootstrap.ts` composes `frameRateCap.ts` and preserves the early-return-BEFORE-`lastFrameTime = now` ordering (otherwise the cap never engages). Runtime override `?fpscap=N` continues to work. Locked by `tests/unit/frameRateCap.test.ts` + `frameRateCap.realCapture.test.ts`.

---

## Module structure

### `src/server/rooms/SectorRoom.ts` (4348 → ~450 orchestrator)

`src/server/rooms/sector/` — `SectorRoom.ts` (~450, lifecycle + wiring + the `convertShipToWreck`/`evictSwarmEntity`/`handleRespawn` lifecycle methods that span 8 collaborators), `SectorRoomDeps.ts` (~80), `CombatResolver.ts` (~380), `LagCompRing.ts` (~150), `WeaponMountTicker.ts` (~220, sole server caller of `pickTarget`/`rotateMountToward`), `AiSectorController.ts` (~250), `SwarmRegistry.ts` (~280), `BroadcastScheduler.ts` (~320, owns `forceBroadcastUntilTick`; composes the snapshot-coalesce path established by merge `9d0c645`), `PlayerSlotMap.ts` (~180), `ShieldHullStateTracker.ts` (~180), `WreckTracker.ts` (~150), `WreckLifecycleCoordinator.ts` (~180, owns the 8-collaborator `convertShipToWreck` transaction), `OwnerlessShipTimers.ts` (~80), `SectorTransitAdapter.ts` (~220, room-side bindings for the EXISTING `src/server/transit/TransitOrchestrator.ts` — NOT a new orchestrator), `LivingWorldBridge.ts` (~120), `PhysicsWorkerProxy.ts` (~250), `SectorDiagnostics.ts` (~180, composes the post-merge `streamingDiag.ts` pattern).

### `src/client/net/ColyseusClient.ts` (4237 → ~350 orchestrator)

`src/client/net/colyseus/` — `ColyseusClient.ts` (~350), `ColyseusClientDeps.ts` (~80), `FIELD_OWNERSHIP.md` (the field-assignment table referenced below; lands in commit 1 as a reviewer artefact, NOT a runtime file), `PredictionStateManager.ts` (~350, owns `predWorld`, `reconciler`, `_rttWelford`, `_anchorInitialised`, `clockAnchorServerTick`, `leadTicks`, `lastFiredAtTick`, `_localPoseResolvedLogged`; **composes external modules `lookaheadController`, `snapshotDropDetector`, `correctionSmoothing`, `inputTickRecovery`, `applyCollisionResolved`, `remotePredictionGuard`, `Clock` — does NOT absorb them**; reset clears `correctionSmoothing` + `inputTickRecovery` state alongside legacy fields per merges `d77a59f` + `51cac44`. Note: `_recentIntervals` and `_recentCorrFlags` are NOT prediction state — they feed `stats.snapshotJitterMs` and correction-rate diagnostics — they live in `ColyseusClientDiagnostics`), `LingeringPredBodyManager.ts` (~140, owns `tryEnsureLingerPredBody` + `_lingeringShipOffsets`; does NOT own the eviction-loop scratches `_lingeringSeenScratch` / `_lingeringToEvictScratch` — those live in SnapshotApplier where the loop runs), `RttClockSampler.ts` (~180, reads from PredictionStateManager via accessors; composes `Clock.ts`), `SnapshotApplier.ts` (~420, **extracts the inline snapshot-coalescing path** — `_pendingSnapshot` + `_coalesceEnabled` + `_coalescedSinceLastProcess` fields + `room.onMessage('snapshot')` branch + `processPendingSnapshot()` method, ~80 LOC budget for this private method, re-points existing `snapshotCoalesce.test.ts` at the new home; also owns `_preResetRemotePosScratch` + `_preResetRemotePosEntries`, `_lingeringSeenScratch` + `_lingeringToEvictScratch`, AND the pooled remote-laser per-fire entry from the `laser_fired` handler `:1258-1322` — that path writes to `mirror.remoteLasers` and belongs with the rest of `onMessage` routing, NOT with GhostProjectileManager which handles LOCAL-player ghosts), `MirrorUpdater.ts` (~320, sole `interpolateSwarmPose` caller for drones (`kind===1`) only — load-bearing per `src/client/CLAUDE.md` lines 131–132; writes resolved pose into `entry.x/y/angle` once per frame; **extracts the inline mutate-in-place mirror-entry pattern** from `updateMirror()` + `syncProjectiles()`, re-points `mirrorEntryPooling.test.ts` + `probe8Pooling.test.ts` (their assertions are pure-function-shaped — 2-line import change per test); non-spatial field preservation parameterised over every `ShipRenderState` + `SwarmRenderState` field; **also owns the 1Hz HUD dispatch loop** `:2895-2920` including `_pendingHullPct`, `_pendingShieldPct`, `_lastPushedHullPct`, `_lastPushedShieldPct`, `_lastHudDispatchAtMs`, `HUD_DISPATCH_INTERVAL_MS` — MirrorUpdater imports `useUIStore` directly to call `setHullPct`/`setShieldPct` (documented violation of "renderer never subscribes to bus" rule; the dispatch is a write, not a subscribe, and the 1Hz rate keeps it off the per-frame budget); `_lastPushedSwarmCount` also lives here), `ClientPhysicsBridge.ts` (~200, composes pooled scratches from step 5 — owns `_swarmKinematicScratch`, `_swarmBodyKeyCache`, `_swarmSyncSeenScratch` and the `syncSwarmIntoPredWorld` method), `CombatFeedbackBridge.ts` (~260, consumes `ICombatFeedbackSink`; single hit_ack/DamageEvent reconcile path per merge `fa6f8da` — locked by `hitAckContract.test.ts`; owns `_damageReconcileScratch` + `_scheduledDamageSpawns` queue from step 8), `GhostProjectileManager.ts` (~220, composes `HitPredictionLedger` from `@core/combat/HitPrediction` (the pure ledger) — reconcile helpers stay in `@client/combat/HitPrediction.client.ts`. Does NOT own the `laser_fired` remote-shot pool — that's SnapshotApplier's), `InputDispatcher.ts` (~180), `LocalMountAimer.ts` (~220, sole client caller of `pickTarget`/`rotateMountToward`; aim targets the DRAWN drone pose via `resolveDroneDisplayPose`, NOT an ahead pose, per merge `0e24448`), `RemotePredictionBridge.ts` (~160), `WarpClientOrchestrator.ts` (~240, sole caller of `rearmJoinReadiness`), `ColyseusClientDiagnostics.ts` (~180, composes `perfStats.ts` and `streamingDiag.ts`; owns `_recentIntervals`, `_recentCorrFlags`, `_swarmNearbyIds`, `_swarmNearbySwapScratch`).

### `src/client/render/PixiRenderer.ts` (2272 → ~340 orchestrator)

`src/client/render/pixi/` — `PixiRenderer.ts` (~340, composes `perFrameTriggers.ts` post-merge — pooled per-frame containers from step 6 are NOT re-implemented), `PixiAppLifecycle.ts` (~140), `CameraController.ts` (~180), `SpriteFactory.ts` (~280), `SpriteRegistry.ts` (~200, ship→wreck transition is destroy+recreate NOT migration; locked by `SpriteRegistry.shipToWreck.test.ts`), `ShipSpriteUpdater.ts` (~220), `DroneSpriteUpdater.ts` (~180, MUST consume `resolveDroneDisplayPose` per one-pose-per-frame rule), `AsteroidWreckSpriteUpdater.ts` (~180), `ThrustVfxController.ts` (~180), `DamageFlashController.ts` (~140), `ExplosionVfxController.ts` (~200), `WarpFilterChain.ts` (~260, consumes existing `shouldDetachWarpVisual`/`warpEventFiresBurst`/`resolveWarpFilterCenter`), `BeamRenderer.ts` (~220, MUST consume `resolveDroneDisplayPose` for drone targets — NOT re-interpolate), `BackgroundLayerStack.ts` (~140), `CombatFeedbackBus.ts` (~120, implements `ICombatFeedbackSink`).

Y-flip rule (`src/client/CLAUDE.md` 2026-05-15): ESLint `no-restricted-syntax` blocking `MemberExpression[object.property.name='sprite'][property.name='y'] = ` where RHS is not `-`-prefixed, scoped to `src/client/render/pixi/**/*Updater.ts`. Tested by planting `sprite.y = entry.y` and asserting lint fails.

### `src/client/App.tsx` (1263 → ~300)

`src/client/app/` — `App.tsx` (~300, top-level layout + provider tree only), `AppProviders.tsx` (~120), `AppBootstrap.ts` (~320, DI assembly: `new ColyseusGameClient`, `setAudio`, `setGameClient`, the `window.__eqxClient` shim, the per-frame `tickPhysics → updateMirror → render` loop with the **work-loop cap from `frameRateCap.ts` — early-return BEFORE `lastFrameTime = now`**, the **touch-device renderer selection** branch `?worker=N` / `!isTouchDevice() && supportsOffscreenRenderer()`), `AppHydration.ts` (~140), `OverlayComposer.tsx` (~180). Keep existing `useWarpOrchestration.ts`.

### `src/shared-types/shipKinds.ts` (738 → catalogue split)

`src/shared-types/shipKinds/` — `index.ts` (~80, re-exports including `shipKindToIndex` / `shipKindFromIndex` / `SHIP_KIND_CATALOGUE_VERSION` / `DEFAULT_SHIP_KIND`), `types.ts` (~60), `fighters.ts` (~180), `capitals.ts` (~150), `drones.ts` (~180), `utilities.ts` (~120), `catalogueOrder.ts` (~40), `catalogueOrder.test.ts` (~120, golden snapshot of BOTH `SHIP_KINDS_LIST.map(k=>k.id)` AND `Object.values(SHIP_KINDS).map(k=>k.id)` + bytes-identical wire packet round-trip).

`Object.values(SHIP_KINDS)` is already ES2015-deterministic; split is for readability. `src/server/db/PersistenceWorker.ts` imports `SHIP_KIND_CATALOGUE_VERSION` — `index.ts` re-exports.

### `src/client/render/HaloRadar.ts` (625 → ~280)

`src/client/render/halo/` — `HaloRadar.ts` (~280), `HaloEntityTracker.ts` (~180), `HaloWedgeGrouper.ts` (~140), `HaloAnimator.ts` (~120). Each gets a unit test. MUST consume `resolveDroneDisplayPose` if it reads drone positions.

### `src/client/render/worker/WorkerRendererClient.ts` (556 → ~250)

`src/client/render/worker/` — `WorkerRendererClient.ts` (~250), `WorkerMessageProtocol.ts` (~120), `WorkerFrameRateController.ts` (~100), `WorkerGestureBridge.ts` (~140). New `WorkerMessageProtocol.roundtrip.test.ts` exercises `structuredClone` across every protocol variant. **Plan must preserve the worker→main IPC commit path** (the 110ms tail-latency on Android phones is the reason touch defaults to main-thread — do not "optimise" that branch away).

### `src/client/state/store.ts` (540 → ~120 composer + slices)

`src/client/state/store/` — `index.ts` (~120), `phaseSlice.ts`, `connectionSlice.ts`, `identitySlice.ts`, `rosterSlice.ts`, `gameScalarsSlice.ts` (hp/shield/score only — zero spatial fields; **respects the 1Hz HUD dispatch from step 10 — does NOT regress to per-frame setters**), `overlaysSlice.ts`, `transitSlice.ts`, `diagnosticsSlice.ts`, `settingsSlice.ts`, `drawerSlice.ts`, `gameReadyGates.ts`. Update ESLint glob `eslint.config.js:215` from `'src/client/state/store.ts'` to `'src/client/state/store/**/*.ts'`; plant-x self-test.

### `src/core/physics/World.ts` (553 → ~270)

`src/core/physics/` — `World.ts` (~270), `BodyPool.ts` (~180), `ColliderSwap.ts` (~140), `HitscanRay.ts` (~100), `ContactBridge.ts` (~140), `InputApplier.ts` (~120). Keep `contactDrain.ts`, `inputQueue.ts`, `worker.ts` untouched.

### `src/server/routes/diagRouter.ts` (765 → ~200) — newly in significant tier

The merge took diagRouter from 527 to 765 LOC (+45%) by adding the streaming-diag retention pipeline, perf-baseline endpoints, allocation-audit endpoint, and capture-finalize endpoints. Split:

`src/server/routes/diag/` — `diagRouter.ts` (~200, route table + middleware), `captureExportEndpoint.ts` (~140), `streamingCaptureEndpoint.ts` (~160, new — streaming retention), `eventLogEndpoint.ts` (~100), `limboInspectorEndpoint.ts` (~80), `shipInspectorEndpoint.ts` (~80), `sectorInspectorEndpoint.ts` (~100), `perfBaselineEndpoint.ts` (~120, new — `/perf-baseline` + `/allocation-audit`).

### `src/client/components/GalaxyOverviewScreen.tsx` (532 LOC) — DEFERRED to follow-up PR

The hostile review surfaced this as a 532 LOC file above the v2 cutoff. Decision: **deferred**. Rationale: (1) it's a React component, not in the live-loop / netgate-gated surface; (2) refactor pays back ~5k tokens, an order of magnitude less than the live-loop targets; (3) it sits next to `src/client/render/galaxy/GalaxyOverviewRenderer.ts` (498 LOC) which is its natural sibling and would warrant a paired refactor in the same follow-up. Document this deferral explicitly in commit 27's `docs/LESSONS.md` entry so it's tracked.

### `src/shared-types/messages.ts` (525 → barrel + family files)

`src/shared-types/messages/` — `index.ts` (~80, `AnyMessage` union), `snapshotMessages.ts` (~140), `combatMessages.ts` (~120, contains `hit_ack.damage` field from merge `443ab71`), `transitMessages.ts` (~80), `livingWorldMessages.ts` (~80), `controlMessages.ts` (~80), `diagnosticMessages.ts` (~60).

---

## New DI contracts (in `src/core/contracts/`)

Existing: `IAiBehaviour`, `IAudio`, `INetworkSink`, `IPersistenceSink`, `IRenderer`. Adding:

- `ICombatResolver` — `handleFire`, `stepProjectiles`, `applyDamage`. Impl: `CombatResolver`. Consumer: `SectorRoom`, `CombatFeedbackBridge`.
- `IBroadcastScheduler` — `scheduleSnapshot`, `flush`, `setCadence`, `extendGrace(untilTick)`. Impl: `BroadcastScheduler`. Consumer: `SectorRoom`, `SectorTransitAdapter`.
- `IPredictionState` — `bootstrap`, `reset(reason)`, `getReconciler()`, `getPredWorld()`, `getRttSampler()`. Impl: `PredictionStateManager`. Consumer: `ColyseusClient`, `ClientPhysicsBridge`, `LingeringPredBodyManager`.
- `ISwarmRegistry` — `create`, `destroy`, `resolveKindIndex(id): u8`, `entries()`. Impl: `SwarmRegistry`.
- `ICombatFeedbackSink` — `onDamage`, `onDestroy`, `onWarpPhase`. Impl: `CombatFeedbackBus`. Consumer: `CombatFeedbackBridge`. (Renamed from draft's `IRendererFeedback` to avoid `IRenderer.getFeedback()` collision.)
- `ISectorTransitAdapter` + `ITransitClientOrchestrator` — `beginTransit`, `onArrival`, `state(playerId)`. Server impl: `SectorTransitAdapter` (delegates to existing `src/server/transit/TransitOrchestrator.ts`). Client impl: `WarpClientOrchestrator`.

**Mount-aim contract notes**: `tickSlot` does not exist in source. The single-write-path lock targets `pickTarget`/`rotateMountToward` imports (ESLint) + `playerMountAngles.set`/`droneMountAngles.set` writes (CI grep script). `.delete` in lifecycle owners allowed.

---

## Commit sequence (25 functional + 1 CI + 1 docs = 27 commits, single PR)

Each commit MUST leave `pnpm typecheck && pnpm lint && pnpm test` green + `pnpm bench` within ±5% of `benchmarks/baseline.json` (new gate). Live-loop-touching commits (16-23) additionally run `pnpm e2e:netgate` baseline-relative-green per invariant #8. Outside-in ordering: contracts + the reviewer artefacts first; orchestrator-internal extractions later.

1. `chore(contracts): add 6 new interfaces + ship src/client/net/colyseus/FIELD_OWNERSHIP.md` (the reviewer artefact enumerating every existing ColyseusClient field and its target collaborator — lets reviewers verify seams BEFORE any extraction lands).
2. `feat(app): AppBootstrap shell with stub DI + preserve frameRateCap early-return + touch-device renderer selection`.
3. `refactor(shared-types): split messages.ts by family + AnyMessage exhaustiveness test`.
4. `refactor(shared-types): split shipKinds.ts with deterministic catalogueOrder + dual golden snapshot`.
5. `refactor(core/physics): extract BodyPool, ColliderSwap, HitscanRay, ContactBridge, InputApplier`.
6. `refactor(client/state): split store.ts into slices + update eslint glob + plant-x lint self-test + 1Hz HUD dispatch guard test`.
7. `refactor(client/render): split HaloRadar.ts into halo/ + ensure consumers use resolveDroneDisplayPose`.
8. `refactor(client/render/worker): split WorkerRendererClient.ts + WorkerMessageProtocol.roundtrip.test.ts`.
9. `refactor(server/routes): split diagRouter.ts into diag/ (NEW: streamingCaptureEndpoint, perfBaselineEndpoint extracted)`.
10. `refactor(client/render/pixi): extract SpriteFactory + SpriteRegistry + SpriteRegistry.shipToWreck.test.ts`.
11. `refactor(client/render/pixi): extract entity sprite updaters + Y-flip lint rule + plant-y self-test + DroneSpriteUpdater consumes resolveDroneDisplayPose`.
12. `refactor(client/render/pixi): extract ThrustVfx + DamageFlash + Explosion + BeamRenderer (consumes resolveDroneDisplayPose) + multi-mount-beam.spec.ts`.
13. `refactor(client/render/pixi): extract WarpFilterChain + toString-snapshot lock`.
14. `refactor(client/render/pixi): extract CameraController + PixiAppLifecycle + BackgroundLayerStack + CombatFeedbackBus + perFrameTriggers composition (NOT absorption)`.
15. `refactor(server): WreckLifecycleCoordinator extraction (atomic 8-collaborator transaction)`.
16. `refactor(client/net): extract SnapshotApplier (composes snapshotCoalesce) + MirrorUpdater (mutate-in-place pattern preserved; dronePoseOncePerFrame + nonSpatialFieldPreservation tests)`.
17. `refactor(client/net): extract PredictionStateManager + LingeringPredBodyManager + RttClockSampler + ClientPhysicsBridge + port FIVE existing tests + reset clears correctionSmoothing + inputTickRecovery state`.
18. `refactor(client/net): extract LocalMountAimer + InputDispatcher + GhostProjectileManager (composes HitPredictionLedger + pooled per-fire entry) + CombatFeedbackBridge (composes pooled damage-reconcile scratch) + ESLint pickTarget/rotateMountToward lock + LocalMountAimer.drawnPoseAim.test.ts`.
19. `refactor(client/net): extract WarpClientOrchestrator + RemotePredictionBridge + ColyseusClientDiagnostics (composes perfStats + streamingDiag) + rearmJoinReadiness callerLock test`.
20. `refactor(server/rooms): extract PhysicsWorkerProxy + PlayerSlotMap + SwarmRegistry + OwnerlessShipTimers + slotMapInvariants.test.ts`.
21. `refactor(server/rooms): extract CombatResolver + LagCompRing + WeaponMountTicker + server-side ESLint lock + LagCompRing.rewind.test.ts (replays fixture from capture-lag-comp-golden.mjs)`.
22. `refactor(server/rooms): extract BroadcastScheduler (composes snapshotCoalesce server-side) + ShieldHullStateTracker + WreckTracker + phaseOffsetDeterminism + LagCompRing.scope.test.ts`.
23. `refactor(server/rooms): extract AiSectorController + SectorTransitAdapter + LivingWorldBridge + SectorDiagnostics`.
24. `refactor(client/app): App.tsx slim down — wire AppBootstrap stubs to real impls + confirm frameRateCap early-return ordering preserved + touch-device branch preserved`.
25. `test(perf): per-commit baseline rebaseline + sectorRoomUpdateBaseline.json capture`.
26. `ci: enable integration + bench + heap-growth-gate + combat-heap-growth + combat-allocation-profile + feel-test-lockstep + perf-baseline + netgate (pnpm e2e:netgate) + boot smoke in .github/workflows/ci.yml`. **Netgate is the load-bearing addition** (invariant #8 amendment); it boots two worktrees + two vite servers, so the CI job needs a generous timeout (~12 minutes) and the netgate baseline lives in the CI workflow's matrix.
27. `docs: update CLAUDE.md anchors + architecture decomposition docs + scripts/audit-claude-md-anchors.mjs`.

**Inner-loop discipline (TEST EVERY COMMIT)**: After EVERY commit, run `pnpm typecheck && pnpm lint && pnpm test && pnpm bench`. After server commits (5, 9, 15, 20-23): also `timeout 8 pnpm dev:server`. After `src/server/rooms/` commits (15, 20-23): also `pnpm test:integration -- sectorRoom`. After `src/client/net/` commits (16-19): also targeted E2E (`tests/e2e/heap-growth-gate.spec.ts` + `combat-heap-growth.spec.ts` + `feel-test-lockstep.spec.ts`) PLUS `pnpm e2e:netgate` baseline-relative-green (invariant #8). Commit 16 additionally runs the cheap deterministic locks `tests/unit/swarmPoseConsistency.test.ts` + `tests/scenarios/droneOnePoseAcrossFrames.test.ts` (they ARE the regression lock for the "drones jitter like two things fighting" bug). After `src/core/prediction/` (commit 5 indirectly, 17 directly), render-loop (commit 24), snapshot decode/interpolate (commit 16), mount aim (commit 18), `SectorRoom` tick/snapshot (commits 20-23): also `pnpm e2e:netgate`. If the loop fails or `pnpm bench` exceeds ±5% baseline or netgate regresses, fix in the same commit — never push yellow.

**Test-harness philosophy compliance (commits introducing new E2Es)**: every new spec in this PR enumerates its bespoke trigger to stay under the 1-2 s wall-clock budget:
- Commit 12 `multi-mount-beam.spec.ts` → uses `testTimeScale=4` to compress the fire-and-aim sequence; no `setTimeout` bumps.
- Commit 15 `wreckLifecycleAtomicity.test.ts` → uses `initialHull=1` to trigger conversion-to-wreck in the next damage frame; no real 30s hull-grind.
- Commit 17 transit / lockstep additions → reuse the existing transit spec's `testTimeScale` knob; `feel-test-lockstep` already uses bespoke triggers.
- Commit 22 `BroadcastScheduler.phaseOffsetDeterminism.test.ts` → pure unit (no E2E, no timer concern).
- Commit 18 `LocalMountAimer.lockstep.test.ts` + `drawnPoseAim.test.ts` → unit-level lockstep canaries.
Code-review rejects any new E2E that bumps `setTimeout`/`test.setTimeout` instead of adding a trigger.

---

## Per-commit test-coverage matrix

| # | Existing locks | Gap | New test(s) in this commit | Post-commit run |
|---|---|---|---|---|
| 1 | n/a | None | None | typecheck + lint + test + bench |
| 2 | `App.warpOrchestration.test.tsx`, `frameRateCap.test.ts`, `frameRateCap.realCapture.test.ts` | AppBootstrap DI assembly has no test; frameRateCap early-return ordering not asserted in App scope; touch-device branch not tested at App scope | `app/AppBootstrap.test.ts` (mount `<App />`, assert `getGameClient()` instance, `__eqxClient` on window, audio wired) + `app/AppBootstrap.frameRateCap.test.ts` (assert `lastFrameTime` not set on skipped RAF) + `app/AppBootstrap.touchDevice.test.ts` (mock `isTouchDevice()`, assert main-thread `PixiRenderer` chosen) | typecheck + lint + test + bench + e2e:boot |
| 3 | `messages.test.ts` | `AnyMessage` exhaustiveness | `messages/index.test.ts` (assertNever + parse-roundtrip) | typecheck + lint + test + bench |
| 4 | `shipKinds.test.ts`, `triangulate.test.ts`, `BinarySwarmDecoder.test.ts` | Plan must snap BOTH lists; real names `shipKindToIndex`/`shipKindFromIndex` | `shipKinds/catalogueOrder.test.ts` (dual snapshot + wire round-trip) | typecheck + lint + test + bench |
| 5 | `World.test.ts`, `World.setHullExposed.test.ts`, `ShipKindPhysics.test.ts`, `physicsWorkerSetHullExposed.test.ts` | Worker round-trip for `SET_HULL_EXPOSED` not at integration layer | `tests/integration/sectorRoom/setHullExposedRoundtrip.test.ts` | typecheck + lint + test + bench + boot smoke |
| 6 | `store.rearmJoinReadiness.test.ts`, `store.shield.test.ts` | Lint glob obsolete after split; 1Hz HUD dispatch (step 10) regression risk | Update glob + plant-x lint test + `gameScalarsSlice.hudDispatchRate.test.ts` (asserts hp/shield setters fire ≤1Hz) | typecheck + lint + test + bench |
| 7 | `HaloRadar.test.ts`, `tests/e2e/halo-radar.spec.ts` | New collaborators need unit tests; pose-consumer must use `resolveDroneDisplayPose` | `halo/{HaloEntityTracker,HaloWedgeGrouper,HaloAnimator}.test.ts` + grep test: HaloRadar consumes `resolveDroneDisplayPose`, never `interpolateSwarmPose` | typecheck + lint + test + bench |
| 8 | `protocol.test.ts`, `Camera.test.ts`, `renderer-worker-probe.spec.ts`, `damage-number-lifetime.spec.ts` | Per invariant #13, worker-boundary bugs need boundary tests | `worker/WorkerMessageProtocol.roundtrip.test.ts` | typecheck + lint + test + bench |
| 9 | `diagRouter.test.ts`, `diagRouter.playerShips.test.ts`, `captureSchema.test.ts`, `streamingDiag.test.ts` (post-merge) | Tests are import-keyed on monolithic `diagRouter.ts`; perf-baseline endpoint untested | Port existing tests + `diag/mounting.test.ts` (route count) + `diag/perfBaselineEndpoint.test.ts` | typecheck + lint + test + bench + boot smoke |
| 10 | `spriteUpdateDecisions.test.ts`, `wreck-render-probe.spec.ts`, `drone-destruction.spec.ts` | Ship→wreck is destroy+recreate; SpriteRegistry must not migrate | `pixi/SpriteRegistry.shipToWreck.test.ts` | typecheck + lint + test + bench |
| 11 | `spriteUpdateDecisions.test.ts`, `swarm-stationary-stability.spec.ts`, `droneOnePoseAcrossFrames.test.ts` (post-merge), `swarmPoseConsistency.test.ts` (post-merge) | Y-flip rule not lint-enforced; DroneSpriteUpdater must consume `resolveDroneDisplayPose` | Y-flip ESLint rule + plant-y self-test + `DroneSpriteUpdater.poseConsumption.test.ts` (asserts only `resolveDroneDisplayPose`, never `interpolateSwarmPose`) | typecheck + lint + test + bench |
| 12 | `DamageNumbers.test.ts`, `laser-smoothness.spec.ts`, `damage-number-lifetime.spec.ts`, `drone-laser-smoothness.spec.ts` | Multi-mount beam direction + BeamRenderer drone-target pose-consumption | `tests/e2e/multi-mount-beam.spec.ts` + `BeamRenderer.poseConsumption.test.ts` | typecheck + lint + test + bench + e2e:laser |
| 13 | `PixiRenderer.warpCenter.test.ts`, `warpBurst`, `warpDetach` | Pure helpers silently mutable | toString-snapshot lock | typecheck + lint + test + bench |
| 14 | `Camera.test.ts`, `BackgroundGrid.labels.test.ts`, `perFrameTriggers.test.ts` (post-merge) | `CameraController` needs coverage; `perFrameTriggers` must be composed, not absorbed | `pixi/CameraController.test.ts` + `pixi/PixiRenderer.perFrameTriggersComposition.test.ts` (asserts orchestrator delegates to existing module) | typecheck + lint + test + bench |
| 15 | `rosterFullWreck`, `abandonToWreck`, `lingering` integrations | `convertShipToWreck` 8-way atomicity untested | `tests/integration/sectorRoom/wreckLifecycleAtomicity.test.ts` | typecheck + lint + test + integration:sectorRoom + bench + boot smoke |
| 16 | `swarmInterpolation.test.ts`, `swarmPoseConsistency.test.ts`, `droneOnePoseAcrossFrames.test.ts`, `swarmInterpolation.smoothness.test.ts`, `applyCollisionResolved.test.ts`, `BinarySwarmDecoder.test.ts`, `lingeringRouting.test.ts`, `mirrorEntryPooling.test.ts`, `probe8Pooling.test.ts`, `snapshotCoalesce.test.ts` | Coalesce + mutate-in-place pattern are INLINE today, not modules — extraction ports them to private methods of SnapshotApplier + MirrorUpdater respectively. The three pool/coalesce tests need their imports re-pointed at the new homes (2-line change per test). Plan must enumerate this re-point. | Re-point `snapshotCoalesce.test.ts` at `SnapshotApplier`'s extracted private method (+ `SnapshotApplier.coalesce.test.ts` wrapper test asserting orchestration) + re-point `mirrorEntryPooling.test.ts` + `probe8Pooling.test.ts` at `MirrorUpdater` + `colyseus/MirrorUpdater.nonSpatialFieldPreservation.test.ts` (parameterised over every `ShipRenderState` + `SwarmRenderState` field) + `MirrorUpdater.dronePoseOncePerFrame.test.ts` (drones only, asserts `resolveDroneDisplayPose` is sole consumer) + `MirrorUpdater.mutateInPlace.test.ts` (asserts allocations-per-frame within baseline) + `MirrorUpdater.hudDispatch.test.ts` (asserts 1Hz dispatch via direct `useUIStore` write, NOT per-frame) | typecheck + lint + test + bench + **unit:swarmPoseConsistency** + **scenarios:droneOnePoseAcrossFrames** + e2e:multi-mount-beam + e2e:feel-test-lockstep + e2e:heap-growth-gate + **pnpm e2e:netgate** |
| 17 | `resetPredictionState.test.ts`, `transitArrivalDrift.test.ts`, `transitRearmReadiness.test.ts`, `lingeringRender.test.ts`, `lingeringJitter.test.ts`, `correctionSmoothing.test.ts`, `Reconciler.reconcile.test.ts`, `inputTickRecovery.test.ts`, `clockAnchor.test.ts` | All 5 ColyseusClient tests pierce private fields; reset must clear `correctionSmoothing` + `inputTickRecovery` state. `_recentIntervals` and `_recentCorrFlags` are NOT in PredictionStateManager — they're diagnostics; commit 19 covers them. | Port all 5 + `PredictionStateManager.resetCoverage.test.ts` (asserts reset clears correctionSmoothing + inputTickRecovery + Reconciler + predWorld + RTT + spring atomically; does NOT touch diagnostics fields) + fast-check idempotence | typecheck + lint + test + bench + e2e:transit + e2e:feel-test-lockstep + **pnpm e2e:netgate** |
| 18 | `WeaponMountController.test.ts`, `GhostProjectile.test.ts`, `LocalBeam.test.ts`, `HitPrediction.client.test.ts`, `src/core/combat/HitPrediction.test.ts`, `combat.spec.ts`, `weapon-switching.spec.ts`, `combat-allocation-profile.spec.ts` | `tickSlot` doesn't exist; real targets are `pickTarget`/`rotateMountToward`; `LocalMountAimer` must aim DRAWN pose; `GhostProjectileManager` composes `HitPredictionLedger` from `@core/combat/HitPrediction` (the pure ledger), NOT from `@client/combat/HitPrediction.client.ts` (which exports the reconcile helpers). The pooled `laser_fired` remote-shot path is NOT this commit — it's commit 16 (SnapshotApplier). | ESLint lock + `scripts/audit-mount-angle-writes.mjs` + `LocalMountAimer.lockstep.test.ts` + `LocalMountAimer.drawnPoseAim.test.ts` + `GhostProjectileManager.ledgerComposition.test.ts` (asserts import from `@core/combat/HitPrediction`) | typecheck + lint + test + bench + e2e:combat + e2e:combat-allocation-profile + **pnpm e2e:netgate** |
| 19 | `transitArrivalDrift`, `transitRearmReadiness`, `remoteForwardPrediction`, `remotePredictionGuard`, `join-warp-screen.spec.ts` | `rearmJoinReadiness` historic single-write-path bugs; commit takes ownership of `_recentIntervals`, `_recentCorrFlags`, `_swarmNearbyIds`, `_swarmNearbySwapScratch` (the diagnostics scratches from the perf-floor merge) | `store.rearmJoinReadiness.callerLock.test.ts` (grep test) + `ColyseusClientDiagnostics.recentIntervalsOwnership.test.ts` (asserts these fields not touched by PredictionStateManager.reset) | typecheck + lint + test + bench + e2e:transit + **pnpm e2e:netgate** |
| 20 | `shipIdBinding`, `transitShipIdBinding`, `lingeringPosePreserved`, `SectorSnapshot.test.ts`, `SpatialGrid.test.ts` | Slot-map quadruple disjoint invariant untested | `slotMapInvariants.test.ts` (100 cycles) | typecheck + lint + test + integration:sectorRoom + bench + boot smoke + **pnpm e2e:netgate** |
| 21 | `SnapshotRing.test.ts`, `Weapons.test.ts`, `fireTemporal.test.ts`, `HitPrediction.test.ts`, `WeaponCatalogue.test.ts`, `hitAckContract.test.ts` (post-merge — single hit_ack/DamageEvent path) | Lag-comp rewind golden not captured | `scripts/capture-lag-comp-golden.mjs` + `lagCompRing.golden.json` + `LagCompRing.rewind.test.ts` | typecheck + lint + test + integration:sectorRoom (incl. hitAckContract) + bench + boot smoke + **pnpm e2e:netgate** |
| 22 | `snapshotScheduler.test.ts`, `BinarySwarmBroadcast.test.ts`, `rosterFullWreck`, `abandonToWreck`, `wreckDamage`, `shieldHull`, `warpBroadcasts`, `joinBroadcastGrace` | Per-recipient phase-offset hashing not isolated; wreck-pose-not-in-ring not asserted | `BroadcastScheduler.phaseOffsetDeterminism.test.ts` (pure unit, no E2E) + `LagCompRing.scope.test.ts` | typecheck + lint + test + integration:sectorRoom + bench + boot smoke + **pnpm e2e:netgate** |
| 23 | `AiController.test.ts`, `HostileDroneBehaviour.test.ts`, `src/server/transit/TransitOrchestrator.test.ts`, `BotTransitController.test.ts`, `population.test.ts`, `livingWorldHooks`, `livingWorldDirector`, `droneTargetActiveOnly`, `living-world.spec.ts` | Plan-named `TransitOrchestrator` would collide with existing — RENAMED to `SectorTransitAdapter` | Lint rule: existing `TransitOrchestrator` constructed only in `SectorTransitAdapter.ts` | typecheck + lint + test + integration:sectorRoom + bench + e2e:living-world + boot smoke + **pnpm e2e:netgate** |
| 24 | `App.warpOrchestration.test.tsx`, `boot`, `spawn-select-flow`, `happy-path-ui-switch`, `join-warp-screen`, `layout-slots`, `frameRateCap.test.ts`, `frameRateCap.realCapture.test.ts` | `useWarpOrchestration.ts` depends on `getGameClient()` shape; frameRateCap and touch-device branches preserved; unit `AppBootstrap.frameRateCap.test.ts` mocks the RAF and won't catch a real ordering regression | (existing suite + AppBootstrap suite from commit 2) + **post-build Playwright smoke on emulated 90 Hz device profile** — capture `data-pred-stats rafTick.elapsedMs` distribution for 5s, assert median within ±5% of origin/main pre-refactor capture (committed to `tests/fixtures/rafTick90Hz.json` in commit 25) | typecheck + lint + test + bench + e2e (full chromium incl. heap-growth-gate + combat-heap-growth) + **pnpm e2e:netgate** |
| 25 | n/a | Pre-refactor `SectorRoom.update()` median not captured; per-commit bench rebaseline needed | `scripts/capture-perf-baseline.mjs` + `tests/fixtures/sectorRoomUpdateBaseline.json` + `tests/fixtures/clientFrameLoopBaseline.json` | full bench + integration |
| 26 | `.github/workflows/ci.yml` | CI runs only typecheck+lint+test+build+e2e; integration + bench + heap-growth-gate + perf-baseline + boot smoke local-only | CI workflow update covering: `pnpm test:integration`, `pnpm bench` (against `benchmarks/baseline.json`), `tests/e2e/heap-growth-gate.spec.ts`, `tests/e2e/combat-heap-growth.spec.ts`, `tests/e2e/combat-allocation-profile.spec.ts`, `tests/e2e/feel-test-lockstep.spec.ts`, `timeout 8 pnpm dev:server` smoke | full CI run on draft PR push |
| 27 | n/a | CLAUDE.md anchors stale; doc:code ratio still under-budget | `scripts/audit-claude-md-anchors.mjs` + zone CLAUDE.md updates + 4 architecture decomposition docs; note per-module deep docs deferred | full CI run |

---

## Highest-risk extractions + invariant mapping

| Risk | Invariant | Existing lock | New lock (this PR) |
|---|---|---|---|
| Mount-angle single writer | #12 | `WeaponMountController.test.ts` | ESLint pickTarget/rotateMountToward lock + `scripts/audit-mount-angle-writes.mjs` + `LocalMountAimer.lockstep.test.ts` + `LocalMountAimer.drawnPoseAim.test.ts` |
| Drone POSE one resolution per frame ENFORCED (drones only) | #12 (now load-bearing enforced per `src/client/CLAUDE.md` lines 131–132 + merge `e99d73d`) | `droneOnePoseAcrossFrames.test.ts`, `swarmPoseConsistency.test.ts`, `swarmInterpolation.smoothness.test.ts`, `Reconciler.reconcile.test.ts`, `feel-test-lockstep.spec.ts` | `MirrorUpdater.dronePoseOncePerFrame.test.ts` + `DroneSpriteUpdater.poseConsumption.test.ts` + `BeamRenderer.poseConsumption.test.ts` + `HaloRadar.poseConsumption.test.ts` |
| Mirror non-spatial field preservation | LESSONS.md 2026-05-11 | None | `MirrorUpdater.nonSpatialFieldPreservation.test.ts` (parameterised over EVERY field in `ShipRenderState` + `SwarmRenderState`) |
| Mirror MUTATE-IN-PLACE (do not regress to rebuild) | GC-discipline (merge `8ab9946`, probes 7-8) | `mirrorEntryPooling.test.ts`, `probe8Pooling.test.ts`, `combat-allocation-profile.spec.ts`, `combat-heap-growth.spec.ts`, `heap-growth-gate.spec.ts` | `MirrorUpdater.mutateInPlace.test.ts` (asserts allocations-per-frame ≤ baseline) |
| Snapshot coalescing preserved | GC-discipline (merge probe 6) | `snapshotCoalesce.test.ts` | `SnapshotApplier.coalesceComposition.test.ts` (asserts orchestrator delegates to existing coalesce, does not re-implement) |
| Prediction reset clears full state cluster (incl. correctionSmoothing + inputTickRecovery) | LESSONS.md 2026-05-16 + merge `d77a59f` + `51cac44` | 5 ColyseusClient tests + `correctionSmoothing.test.ts` + `inputTickRecovery.test.ts` + `Reconciler.reconcile.test.ts` | Port all 5 + `PredictionStateManager.resetCoverage.test.ts` + fast-check idempotence |
| Ship-kind catalogue order | #11 | `shipKinds.test.ts`, `BinarySwarmDecoder.test.ts` | `catalogueOrder.test.ts` (dual snapshot + wire round-trip) |
| Swarm binary wire v3 lock | #12 | `BinarySwarmDecoder.test.ts` | `binarySwarmDecoder.version3Lock.test.ts` (v2 throws) |
| Lag-comp rewind | n/a | `SnapshotRing.test.ts` | `capture-lag-comp-golden.mjs` + `lagCompRing.golden.json` + `LagCompRing.rewind.test.ts` |
| Slot-map quadruple disjoint | LESSONS.md | `shipIdBinding.test.ts` partial | `slotMapInvariants.test.ts` (100 cycles) |
| Y-flip in renderer | CLAUDE.md 2026-05-15 | `warpCenter.test.ts` | ESLint Y-flip + plant-y self-test |
| WreckLifecycleCoordinator atomicity | n/a | `rosterFullWreck`, `abandonToWreck`, `lingering` | `wreckLifecycleAtomicity.test.ts` (crash mid-transaction → all-or-none) |
| Single hit_ack/DamageEvent reconcile | merge `fa6f8da` | `hitAckContract.test.ts` (post-merge, 218 LOC) | `CombatFeedbackBridge.singlePath.test.ts` |
| 1Hz HUD dispatch preserved | GC-discipline (step 10) | None for store-level | `gameScalarsSlice.hudDispatchRate.test.ts` |
| Touch-device renderer selection | CLAUDE.md 2026-05-22 | None at App level | `AppBootstrap.touchDevice.test.ts` |
| frameRateCap 10ms early-return-before-`lastFrameTime` ordering | CLAUDE.md 2026-05-22+24 | `frameRateCap.test.ts`, `frameRateCap.realCapture.test.ts` | `AppBootstrap.frameRateCap.test.ts` (asserts `lastFrameTime` not set on skipped RAF) + Playwright post-build smoke on emulated 90 Hz device profile: `data-pred-stats rafTick.elapsedMs` distribution within ±5% of origin/main capture |
| **Netcode-health (netgate) baseline-relative-green** | #8 (AMENDED post-merge) | `tests/netgate/run-netgate.ts`, `tests/e2e/netcode-health.spec.ts`, `eqxLatencyProxy.ts`, `latencyProfile.ts`, `netHealthBudget.ts` | `pnpm e2e:netgate` runs locally before every live-loop-touching commit (16-23) AND in CI per commit 26. Asserts no regression on `rollingCorrRate`, `ticksAhead`, `maxDriftUnits`, `meanDriftUnits`, `droppedSnapshotsRecent`. **The MirrorUpdater + PredictionStateManager extractions are the most likely netgate breakers** — write-at-different-`now` and reset-ordering bugs both surface here first. |
| Field ownership for the 12+ new scratch/pool fields | n/a | source code today | `src/client/net/colyseus/FIELD_OWNERSHIP.md` lands in commit 1 as a reviewer artefact; commits 16-19 reference rows from it; reviewer verifies seams BEFORE extractions land |
| Server boot smoke | Verification protocol | manual | After every server commit |
| Canary fixture toggle | #1 | manual | `scripts/canary-toggle.mjs` |

---

## Sequencing safety nets

- **Commit 2 establishes DI shell early** — AppBootstrap with stub impls; later commits wire real impls. Prevents intermediate commits leaving App.tsx with stale references.
- **Commit 15 lands WreckLifecycleCoordinator BEFORE its underlying collaborators** — initially calls into still-monolithic SectorRoom private methods; commits 20-23 move ownership.
- **Commit 16 ships `SnapshotMessageDispatcher` stubs** — `SnapshotApplier` references `dispatcher.forwardMountAngles`, `forwardCollisionResolved`, `forwardDamage`; commits 17 & 18 fill in real impls.
- **SectorRoom `update()` re-stitched incrementally** — each of commits 20-23 alters `update()` directly; per-commit reviewer note: "this commit moves lines X-Y of update() into <NewCollab>.<method>".
- **`forceBroadcastUntilTick` ownership** — Setters call `broadcastScheduler.extendGrace(serverTick + JOIN_BROADCAST_GRACE_TICKS)`. Reader is `BroadcastScheduler`.
- **`ownerlessShips` Map ownership** — `OwnerlessShipTimers.ts` (~80 LOC) owns it; `WreckLifecycleCoordinator` calls `ownerlessShipTimers.clear(playerId)`.
- **frameRateCap ordering safety** — every commit touching `AppBootstrap` or the RAF loop runs `AppBootstrap.frameRateCap.test.ts`; the test plants `lastFrameTime = now` BEFORE the early-return and asserts the cap fails.

---

## Mechanical-move audit

Total new files: ~110 (was ~94 before this v2; perf-floor merge added work in App.tsx, diagRouter, ColyseusClient that requires more extractions). Reviewer cannot eyeball.

`scripts/audit-mechanical-move.mjs` lands in commit 1: for each `<oldFile, newFile, functionName>` triple in `refactor-manifest.json`, compares SHA256 of function body (stripped of whitespace + comments). Reports edited extractions for explicit reviewer attention. PR description includes a "Pure moves: N. Edited extractions: M" table.

---

## Reviewer flight plan

1. `src/core/contracts/*.ts` — the 6 new contracts.
2. `src/shared-types/messages/` + `shipKinds/` — the wire.
3. `refactor-manifest.json` + mechanical-move output — confirms pure moves.
4. `benchmarks/baseline.json` + `tests/fixtures/sectorRoomUpdateBaseline.json` — confirms perf gates.
5. Collaborators alphabetical under each zone.
6. Orchestrators last: `SectorRoom.ts`, `ColyseusClient.ts`, `PixiRenderer.ts`, `App.tsx`.

---

## Two-PR fallback (escape hatch)

If review exceeds >15 comments per orchestrator, split:

- **PR1**: shared-types + core + tooling + server (commits 1, 3, 4, 5, 9, 15, 20-23, 25, 26).
- **PR2**: client + app + remaining tooling (commits 2, 6-8, 10-14, 16-19, 24, 27).

PR1 first; CI tightening (26) lands in PR1.

---

## Verification protocol

Run in order; any failure halts the PR.

1. `pnpm typecheck` — all four tsconfigs.
2. `pnpm lint` — including updated store glob + Y-flip rule + pickTarget/rotateMountToward lock + `scripts/canary-toggle.mjs`.
3. `pnpm test` — full unit suite incl. new tests from the matrix.
4. `pnpm test:integration` — Vitest integration (now in CI per commit 26).
5. `pnpm bench` — against `benchmarks/baseline.json` (commit 25 baseline); SectorRoom.update() median + client frame loop within ±5%.
6. `scripts/audit-mount-angle-writes.mjs` — no unauthorised mount-angle writes.
7. `scripts/audit-claude-md-anchors.mjs` — no dangling file:line refs.
8. `scripts/audit-mechanical-move.mjs` — committed to PR description.
9. `timeout 8 pnpm dev:server` — clean boot.
10. `pnpm e2e --project=chromium --reporter=line` — full E2E. Spec watch-list: `heap-growth-gate`, `combat-heap-growth`, `combat-allocation-profile`, `multi-mount-beam`, `combat`, `weapon-switching`, `feel-test-lockstep`, `feel-tuning`, `drone-laser-smoothness`, `laser-smoothness`, `rotate-jitter`, `transit-rearm-readiness`, `transit-arrival-drift`, `warpBurst`/`warpCenter`/`warpDetach`, `living-world`, `halo-radar`.
11. `pnpm e2e:netgate` — netcode-health baseline-relative-green (invariant #8 amendment). Boots two worktrees + two vite servers; ~10-12 minutes wall-clock. Asserts no regression on `rollingCorrRate`, `ticksAhead`, `maxDriftUnits`, `meanDriftUnits`, `droppedSnapshotsRecent`. **MUST pass before merge** for any live-loop-touching PR.
12. Manual playtest (single-host two-tab): connect → spawn → fire primary → damage numbers + hit feedback; mount-aim with mouse, no double-write jitter; shield collider swap → hull-expose → destroy → wreck appears; drone interpolated pose, no teleport on snapshot apply; warp/transit arrival, no drift, no rearm-readiness lock; diag overlay endpoints respond; Halo radar tracks off-screen entities; 90 Hz device processes ~90 fps (frameRateCap not regressing); touch device uses main-thread renderer.

---

## Token-savings estimate

Design-time estimates (a real agent loads adjacent context; assume optimistic numbers are an upper bound, realistic savings 65–75%):

| Task | Before (LOC) | After (LOC) | Reduction (upper bound) |
| --- | --- | --- | --- |
| Add a new weapon kind | ~12095 (SectorRoom 4348 + ColyseusClient 4237 + PixiRenderer 2272 + shipKinds 738 + messages 525) | ~1980 | ~84% |
| Tune drone behaviour | ~9323 (SectorRoom + ColyseusClient + shipKinds) | ~960 | ~90% |
| Warp/transit work | ~6620 (ColyseusClient + SectorRoom + App.tsx + messages) | ~640 | ~90% |
| Renderer feature | 2272 monolith | ~400–600 | ~75% |
| Perf/GC investigation | ~5500 (ColyseusClient + App.tsx + PixiRenderer + frameRateCap + perfStats) | ~800 | ~85% |

Combined orchestrator footprint: 12120 LOC today → ~1440 LOC after (SectorRoom 450 + ColyseusClient 350 + PixiRenderer 340 + App 300).

---

## Docs updates (commit 27)

- `src/server/CLAUDE.md` — "Sector room subsystems" listing 17 new files; obsolete the "Server-authoritative mount rotation" paragraph; `SectorTransitAdapter` ↔ `src/server/transit/TransitOrchestrator` diagram.
- `src/client/CLAUDE.md` — "ColyseusClient subsystems", "PixiRenderer subsystems", "App composition", store-slice layout; obsolete the warp section's `PixiRenderer.ts` line-number references; preserve the LOAD-BEARING one-pose-per-frame paragraph; preserve the touch-device + frameRateCap entries.
- `src/core/CLAUDE.md` — one-line semantics for 6 new contracts.
- Root `CLAUDE.md` — file-size budget (≤400 LOC target, ~500 ceiling); refresh god-file list; cite the asteroid carve-out for `interpolateSwarmPose`; cite the GC-discipline invariant (mutate-in-place mirror, pooled scratches, 1Hz HUD dispatch).
- `docs/architecture/sector-room-decomposition.md`, `colyseus-client-decomposition.md`, `pixi-renderer-decomposition.md`, `store-slices.md` — new.
- Update `docs/architecture/weapon-mounts.md` (pickTarget/rotateMountToward, not `tickSlot`).
- Update `docs/architecture/drone-snapshot-interpolation.md` to reference `MirrorUpdater` (drones only) + asteroid carve-out + `resolveDroneDisplayPose` consumer rule.
- `docs/LESSONS.md` — append: `tickSlot` documentation-vs-reality gotcha; `Object.values(SHIP_KINDS)` already deterministic; 5 tests pierced private predWorld/reconciler fields; `convertShipToWreck` 8-collaborator transaction; CI did not run integration/bench/netgate until commit 26; ColyseusClient +972 LOC from perf-floor merge required v2 of this plan; one-pose-per-frame went from claimed → ENFORCED mid-plan; touch-device + frameRateCap branches must be preserved across the App.tsx split; v2-of-this-plan initially listed `snapshotCoalesce.ts` and `mirrorEntryPooling.ts` as "compose existing module" when they are inline patterns (only the regression tests are modules) — extraction commits must port the inline code AND re-point the existing test (lesson: post-merge "the test exists, therefore the module exists" is wrong); `HitPredictionLedger` is in `@core/combat/HitPrediction.ts` (the pure ledger), not `@client/combat/HitPrediction.client.ts` (which exports reconcile helpers — different concern); the `laser_fired` pooled per-fire entry handles REMOTE shots and belongs with SnapshotApplier, not the LOCAL-player GhostProjectileManager; `GalaxyOverviewScreen.tsx` at 532 LOC was deliberately deferred (not a live-loop concern, lower token ROI); the netgate gate (invariant #8 amendment) is part of "done" for any live-loop change — `pnpm e2e:netgate` baseline-relative-green is non-negotiable.
- Refresh `MANIFEST_APPARATUS.md`.
- Per-module deep docs deferred to follow-up PR (root invariant #10 partially honoured — 4 architecture docs ship now, ~10 module-level docs in follow-up).
