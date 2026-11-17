# CLAUDE.md — src/client (Eyes and Ears)

`src/client` is everything the player sees and hears. It is **not** the source of truth — the server is. The client hides latency with prediction and ghost projectiles, and defers to the server whenever the two disagree.

Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing. Each rule's regression tests (locks) are listed in its Detail guide; run them when you change that rule. Every Detail link means that guide's "Client rules in detail" section.

## Forbidden Imports (CI-enforced)

Never import from `src/client/`: the server `colyseus` package (use `colyseus.js`), `@colyseus/ws-transport`, Node-only / persistence APIs (`better-sqlite3`, `express`, `pino`, `worker_threads`, `node:worker_threads`, `fs`, `node:fs`, `http`, `node:http`), or anything under `src/server/**`.

Allowed: `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand`, `src/core`, `src/shared-types`.

## Zustand Purity (invariant #2, strictly enforced)

- **No spatial fields in the Zustand store.** Lint-blocked keys in `src/client/state/store.ts`: `x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`.
- Zustand holds discrete UI state (`connectionStatus`, `sectorName`, `hullPct`, `ammo`, `sectorAlert`, `playerId`, dev-overlay toggles, HUD flags), never anything that updates every frame; spatial state lives in the render mirror that Pixi polls. Why: [renderer-worker](../../docs/architecture/renderer-worker.md).

## Renderer Rules

- `PixiRenderer` implements `IRenderer` from `src/core/contracts/`.
- The renderer **polls** the state mirror every frame. It **never** subscribes to the event bus for positions. Lint blocks `bus.on` imports inside `src/client/render/`.
- Camera (`pixi-viewport`) follows the local ship. No global-space UI overlay in Pixi — HUD elements are React/MUI outside the Pixi surface.
- **Starfield:** the farthest star layer is FULL at the camera's zoom floor (every capital floor too) and tiles the whole viewport there; a new floor must keep both.
- **Zoom-in cap:** the camera never zooms in past the point where the piloted hull fits on screen (`zoomCeilingForView`); the follow camera has no look-ahead, so re-check the cap before adding one. Detail for both: [ship-scale](../../docs/architecture/ship-scale.md).
- **Spectator:** only `pilotMode` is in the store (the free-roam pose lives in the renderer `Camera`); the death flip mounts no UI (build palette pre-mounted); the parked own hull is never re-seeded or re-predicted from the schema. **Pilot swap** stays on the live room: despawn the local predWorld body, null the `Reconciler` so `welcome` re-anchors, one-shot `Camera.glideTo`. Netgate required. Detail: [spectator](../../docs/architecture/spectator-and-construction-mode.md).
- **Cinematic camera:** precedence is director > glide > follow > pan; the director reads rendered poses (never re-interpolates); keyframes never touch Zustand; overlay/HUD hiding goes only through `?cleanworld` / `?hud` and `SET_HUD_OVERLAYS`. Detail: [cinematic-camera](../../docs/architecture/cinematic-camera.md).
- **Upgrades, level, mounts:** the client never predicts a stat upgrade — it re-anchors from the authoritative `statAlloc` via the shared `deriveStatMultipliers`. Ship level, activated mounts and structure level are slim snapshot fields mirrored at one site; mount geometry comes from the shared `resolveInstanceMounts`, never the wire. Netgate required. Detail: [leveling](../../docs/architecture/leveling-and-upgrades.md), [weapon-mounts](../../docs/architecture/weapon-mounts.md).
- **Collision changes need an E2E:** any change to how obstacles or remote ships are synced, reset or lerped in `ColyseusClient.ts` ships with a `tests/e2e/` spec that fails if the change is reverted. Detail: [collision-layers](../../docs/architecture/collision-layers.md).
- **Every collidable entity is in predWorld:** a new entity the local player can collide with or shoot registers a predWorld body (prefixed id, spawn, `setShipState` per snapshot, despawn, tracked id set); the server iterates it in `advanceProjectiles`, `handleFire`'s hitscan and `applyDamage`. Never render remote ships from `remoteHistory`. Detail: same guide.
- **Pose-core entities construct through `ClientEntityFactory`:** an unrecognised kind returns `null` and is skipped; the swarm caches (`predSwarmKeys`, `_movingSwarmKeys`, `_swarmBodyKeyCache`, `_aiRegisteredIds`) stay in `ColyseusClient`, never the factory. Detail: [generic-entity-pipeline](../../docs/architecture/generic-entity-pipeline.md).
- **Y-flip:** game coords handed to the Pixi scene graph flip (`pixiY = -gameY`), but `art/fx` APIs that take "game space" flip themselves — never flip twice; never scale a screen point by `renderer.resolution` (a phone-only renderer bug is a frame mismatch until on-device evidence says otherwise). Detail: [visual-effects](../../docs/architecture/visual-effects.md).
- **Halo radar:** `HaloRadar.update()` allocates nothing; its decisions stay pure and unit-locked under `halo/`; on-screen contacts are excluded at candidate build, never by a timer. Detail: [off-screen-indicators](../../docs/architecture/off-screen-indicators.md).
- **Far-zoom icons:** keep `FAR_ICON.fadeStartPx` below a fighter's size at the spawn zoom. Detail: same guide.
- **Warp visual** is `WarpFx` sprites from each ship's snapshot warp phase; never add a full-screen warp flash, ripple or per-event warp visual. Detail: [warp-visual](../../docs/architecture/warp-visual.md).
- **Pre-welcome guard:** any predWorld spawn in `syncMirror()`'s remote-ship branch is gated on `localId !== null`. Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md).

