# CLAUDE.md — src/client (Eyes and Ears)

`src/client` is everything the player sees and hears. It is **not** the source of truth — the server is. The client hides latency with prediction and ghost projectiles, and defers to the server whenever the two disagree.

Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/client/`: the server `colyseus` package (use `colyseus.js`), `@colyseus/ws-transport`, Node-only / persistence APIs (`better-sqlite3`, `express`, `pino`, `worker_threads`, `node:worker_threads`, `fs`, `node:fs`, `http`, `node:http`), or anything under `src/server/**`.

Allowed: `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand`, `src/core`, `src/shared-types`.

---

## Zustand Purity (invariant #2, strictly enforced)

- **No spatial fields in the Zustand store.** Lint-blocked keys in `src/client/state/store.ts`: `x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`.
- Zustand holds discrete UI state (`connectionStatus`, `sectorName`, `hullPct`, `ammo`, `sectorAlert`, `playerId`, dev-overlay toggles, HUD flags), never anything that updates every frame; spatial state lives in the render mirror that Pixi polls. Why: [renderer-worker](../../docs/architecture/renderer-worker.md#client-rules-in-detail).

---

## Renderer Rules

- `PixiRenderer` implements `IRenderer` from `src/core/contracts/`.
- The renderer **polls** the state mirror every frame. It **never** subscribes to the event bus for positions. Lint blocks `bus.on` imports inside `src/client/render/`.
- Camera (`pixi-viewport`) follows the local ship. No global-space UI overlay in Pixi — HUD elements are React/MUI outside the Pixi surface.
- **Starfield:** the farthest star layer is FULL at the camera's zoom floor (every capital floor too) and tiles the whole viewport there; a new floor must keep both. Locks: `StarfieldBackground.test.ts`, `galaxyStarfield.test.ts`, `lodStarfield.coverage.test.ts`.
- **Zoom-in cap:** the camera never zooms in past the point where the piloted hull fits on screen (`zoomCeilingForView`); the follow camera has no look-ahead, so re-check the cap before adding one. Lock: `tests/unit/hullZoomCeiling.test.ts`. Detail for both: [ship-scale](../../docs/architecture/ship-scale.md#client-rules-in-detail).
- **Spectator:** `pilotMode` is the only store field; the free-roam camera pose lives in the renderer `Camera`, never the store. The death flip mounts no UI (the build palette is pre-mounted). While spectating, the own parked hull is never re-seeded or re-predicted from the schema. **Pilot swap** goes over the live room (no rejoin): despawn the local predWorld body and null the `Reconciler` so `welcome` re-anchors; the glide is a one-shot `Camera.glideTo`. Netgate required. Locks: `spectatorMode.test.ts`, `BottomControlPanel.test.tsx`, `spectateOwnHullDrawnPose.test.ts`, `ColyseusClient.spectateRace.test.ts`, `ColyseusClient.pilotSwap.test.ts`, `Camera.test.ts`. Detail: [spectator](../../docs/architecture/spectator-and-construction-mode.md#client-rules-in-detail).
- **Cinematic camera:** precedence is director > glide > follow > pan; the director reads rendered poses (never re-interpolates); keyframes never touch Zustand; overlay/HUD hiding goes only through `?cleanworld` / `?hud` and `SET_HUD_OVERLAYS`. Locks: `CameraDirector.test.ts`, `hudMode.test.ts`, `tests/e2e/cinematic-camera.spec.ts`. Detail: [cinematic-camera](../../docs/architecture/cinematic-camera.md#client-rules-in-detail).
- **Upgrades, level, mounts:** the client never predicts a stat upgrade — it re-anchors from the authoritative `statAlloc` via the shared `deriveStatMultipliers`. Ship level, activated mounts and structure level are slim snapshot fields mirrored at one site; mount geometry comes from the shared `resolveInstanceMounts`, never the wire. Netgate required. Locks: `localStatAlloc.test.ts`, `snapshotRemoteSync.shipLevels.test.ts`, `slots.dynamicMounts.test.ts`, `EntityStatsPanel.test.tsx`. Detail: [leveling](../../docs/architecture/leveling-and-upgrades.md#client-rules-in-detail), [weapon-mounts](../../docs/architecture/weapon-mounts.md#client-rules-in-detail).
- **Collision changes need an E2E:** any change to how obstacles or remote ships are synced, reset or lerped in `ColyseusClient.ts` ships with a `tests/e2e/` spec that fails if the change is reverted. Detail: [collision-layers](../../docs/architecture/collision-layers.md#client-rules-in-detail).
- **Every collidable entity is in predWorld:** a new entity the local player can collide with or shoot registers a predWorld body (prefixed id, spawn, `setShipState` per snapshot, despawn, tracked id set); the server iterates it in `advanceProjectiles`, `handleFire`'s hitscan and `applyDamage`. Never render remote ships from `remoteHistory`. Detail: same guide.
- **Pose-core entities construct through `ClientEntityFactory`:** an unrecognised kind returns `null` and is skipped; the swarm caches (`predSwarmKeys`, `_movingSwarmKeys`, `_swarmBodyKeyCache`, `_aiRegisteredIds`) stay in `ColyseusClient`, never the factory. Detail: [generic-entity-pipeline](../../docs/architecture/generic-entity-pipeline.md#client-rules-in-detail).
- **Y-flip:** game coords handed to the Pixi scene graph flip (`pixiY = -gameY`), but `art/fx` APIs that take "game space" flip themselves — never flip twice; never scale the warp filter centre by `renderer.resolution` (a phone-only renderer bug is a frame mismatch until on-device evidence says otherwise). Locks: `PixiRenderer.warpCenter.test.ts`, `navalShellBursts.test.ts`. Detail: [visual-effects](../../docs/architecture/visual-effects.md#client-rules-in-detail).
- **Halo radar:** `HaloRadar.update()` allocates nothing; its decisions stay pure and unit-locked under `halo/`; on-screen contacts are excluded at candidate build, never by a timer. Locks: `halo/*.test.ts`, `ring-indicator-*.spec.ts`. Detail: [off-screen-indicators](../../docs/architecture/off-screen-indicators.md#client-rules-in-detail).
- **Far-zoom icons:** keep `FAR_ICON.fadeStartPx` below a fighter's size at the spawn zoom. Locks: `FarZoomIcons.test.ts`, `tests/e2e/capital-helm.spec.ts`. Detail: same guide.
- **Warp burst:** exactly one flash per transit, on arrival (`warpEventFiresBurst`); never add a warp-out or spool-start burst. Lock: `PixiRenderer.warpBurst.test.ts`. Detail: [warp-visual](../../docs/architecture/warp-visual.md#client-rules-in-detail).
- **Pre-welcome guard:** any predWorld spawn in `syncMirror()`'s remote-ship branch is gated on `localId !== null`. Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md#client-rules-in-detail).

---

## Renderer worker boundary

On desktop the renderer runs in a Web Worker via `OffscreenCanvas`. How it works: [renderer-worker](../../docs/architecture/renderer-worker.md).

- **The wire format is [`render/worker/protocol.ts`](render/worker/protocol.ts):** structured-cloneable variants only — no DOM handles, Pixi handles or functions. Lock: `render/worker/protocol.test.ts`.
- **Forbidden imports inside `src/client/render/worker/**`** (CI-enforced): `react`, `react-dom`, `@mui/*`, `@emotion/*`, `zustand`. State crosses the boundary via the protocol.
- **`RenderMirror` is the per-frame wire payload:** any new field stays structured-cloneable.
- **`RendererFeedback` is a closed set:** a new field needs a phase-gate review (it grows every frame's postMessage) and is threaded through all three worker sites (`renderer.worker.ts` FEEDBACK post, `WorkerRendererClient.emptyFeedback`, its FEEDBACK handler). Pointer-cadence renderer state never goes to Zustand. Detail: [renderer-worker](../../docs/architecture/renderer-worker.md#client-rules-in-detail).
- **No `pixi-viewport` inside the worker** (no DOM): the worker uses the hand-rolled `Camera`, fed by pointer/wheel events forwarded from the main thread.
- **Fallback:** without OffscreenCanvas, `WorkerRendererClient` returns the main-thread `PixiRenderer`; production code never assumes worker rendering.
- **Touch devices default to the main-thread renderer** (`?worker=1` / `?worker=0` override). Don't flip the touch default back without a fresh on-device smoke measuring `raf_gap` clusters. Detail: [renderer-worker](../../docs/architecture/renderer-worker.md#history).
- **Galaxy map:** `GalaxyMapLayer` lives worker-side, driven by the `syncGalaxy*` messages; hover is a deduped `GALAXY_HOVER` back-channel sent only when the hovered sector changes. Galaxy poll hooks live in `app/`, never a top-level `src/client/galaxy/` dir (it collides with the `/galaxy` Vite proxy). Detail: [living-galaxy](../../docs/architecture/living-galaxy.md#client-rules-in-detail).
- **Galaxy landing reveal:** the opaque `galaxy-loading` gate waits for ALL badge sources (snapshot, presence, roster; the snapshot alone when logged out); every source is seeded at overlay install; each poll flips its loaded flag in `finally`, never only on success. Locks: `tests/e2e/galaxy-landing-reveal.spec.ts`, `useGalaxyStats.test.tsx`, `useGalaxyPresence.test.tsx`, `rosterPoller.test.ts`. Detail: same guide.

---

## UI Scope and panels

- **No raw ids in player-facing UI:** show "you", the owner's resolved name, "Unknown" or a kind/role; ids live only in hidden `data-*` attrs and logs. Detail: [mobile-layout](../../docs/features/mobile-layout.md#client-rules-in-detail).
- **React + MUI** for out-of-game UI and overlays, **Pixi** for the in-game surface; never MUI inside the canvas, never HUD numbers in Pixi.
- **Sizing: start tiny, grow on request** (icons 24–36 px, text 9–11 px, `maxWidth="xs"`, `size="small"` buttons; 44 px only for primary confirms). Detail: same guide.
- **A panel outside the Slot system that must beat the HUD is `<Portal>`'d to `document.body`;** `placeInspector` keeps the WHOLE inspector on screen (never clamp only the anchor). Detail: same guide.
- **One Pixi galaxy renderer,** `GalaxyMapLayer` (`selector` / `overlay`) on the shared canvas; never a second Pixi `Application`. Detail: [single-canvas-galaxy](../../docs/architecture/single-canvas-galaxy.md#client-rules-in-detail).
- **Galaxy map:** territories group by owner (`resolveSectorOwner`); hover tooltip desktop-only; each entity type's look is one row in `render/entityVisuals.ts`. Locks: `sectorOwnership.test.ts`, `entityVisuals.test.ts`, `galaxy-sector-drawer.spec.ts`. Detail: [living-galaxy](../../docs/architecture/living-galaxy.md#client-rules-in-detail).
- **A poller feeding a widely-subscribed store field skips unchanged replies** (`rosterPoller` → `shipRoster`). Detail: same guide.
- **`getGameClient()` mirror reads are low-cadence only,** never per-frame. Detail: [configurable-arrival](../../docs/features/configurable-arrival.md#client-rules-in-detail).
- **Drawer tabs** (Trade, Factions, Contracts) poll only while shown and rebuild only from their replies (#16); toasts are accelerators. Locks: `tradeView.test.ts`, `FactionsTab.test.tsx`, `ContractsTab.test.tsx`. Detail: [economy-and-trade](../../docs/architecture/economy-and-trade.md#client-rules-in-detail).
- **No top-level `src/client/<dir>/` named like a Vite proxy path** (`trade/`, `galaxy/`). Lock: `clientDirProxyCollision.test.ts`.
- **Cargo and wallet** come only from the own-ship snapshot (#16), written to Zustand on change. Detail: [loot-and-cargo](../../docs/features/loot-and-cargo.md#client-rules-in-detail).
- **Every client → server sender passes its server schema** (`tradeClientWireParity.test.ts`, `teleportClientWireParity.test.ts`).

---

## Layout Slot System

In-game React overlays are positioned via **named slot anchors** ([layout/](layout/)), never hand-placed. Full story: [mobile-layout](../../docs/features/mobile-layout.md#client-rules-in-detail).

- **Anchors** live in [layout/anchors.ts](layout/anchors.ts). Adding one is fine; changing an existing anchor's CSS is a code-review prompt.
- **Widgets render via `<Slot anchor="...">`** and never set their own `position`, `top/left/right/bottom`, `zIndex` or safe-area insets; z-tiers come from [layout/zIndex.ts](layout/zIndex.ts) and only anchor hosts use them. (The structure placement banner is the one widget positioned over the world.)
- **Drawer:** never a `SwipeableDrawer` (its global touch listeners wreck mobile RTT); `keepMounted` stays on; snapshot-rate work in a drawer tab gates on `drawerTab === '<id>' && isDrawerOpen`.
- **Keep these surfaces:** don't delete the `HudTestAttributes` mirrors without auditing every spec that reads them, nor `ProfileModal.tsx` / `SettingsModal.tsx` / `AvatarMenu.tsx` (the desktop path).
- **Logout** has one definition, `useLogout()` ([auth/useLogout.ts](auth/useLogout.ts)); every logout entry point routes through it. Locks: `tests/e2e/avatar-menu-logout.spec.ts`, `useLogout.test.tsx`.
- **Orientation:** portrait works by default; landscape is opt-in via `<FullscreenToggle>`. Never reintroduce a first-gesture orientation lock or a portrait-block overlay.
- **Speed dial:** discrete tap actions go in the bottom-right `SpeedDial`; held controls (joystick, FIRE, BOOST) stay dedicated. Dial actions also bind `onTouchStart` (a second touch never gets a click) and drop the trailing synthesized click; a test opens the dial before clicking an action. Locks: `tests/e2e/speed-dial.spec.ts`, `tests/e2e/speed-dial-multitouch.spec.ts`.
- **Structure placement:** only the discrete `placementKind` lives in Zustand; the ghost pose rides `RenderMirror.pendingPlacementPreview`; pointer→world conversion stays in the renderer (it owns the `Camera`) and returns via `RendererFeedback`. Desktop click and touch Confirm share `commitChosenPlacement`; `contextmenu` cancels only for a mouse gesture. Structures draw `structureRenderVerts` (the collider's Y-flip), never raw points. Locks: `structure-placement-ghost.spec.ts`, `structurePlacementClient.test.ts`, `contextMenuPlacement.test.ts`, `spriteBuilders.test.ts`, `buildCategories.test.ts`. Detail: [structures](../../docs/architecture/structures-and-power-grid.md#client-rules-in-detail).
- **Grid render:** the placement preview runs the server's `canConnect`, allocates nothing per frame, and draws no line to another owner's structure; an owner shows as "you", their display name or "Unknown", never a raw playerId. Locks: `ConnectorRenderer.placementPreview.test.ts`, `EntityStatsPanel.test.tsx`. Detail: same guide.
- **`useIsCompact()` and `isTouchDevice()` are independent axes** — don't fuse them.
- **Phase machine lives in Zustand:** the initial phase is `galaxy-map`; spawning is auth-gated on the sector pick. Lock: [tests/e2e/galaxy-landing-flow.spec.ts](../../tests/e2e/galaxy-landing-flow.spec.ts).
- Regression lock: [tests/e2e/layout-slots.spec.ts](../../tests/e2e/layout-slots.spec.ts).

---

## Audio

- **Howler** is the only audio concretion, behind an `IAudio` implementation. TiDi pitch-shift is `howl.rate(serverClockRate)`.
- All SFX trigger off bus events (`LASER_FIRED`, `ENTITY_DESTROYED`, `ENTITY_WOKE`), never polling.

---

## Client Prediction + Ghost Projectiles

How it works: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md#client-rules-in-detail), [drone-snapshot-interpolation](../../docs/architecture/drone-snapshot-interpolation.md#client-rules-in-detail).

- Prediction and ghosts are presentation only. They must not influence authoritative state or be visible to other clients.
- **No client drone brain:** drones are pure snapshot-interpolated; `_aiController` is a hostility ledger only and is never ticked.
- **One paradigm for every remote moving entity:** remote ships, drones, scrap and wreck pieces get predWorld bodies anchored to the latest server state each snapshot (`preResetRemoteShips` / `anchorRemoteSwarmBodies`) and advanced with the local prediction; nothing re-poses them per frame; local ray tests hit drones/scrap/wrecks at the drawn pose (`DisplayPoseHitscan`). Never add a drone-specific collision path, never lock scrap, never sweep a dying capital's sprite directly; wreck pieces reuse the parent kind's baked art, never a new bake. Locks: `meleeDroneContactPrediction.test.ts`, `snapshotRemoteSync.remoteEntityAnchor.test.ts`, `displayPoseHitscan.test.ts`, `dyingHullHold.test.ts`.
- **One pose per frame:** `interpolateSwarmPose` runs once per drone per frame, in `updateMirror`; every consumer reads the resolved pose via `resolveEntityDisplayPose` and never re-interpolates (asteroids excepted). `POSE_RING_DEPTH` covers `DISPLAY_DELAY_MS` at the binary cadence. Locks: `swarmPoseConsistency.test.ts`, `droneOnePoseAcrossFrames.test.ts`, `swarmInterpolation.smoothness.test.ts`.
- **Wall-clock-anchored input loop:** `tickPhysics()` derives `targetTick` from wall time; never re-introduce an accumulator-with-cap; a backlog over `STALL_SKIP_TICKS` is skipped, not replayed. Lock: `tests/e2e/loading-catchup.spec.ts`.
- **RAF work cap:** keep `DEFAULT_MIN_FRAME_INTERVAL_MS` between ~8.3 and ~11 ms; a skipped RAF never updates `lastFrameTime`. Locks: `tests/unit/frameRateCap.test.ts`, `tests/unit/frameRateCap.realCapture.test.ts`. Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md#history).
- **Ghost mirror cleanup:** `GhostManager.update(out)` deletes from `out` every ghost it removes (the only path that clears ghosts from `mirror.projectiles`). Ghosts never declare destruction server-side. Lock: [combat/GhostProjectile.test.ts](combat/GhostProjectile.test.ts).
- **Sector handoff resets prediction state:** all prediction-window state, the `Reconciler` and the local predWorld body re-initialise in `resetPredictionState()`, and join readiness re-arms via `rearmJoinReadiness()`; new prediction-feeding state is reset there or commented why it is safe to inherit. Locks: `net/ColyseusClient.resetPredictionState.test.ts`, `net/ColyseusClient.transitArrivalDrift.test.ts`, `state/store.rearmJoinReadiness.test.ts`.

---

## Snapshot transport

How it works: [webrtc-datachannel-snapshot-transport](../../docs/architecture/webrtc-datachannel-snapshot-transport.md#client-rules-in-detail).

- **DataChannel is default-on for players, off under automation** (`webrtcEnabledFromSearch`); keep the webdriver gate — the E2E suite and the netgate must measure the WS path.
- **Snapshot apply happens at RAF tick, never inline in `onMessage`:** both transports enqueue into `SnapshotCoalescer`, drained in `tickPhysics`. Coalescing never drops wreck deltas (`carryWreckDeltas`, `carriesWreckDeltas`).
- **The DC path stores bytes and decodes once per RAF:** `dc.message` calls `_receiver.enqueueBinary(buf)`, never `handleBinary`. Lock: `net/dataChannelTransport.test.ts`.
- **Network estimates use wire-arrival time, never apply time** (`intervalMs` from `_lastSnapshotRecvAtMs`). Lock: `tests/unit/snapshotPerfStats.intervalMs.test.ts`.
- **`onStateChange` is hybrid:** the first per RAF runs `syncMirror` inline, the rest defer to the next `tickPhysics` (at most 2 per RAF); don't switch to full-defer.

---

## Input, weapons and fire control

- **Input throttling:** skip an input send only when current AND last-sent states are fully idle; held controls re-send every tick (audit any new throttled stream the same way). Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md#client-rules-in-detail).
- **Ships fire their catalogue loadout:** the pilot picks a slot (`activeSlotId` in Zustand), never a weapon type; the server ignores a claimed `weapon`. Slot cooldown is the max over its mounts.
- **Energy is predicted** (`predEnergy`), reconciled each snapshot, shown via direct DOM writes (never per-frame Zustand); local fire and boost gate on `canAfford`. Locks: `tests/e2e/energy-bar.spec.ts`, `tests/e2e/weapon-switching.spec.ts`. Detail: [fire-control](../../docs/architecture/fire-control.md#client-rules-in-detail).
- **Every group fires only at a LOCKED target;** `fcFireTick` is the only client fire path. There is one HUD, `hud/GameHud.tsx`.
- **Lock line:** the pick uses the shared `lockLineScore`, alloc-free per candidate; `lock_track` carries `b` and the server re-checks it (#15). Lock: `ColyseusClient.lockGuide.test.ts`.
- **`fcTickMountAngles` is THE client mount-angle path** (#12); the client sends no `aim` input. Lock: `ColyseusClient.liveBeamMountAimPose.test.ts`.
- **Contacts overview:** only `contactsOpen` is in Zustand; never add a `contactsOverview.ts` beside `ContactsOverview.tsx` (case-insensitive FS). Detail: [contacts-overview](../../docs/features/contacts-overview.md#client-rules-in-detail).
- **Boost is a facing-direction impulse:** energy-gate the boost bit before `predWorld.applyInput` AND the send (per-tick and sentinel paths). Locks: `applyShipInput.boost.test.ts`, `tests/e2e/boost-facing.spec.ts`. Detail: [auto-fire-and-boost](../../docs/features/auto-fire-and-boost.md#client-rules-in-detail).

---

## Mounts and beams

Detail: [weapon-mounts](../../docs/architecture/weapon-mounts.md#client-rules-in-detail).

- **`mountAngles` is indexed by catalogue mount order** (`kind.mounts`) by every writer and reader, never slot-local order.
- **The per-frame `mirror.ships.set()` rebuilds preserve non-spatial fields** (`kind`, `displayName`, `mountAngles`); a new non-spatial `ShipRenderState` field goes into BOTH rebuild sites (`updateMirror`, `syncMirror`) or it is wiped at 60 Hz.
- Aim-line length comes from `aimLineLengthForMount` (the weapon's reach). Lock: `aimLineLength.test.ts`.
- **Beam sprite length is `scale.x = worldLen / texture.width`.** Drawn-length tests inject a real-width texture (headless falls back to 1×1). Locks: `BeamSpritePool.solidTaper.test.ts`, `tests/e2e/laser-falloff-probe.spec.ts`.

---

## Structures

Detail: [structures](../../docs/architecture/structures-and-power-grid.md#client-rules-in-detail).

- **Footprints:** draw and pick structures by the catalogue footprint box, like the server. Placement rotation is module state in `structurePlacementClient.ts`, never Zustand. Lock: `spriteBuilders.test.ts`.
- **Connector web:** steady visuals go on `ConnectorRenderer.staticGfx` and feed `staticSignature`; anything driven by `nowMs` goes on the per-frame `gfx`.
- **predWorld streams structures and walls by distance** (`predStructureStreaming.ts`); never add every structure. Off-screen structure sprites are hidden.
- **Shield walls are derived in one place,** `visitDerivedWalls` (`structures/derivedWalls.ts`); never read `shieldWallTo` for walls.
- **Structures come from room state** (`syncStructures` + `decodeStructureState`); the snapshot carries only `structureTargets`; the binary refresh never deletes structures. Locks: `structureStateWire.test.ts`, `BinarySwarmDecoder.test.ts`.
- **Mines** come only from room state (`syncMines`); `mine_detonated` is an accelerator. Detail: [mine-layer](../../docs/features/mine-layer.md#client-rules-in-detail).
- **Turret-vs-fence hint** toggles by direct DOM write, on change only. Locks: `fenceFireHint.test.ts`, `tests/e2e/turret-fence-hint.spec.ts`. Detail: [shield-fence](../../docs/features/shield-fence.md#client-rules-in-detail).
- **Build menus** label kinds through the pure `buildEntry(kindId, counts)`; counts come only from `packed_stock` replies. Locks: `packedStock.test.ts`, `BottomControlPanel.test.tsx`. Detail: [blueprints](../../docs/features/blueprints.md#client-rules-in-detail).
- **Teleporters:** panels read the mirror at 4 Hz (no Zustand); a `poseEpoch` change re-seeds the local body (no reconcile); tolls are offers, not state; gate-disabled input goes through the shared `gateDisabledInput`. Detail: [teleporters](../../docs/features/teleporters.md#client-rules-in-detail), [alien-gates](../../docs/features/alien-gates.md#client-rules-in-detail).

---

## Combat feedback

- **Damage numbers / health bars:** `pendingDamageNumbers` / `pendingHealthBarHits` are drain queues consumed once per frame; one number bucket per target (nearby hits coalesce); a dead target's number takes no late hit (`markDead`). Locks: `damageNumberCoalesce.test.ts`, `ColyseusClient.damageAfterDeath.test.ts`, `damage-number-lifetime.spec.ts`. Detail: [visual-effects](../../docs/architecture/visual-effects.md#client-rules-in-detail).
- **Incoming naval fire** is mirror-derived (#16), renderer-only (#2), alloc-free (#14), radius from `shipTuning` (#18). Shells burst only on `shell_end`; a naval hit's FX wait for it (`navalHitHold.ts`). Lock: `ColyseusClient.navalHitFlash.test.ts`. Detail: [off-screen-indicators](../../docs/architecture/off-screen-indicators.md#client-rules-in-detail), [shell-events](../../docs/architecture/shell-events.md#client-rules-in-detail).
- **Helm course marker** rides `RenderMirror.helmCourse`, never Zustand. Detail: [capital-ships](../../docs/features/capital-ships.md#client-rules-in-detail).
- **Shield/hull:** `shieldPct` tweens by CSS, no JS loop; percentages use the event's per-kind max; the predWorld shield swap follows only the authoritative shield-down, one site for drones (`syncSwarmIntoPredWorld`); shield visuals draw at the collider radius (`shieldBubbleRadiusForEntity`). Lock: `shieldColliderParity.test.ts`. Detail: [shield-hull](../../docs/features/shield-hull.md#client-rules-in-detail).
- **Patrol faction tint** is set only at the one tint site in `swarmSpriteUpdater`. Lock: `swarmSpriteUpdater.factionTint.test.ts`. Detail: [factions](../../docs/architecture/factions.md#client-rules-in-detail).

---

## Game time, identity, code shape

- **Game time:** `gameClock` speed comes only from the snapshot `timeScale`. Tick math, display delays and world motion (`gameFrameMs()`) use game time; networking, smoothing, camera and UI use wall time; effects read `fxNow()`. Locks: `ColyseusClient.timeScale.test.ts`, `swarmInterpolation.timeScale.test.ts`, `FxExplosions.timeScale.test.ts`. Detail: [game-time-scale](../../docs/architecture/game-time-scale.md#client-rules-in-detail).
- **Identity:** read the playerId only through `identity/token.ts` (`loadStoredPlayerId()`); never use the Colyseus `sessionId` as a durable id. The mirror, predWorld and reconciler are playerId-keyed; `handleSnapshot` translates the `shipInstanceId`-keyed wire at its top. Detail: [player-identity](../../docs/architecture/player-identity.md#client-rules-in-detail).
- **Sprite-update decisions** (create / rebuild / reposition / skip) are pure functions in `render/spriteUpdateDecisions.ts` with unit and fast-check tests; never inline a new branch in `PixiRenderer.ts`. Detail: [generic-entity-pipeline](../../docs/architecture/generic-entity-pipeline.md#client-rules-in-detail).
- **Test layers:** `*.test.tsx` runs under jsdom, `*.test.ts` under node. Detail: [e2e-framework](../../docs/architecture/e2e-framework.md#unit-and-component-test-layers).

---

## Effects and art

- **Effects:** `EffectsService` is built only in `PixiRenderer.init`; `ColyseusClient` never imports it (triggers ride `pendingEffectTriggers`; a new one-shot queue extends `perFrameTriggers.ts`); `tick` runs inside `update` after `updateSwarmSprites`. Detail: [visual-effects](../../docs/architecture/visual-effects.md#client-rules-in-detail).
- **Quality tiers** are pulled per frame; `PerfMonitor` pushes only on a tier change. Locks: `EffectsBudget.test.ts`, `transitResetEffects.test.ts`.
- **Engine exhaust** is particles only; the emitter gets a GAME-space pose (`entityPoseFromSprite`); never re-add ship-velocity inheritance. Locks: `entityPoseFromSprite.test.ts`, `engine-particles-probe.spec.ts`.
- **Warp filters:** `WarpFilterChain.applyQuality` is the one attach/detach site; never re-disable the chain wholesale — find the active tier first. Detail: [warp-visual](../../docs/architecture/warp-visual.md#client-rules-in-detail).
- **Sector trips are the loading screen:** a transit raises no curtain or `WarpScreen`, nothing fades or cuts (stretch the trip instead); `stepTravel` writes the local mirror entry LAST; a jump mid-trip adds to `mirror.travelJumpX/Y`. Detail: [travel-state](../../docs/architecture/travel-state.md#client-rules-in-detail).
- **Scrap** is an UNLOCKED, drone-like predWorld body at `SCRAP_DEFAULT_MASS`; its geometry is looked up by `(parentShipKind, componentIndex)`, never sent. Lock: `scrapClientLeaf.test.ts`. Detail: [composite-ships-and-scrap](../../docs/architecture/composite-ships-and-scrap.md#client-rules-in-detail).
- **GPU-lit art:** lit maps go on **data** atlas pages, never canvas pages; every lit mesh registers with `litPass` (alloc-free); Baked stays byte-identical to the old look. Detail: [gpu-lit-ships](../../docs/architecture/gpu-lit-ships.md#client-rules-in-detail).

### Machined art

Detail: [art-direction](../../docs/architecture/art-direction.md#client-rules-in-detail).

- **Bump `FORGE_VERSION`** with any forge output change and **`FX_VERSION`** with any fx generator change. Locks: `machinedArt.test.ts`, `fxTextures.lock.test.ts`.
- **`ArtService`** handles are reused, checked per frame; ship sprites switch art only in `art/shipArtSprites.ts`; sprite maps hold `Container`s, never assume `Graphics`. Look specs pass `?art=machined` / `?fx=new`.
- **Backdrop positions tied to game coords flip Y** (`cam.center` is Pixi space); never lay the sky out per sector size.
- **Anything that sets the camera scale handles the speed-zoom factor** as `Camera.tick` / `setZoom` do. Lock: `Camera.speedZoom.test.ts`.
- **Muzzle points come only from `core/combat/muzzle.ts`;** turret ring and gun are placed only by `art/turretLayout.ts`; rotation stays on `applyMountAngles`. Locks: `muzzleParity.test.ts`, `turretLayout.test.ts`.
- **The silhouette is the collider:** size art from `shipExtent`, never `ShipKind.radius`.
- **Ship livery** is on by default (`readLivery`; `?livery=off` = the pre-livery bake, byte-identical); owner colours come only from `teamColorOf`/`teamSigilOf`/`teamEdgeOf`, resolved in `ownerLivery`; the default never changes the art mode. Lock: `fields.livery.test.ts`. Detail: [art-direction](../../docs/architecture/art-direction.md#ship-livery).
- **Art budget:** effect textures (group 0) are never freed. Lock: `artSectorCollect.test.ts`.