## Renderer worker boundary

On desktop the renderer runs in a Web Worker via `OffscreenCanvas`. How it works: [renderer-worker](../../docs/architecture/renderer-worker.md).

- **The wire format is [`render/worker/protocol.ts`](render/worker/protocol.ts):** structured-cloneable variants only — no DOM handles, Pixi handles or functions.
- **Forbidden imports inside `src/client/render/worker/**`** (CI-enforced): `react`, `react-dom`, `@mui/*`, `@emotion/*`, `zustand`. State crosses the boundary via the protocol.
- **`RenderMirror` is the per-frame wire payload:** any new field stays structured-cloneable.
- **`RendererFeedback` is a closed set:** a new field needs a phase-gate review (it grows every frame's postMessage) and is threaded through all three worker sites (`renderer.worker.ts` FEEDBACK post, `WorkerRendererClient.emptyFeedback`, its FEEDBACK handler). Pointer-cadence renderer state never goes to Zustand. Detail: [renderer-worker](../../docs/architecture/renderer-worker.md).
- **No `pixi-viewport` inside the worker** (no DOM): the worker uses the hand-rolled `Camera`, fed by pointer/wheel events forwarded from the main thread.
- **Fallback:** without OffscreenCanvas, `WorkerRendererClient` returns the main-thread `PixiRenderer`; production code never assumes worker rendering.
- **Touch devices default to the main-thread renderer** (`?worker=1` / `?worker=0` override). Don't flip the touch default back without a fresh on-device smoke measuring `raf_gap` clusters. Detail: [renderer-worker](../../docs/architecture/renderer-worker.md#history).
- **Galaxy map:** `GalaxyMapLayer` lives worker-side, driven by the `syncGalaxy*` messages; hover is a deduped `GALAXY_HOVER` back-channel sent only when the hovered sector changes. Galaxy poll hooks live in `app/`, never a top-level `src/client/galaxy/` dir (it collides with the `/galaxy` Vite proxy). Detail: [living-galaxy](../../docs/architecture/living-galaxy.md).
- **Galaxy landing reveal:** the opaque `galaxy-loading` gate waits for ALL badge sources (snapshot, presence, roster; the snapshot alone when logged out); every source is seeded at overlay install; each poll flips its loaded flag in `finally`, never only on success. Detail: same guide.

## UI Scope and panels

- **No raw ids in player-facing UI:** show "you", the owner's resolved name, "Unknown" or a kind/role; ids live only in hidden `data-*` attrs and logs. Detail: [mobile-layout](../../docs/features/mobile-layout.md).
- **React + MUI** for out-of-game UI and overlays, **Pixi** for the in-game surface; never MUI inside the canvas, never HUD numbers in Pixi.
- **Sizing: start tiny, grow on request** (icons 24–36 px, text 9–11 px, `maxWidth="xs"`, `size="small"` buttons; 44 px only for primary confirms). Detail: same guide.
- **A panel outside the Slot system that must beat the HUD is `<Portal>`'d to `document.body`;** `placeInspector` keeps the WHOLE inspector on screen (never clamp only the anchor). Detail: same guide.
- **One Pixi galaxy renderer,** `GalaxyMapLayer` (`selector` / `overlay`) on the shared canvas; never a second Pixi `Application`. Detail: [single-canvas-galaxy](../../docs/architecture/single-canvas-galaxy.md).
- **Galaxy map:** territories group by owner (`resolveSectorOwner`); hover tooltip desktop-only; each entity type's look is one row in `render/entityVisuals.ts`. Detail: [living-galaxy](../../docs/architecture/living-galaxy.md).
- **A poller feeding a widely-subscribed store field skips unchanged replies** (`rosterPoller` → `shipRoster`). Detail: same guide.
- **`getGameClient()` mirror reads are low-cadence only,** never per-frame. Detail: [configurable-arrival](../../docs/features/configurable-arrival.md).
- **Drawer tabs** (Trade, Factions, Contracts) poll only while shown and rebuild only from their replies (#16); toasts are accelerators. Detail: [economy-and-trade](../../docs/architecture/economy-and-trade.md).
- **No top-level `src/client/<dir>/` named like a Vite proxy path** (`trade/`, `galaxy/`). Lock: `clientDirProxyCollision.test.ts`.
- **Cargo and wallet** come only from the own-ship snapshot (#16), written to Zustand on change. Detail: [loot-and-cargo](../../docs/features/loot-and-cargo.md).
- **Every client → server sender passes its server schema** (`tradeClientWireParity.test.ts`, `teleportClientWireParity.test.ts`).

## Layout Slot System

In-game React overlays are positioned via **named slot anchors** ([layout/](layout/)), never hand-placed. Full story: [mobile-layout](../../docs/features/mobile-layout.md).

- **Anchors** live in [layout/anchors.ts](layout/anchors.ts). Adding one is fine; changing an existing anchor's CSS is a code-review prompt.
- **Widgets render via `<Slot anchor="...">`** and never set their own `position`, `top/left/right/bottom`, `zIndex` or safe-area insets; z-tiers come from [layout/zIndex.ts](layout/zIndex.ts) and only anchor hosts use them. (The structure placement banner is the one widget positioned over the world.)
- **Drawer:** never a `SwipeableDrawer` (its global touch listeners wreck mobile RTT); `keepMounted` stays on; snapshot-rate work in a drawer tab gates on `drawerTab === '<id>' && isDrawerOpen`.
- **Keep these surfaces:** don't delete the `HudTestAttributes` mirrors without auditing every spec that reads them, nor `ProfileModal.tsx` / `SettingsModal.tsx` / `AvatarMenu.tsx` (the desktop path).
- **Logout** has one definition, `useLogout()` ([auth/useLogout.ts](auth/useLogout.ts)); every logout entry point routes through it.
- **Orientation:** phones play sideways: upright, `RotatePhoneOverlay` covers the screen and input is off; full screen starts only from a tap on `<FullscreenToggle>`, never by itself.
- **Speed dial:** discrete tap actions go in the bottom-right `SpeedDial`; held controls (joystick, FIRE, BOOST) stay dedicated. Dial actions also bind `onTouchStart` (a second touch never gets a click) and drop the trailing synthesized click; a test opens the dial before clicking an action.
- **Structure placement:** only the discrete `placementKind` lives in Zustand; the ghost pose rides `RenderMirror.pendingPlacementPreview`; pointer→world conversion stays in the renderer (it owns the `Camera`) and returns via `RendererFeedback`. Desktop click and touch Confirm share `commitChosenPlacement`; `contextmenu` cancels only for a mouse gesture. Structures draw `structureRenderVerts` (the collider's Y-flip), never raw points. Detail: [structures](../../docs/architecture/structures-and-power-grid.md).
- **Grid render:** the placement preview runs the server's `canConnect`, allocates nothing per frame, and draws no line to another owner's structure; an owner shows as "you", their display name or "Unknown", never a raw playerId. Detail: same guide.
- **`useIsCompact()` and `isTouchDevice()` are independent axes** — don't fuse them.
- **Phase machine lives in Zustand:** the initial phase is `galaxy-map`; spawning is auth-gated on the sector pick.

## Audio

- **Howler** is the only audio concretion, behind an `IAudio` implementation. TiDi pitch-shift is `howl.rate(serverClockRate)`.
- All SFX trigger off bus events (`LASER_FIRED`, `ENTITY_DESTROYED`, `ENTITY_WOKE`), never polling.

## Client Prediction + Ghost Projectiles

How it works: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md), [drone-snapshot-interpolation](../../docs/architecture/drone-snapshot-interpolation.md).

- Prediction and ghosts are presentation only. They must not influence authoritative state or be visible to other clients.
- **No client drone brain:** drones are pure snapshot-interpolated; `_aiController` is a hostility ledger only and is never ticked.
- **One paradigm for every remote moving entity** (root invariant #12 "Collision bodies"; wreck pieces included): never lock scrap, never sweep a dying capital's sprite directly; wreck pieces reuse the parent kind's baked art, never a new bake.
- **One pose per frame:** `interpolateSwarmPose` runs once per drone per frame, in `updateMirror`; every consumer reads the resolved pose via `resolveEntityDisplayPose` and never re-interpolates (asteroids excepted). `POSE_RING_DEPTH` covers `DISPLAY_DELAY_MS` at the binary cadence.
- **Wall-clock-anchored input loop:** `tickPhysics()` derives `targetTick` from wall time; never re-introduce an accumulator-with-cap; a backlog over `STALL_SKIP_TICKS` is skipped, not replayed.
- **RAF work cap:** keep `DEFAULT_MIN_FRAME_INTERVAL_MS` between ~8.3 and ~11 ms; a skipped RAF never updates `lastFrameTime`. Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md#history).
- **Ghost mirror cleanup:** `GhostManager.update(out)` deletes from `out` every ghost it removes (the only path that clears ghosts from `mirror.projectiles`). Ghosts never declare destruction server-side.
- **Sector handoff resets prediction state:** all prediction-window state, the `Reconciler` and the local predWorld body re-initialise in `resetPredictionState()`, and join readiness re-arms via `rearmJoinReadiness()`; new prediction-feeding state is reset there or commented why it is safe to inherit.

## RTS command view

- **One ship list:** an AI-flown hull is an ordinary `mirror.ships` entry under its shipInstanceId (`net/shipMirrorKey.ts`); a key change is ONE op, `ColyseusClient.rekeyShip` (moves the entry and body, never rebuilds). "Flying" / "owned by me" come only from `render/shipOwnership.ts`, never `id === localPlayerId`.
- **One selection,** owned by the renderer; `FleetOverlay` is one `Graphics`, drawn in the Pixi ticker after `camera.tick`. Fleet warp sends that selection as `engage_transit.shipIds`. Detail: [fleet-command](../../docs/architecture/fleet-command.md) §4, §4b, §7.

## Snapshot transport

How it works: [webrtc-datachannel-snapshot-transport](../../docs/architecture/webrtc-datachannel-snapshot-transport.md).

- **DataChannel is default-on for players, off under automation** (`webrtcEnabledFromSearch`); keep the webdriver gate — the E2E suite and the netgate must measure the WS path.
- **Snapshot apply happens at RAF tick, never inline in `onMessage`:** both transports enqueue into `SnapshotCoalescer`, drained in `tickPhysics`. Coalescing never drops wreck deltas (`carryWreckDeltas`, `carriesWreckDeltas`).
- **The DC path stores bytes and decodes once per RAF:** `dc.message` calls `_receiver.enqueueBinary(buf)`, never `handleBinary`.
- **Network estimates use wire-arrival time, never apply time** (`intervalMs` from `_lastSnapshotRecvAtMs`).
- **`onStateChange` is hybrid:** the first per RAF runs `syncMirror` inline, the rest defer to the next `tickPhysics` (at most 2 per RAF); don't switch to full-defer.

## Input, weapons and fire control

- **Input throttling:** skip an input send only when current AND last-sent states are fully idle; held controls re-send every tick (audit any new throttled stream the same way). Detail: [prediction-and-correction](../../docs/architecture/prediction-and-correction.md).
- **Ships fire their catalogue loadout:** the pilot picks a slot (`activeSlotId` in Zustand), never a weapon type; the server ignores a claimed `weapon`. Slot cooldown is the max over its mounts.
- **Energy is predicted** (`predEnergy`), reconciled each snapshot, shown via direct DOM writes (never per-frame Zustand); local fire and boost gate on `canAfford`. Detail: [fire-control](../../docs/architecture/fire-control.md).
- **Every group fires only at a LOCKED target;** `fcFireTick` is the only client fire path. There is one HUD, `hud/GameHud.tsx`.
- **Lock line:** the pick uses the shared `lockLineScore`, alloc-free per candidate; `lock_track` carries `b` and the server re-checks it (#15).
- **`fcTickMountAngles` is THE client mount-angle path** (#12); the client sends no `aim` input.
- **Contacts overview:** only `contactsOpen` is in Zustand; never add a `contactsOverview.ts` beside `ContactsOverview.tsx` (case-insensitive FS). Detail: [contacts-overview](../../docs/features/contacts-overview.md).
- **Boost is a facing-direction impulse:** energy-gate the boost bit before `predWorld.applyInput` AND the send (per-tick and sentinel paths). Detail: [auto-fire-and-boost](../../docs/features/auto-fire-and-boost.md).

## Mounts and beams

Detail: [weapon-mounts](../../docs/architecture/weapon-mounts.md).

- **`mountAngles` is indexed by catalogue mount order** (`kind.mounts`) by every writer and reader, never slot-local order.
- **The per-frame `mirror.ships.set()` rebuilds preserve non-spatial fields** (`kind`, `displayName`, `mountAngles`); a new non-spatial `ShipRenderState` field goes into BOTH rebuild sites (`updateMirror`, `syncMirror`) or it is wiped at 60 Hz.
- Aim-line length comes from `aimLineLengthForMount` (the weapon's reach).
- **Beam sprite length is `scale.x = worldLen / texture.width`.** Drawn-length tests inject a real-width texture (headless falls back to 1×1).

## Structures

Detail: [structures](../../docs/architecture/structures-and-power-grid.md).

- **Footprints:** draw and pick structures by the catalogue footprint box, like the server. Placement rotation is module state in `structurePlacementClient.ts`, never Zustand.
- **Connector web:** steady visuals go on `ConnectorRenderer.staticGfx` and feed `staticSignature`; anything driven by `nowMs` goes on the per-frame `gfx`.
- **predWorld streams structures and walls by distance** (`predStructureStreaming.ts`); never add every structure. Off-screen structure sprites are hidden.
- **Shield walls are derived in one place,** `visitDerivedWalls` (`structures/derivedWalls.ts`); never read `shieldWallTo` for walls.
- **Structures come from room state** (`syncStructures` + `decodeStructureState`); the snapshot carries only `structureTargets`; the binary refresh never deletes structures.
- **Mines** come only from room state (`syncMines`); `mine_detonated` is an accelerator. Detail: [mine-layer](../../docs/features/mine-layer.md).
- **Turret-vs-fence hint** toggles by direct DOM write, on change only. Detail: [shield-fence](../../docs/features/shield-fence.md).
- **Build menus** label kinds through the pure `buildEntry(kindId, counts)`; counts come only from `packed_stock` replies. Detail: [blueprints](../../docs/features/blueprints.md).
- **Teleporters:** panels read the mirror at 4 Hz (no Zustand); a `poseEpoch` change re-seeds the local body (no reconcile); tolls are offers, not state; gate-disabled input goes through the shared `gateDisabledInput`. Detail: [teleporters](../../docs/features/teleporters.md), [alien-gates](../../docs/features/alien-gates.md).

## Combat feedback

- **Damage numbers / health bars:** `pendingDamageNumbers` / `pendingHealthBarHits` are drain queues consumed once per frame; one number bucket per target (nearby hits coalesce); a dead target's number takes no late hit (`markDead`). Detail: [visual-effects](../../docs/architecture/visual-effects.md).
- **Incoming naval fire** is mirror-derived (#16), renderer-only (#2), alloc-free (#14), radius from `shipTuning` (#18). Shells burst only on `shell_end`; a naval hit's FX wait for it (`navalHitHold.ts`). Detail: [off-screen-indicators](../../docs/architecture/off-screen-indicators.md), [shell-events](../../docs/architecture/shell-events.md).
- **Helm course marker** rides `RenderMirror.helmCourse`, never Zustand. Detail: [capital-ships](../../docs/features/capital-ships.md).
- **Shield/hull:** `shieldPct` tweens by CSS, no JS loop; percentages use the event's per-kind max; the predWorld shield swap follows only the authoritative shield-down, one site for drones (`syncSwarmIntoPredWorld`); shield visuals draw at the collider radius (`shieldBubbleRadiusForEntity`). Detail: [shield-hull](../../docs/features/shield-hull.md).
- **Patrol faction tint** is set only at the one tint site in `swarmSpriteUpdater`. Detail: [factions](../../docs/architecture/factions.md).

## Game time, identity, code shape

- **Game time:** `gameClock` speed comes only from the snapshot `timeScale`. Tick math, display delays and world motion (`gameFrameMs()`) use game time; networking, smoothing, camera and UI use wall time; effects read `fxNow()`. Detail: [game-time-scale](../../docs/architecture/game-time-scale.md).
- **Identity:** read the playerId only through `identity/token.ts` (`loadStoredPlayerId()`); never use the Colyseus `sessionId` as a durable id. The mirror, predWorld and reconciler are playerId-keyed; `handleSnapshot` translates the `shipInstanceId`-keyed wire at its top. Detail: [player-identity](../../docs/architecture/player-identity.md).
- **Sprite-update decisions** (create / rebuild / reposition / skip) are pure functions in `render/spriteUpdateDecisions.ts` with unit and fast-check tests; never inline a new branch in `PixiRenderer.ts`. Detail: [generic-entity-pipeline](../../docs/architecture/generic-entity-pipeline.md).
- **Test layers:** `*.test.tsx` runs under jsdom, `*.test.ts` under node. Detail: [e2e-framework](../../docs/architecture/e2e-framework.md#unit-and-component-test-layers).

## Effects and art

- **Effects:** `EffectsService` is built only in `PixiRenderer.init`; `ColyseusClient` never imports it (triggers ride `pendingEffectTriggers`; a new one-shot queue extends `perFrameTriggers.ts`); `tick` runs inside `update` after `updateSwarmSprites`. Detail: [visual-effects](../../docs/architecture/visual-effects.md).
- **Quality tiers** are pulled per frame; `PerfMonitor` pushes only on a tier change.
- **Engine exhaust** is particles only; the emitter gets a GAME-space pose (`entityPoseFromSprite`); never re-add ship-velocity inheritance.
- **Load curtain** (`LoadCurtain`) owns no filter; nothing idle attaches a filter to `app.stage` (it disables MSAA). Detail: [warp-visual](../../docs/architecture/warp-visual.md).
- **Sector trips are the loading screen:** a transit raises no curtain or `WarpScreen`, nothing fades or cuts (stretch the trip instead); `stepTravel` writes the local mirror entry LAST; a jump mid-trip adds to `mirror.travelJumpX/Y`. Detail: [travel-state](../../docs/architecture/travel-state.md).
- **Scrap** is an UNLOCKED, drone-like predWorld body at `SCRAP_DEFAULT_MASS`; its geometry is looked up by `(parentShipKind, componentIndex)`, never sent. Detail: [composite-ships-and-scrap](../../docs/architecture/composite-ships-and-scrap.md).
- **GPU-lit art:** lit maps go on **data** atlas pages, never canvas pages; every lit mesh registers with `litPass` (alloc-free); Baked stays byte-identical to the old look. Detail: [gpu-lit-ships](../../docs/architecture/gpu-lit-ships.md).

### Machined art

Detail: [art-direction](../../docs/architecture/art-direction.md).

- **Bump `FORGE_VERSION`** with any forge output change and **`FX_VERSION`** with any fx generator change.
- **`ArtService`** handles are reused, checked per frame; ship sprites switch art only in `art/shipArtSprites.ts`; sprite maps hold `Container`s, never assume `Graphics`. Look specs pass `?art=machined` / `?fx=new`.
- **Backdrop positions tied to game coords flip Y** (`cam.center` is Pixi space); never lay the sky out per sector size.
- **Anything that sets the camera scale handles the speed-zoom factor** as `Camera.tick` / `setZoom` do.
- **Muzzle points come only from `core/combat/muzzle.ts`;** turret ring and gun are placed only by `art/turretLayout.ts`; rotation stays on `applyMountAngles`.
- **The silhouette is the collider:** size art from `shipExtent`, never `ShipKind.radius`.
- **Ship livery** is on by default (`readLivery`; `?livery=off` = the pre-livery bake, byte-identical); owner colours come only from `teamColorOf`/`teamSigilOf`/`teamEdgeOf`, resolved in `ownerLivery`; the default never changes the art mode. How it works: [art-direction](../../docs/architecture/art-direction.md) "Ship livery".
- **Art budget:** effect textures (group 0) are never freed.
