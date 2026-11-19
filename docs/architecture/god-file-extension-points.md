# God-file extension points

<!-- showcase-exempt: process and architecture rules page, nothing to film -->

The file-size ratchet (`scripts/audit-god-files.mjs`, CI step "File-size ratchet") fails any `src/**` file over 600 LOC that is not allowlisted, and any allowlisted file that grows past its cap. The limits do not move. When a feature needs room, the code goes to the file's **extension point**: a new small file plus at most one line in the big file. Trimming comments or raising a cap is never the fix.

Each section below says: to add X, create file Y and add one row to Z. The nested `CLAUDE.md` next to each area carries the same rules in short form, and is loaded when an agent works in that folder.

Status column: **live** = the extension point exists today; **planned** = being built by the god-file split (see "Roll-out" below). Until a planned point lands, use the existing pattern named in its row.

## Server: `SectorRoom.ts` (`src/server/rooms/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A client→server message | A `register<Feature>(host)` file in `src/server/rooms/features/` that registers each message through `parsedMessage` (zod parse at the boundary, malformed tracker on failure), plus one row in `features/index.ts`. Reference: `registerTeleportMessages` (`features/teleportMessages.ts`). The room registers no message itself: even flight control, transit and pilot seats are features (`controlMessages.ts`, `transitMessages.ts`, `pilotMessages.ts`). | live |
| A test-only `test_*` handler | `features/devTestMessages.ts`, gated on testMode or `EQX_ALLOW_DEV_OVERRIDES` (`TestMessageHandlers`). | live |
| A new subsystem | Construct it in its feature's register function; return `{ dispose }`; periodic work via `gameClock.every` + `guarded`; never a new field + `new X()` in `onCreate`. | planned |
| Join / leave / respawn logic | `JoinHandler` (`join/`) / `LeaveHandler` / `RespawnHandler` classes. | live |
| A tick-phase step | A function taking a narrow ctx, like `runAiTick(ctx)` (`aiTickRunner.ts`). | live |
| Fire-control lock logic (lock-key resolution, the lock machines' deps, the mount-on-lock gates) | `FireControlLocks` (`features/fireControlLocks.ts`), held as `fireLocks` on the room with a narrow `Pick`-typed host. | live |
| Room-side fleet hooks (the per-tick fleet command cap, the `fleet_status` stream and its send-soon flush, owned-hull retaliation and morale notes, spectate / command-view entry, fleet-warp hull poses) | `FleetRoomHooks` (`features/fleetRoomHooks.ts`), held as `fleetHooks` on the room with a narrow `Pick`-typed host; the fleet message handlers stay `registerFleetMessages` (`features/fleetMessages.ts`). | live |

## Server: `src/server/index.ts` (`src/server/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A test / engineering / showcase room | A row in a per-feature room file in `src/server/rooms/testRooms/` (`engineeringRooms.ts`, `scenarioRooms.ts`, `worldRooms.ts`), `rooms/showcaseRooms.ts` or `definePerfRooms()`, all called from `index.ts` behind `shouldRegisterTestRooms()`. Never a `define` in `index.ts`. | live |
| An HTTP route | A router in `src/server/routes/` (like `diagRouter.ts`, `galaxyRouter.ts`), mounted with one line. Dev-only `/dev/*` and `/test/*` endpoints go in `routes/devRouter.ts` (mounted outside production). | live |
| A boot step | A step function in `src/server/boot/` (like `persistenceBoot.ts`, `livingWorldBoot.ts`, `economyBoot.ts`) taking a narrow deps object and returning what later steps need; `main()` is the ordered list of calls. Directors it starts go on `WorldHandles` (`boot/worldHandles.ts`). | live |

## Server: `LivingWorldDirector.ts` (`src/server/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A periodic world activity (roam-like squad behaviour, ambient work on the control tick) | A `DirectorActivity` (`step(now)`) class in `src/server/livingworld/director/`, built once in the director's constructor from a narrow deps object (reassigned director fields read via a getter callback), plus one entry in the director's `activities` list. Runs on the ~1.5 s control tick in list order, never the 60 Hz loop; allocation-free per tick. Reference: `SquadHerding` (roam, clusters, flock roles). | live |
| Respawn ingress / arrival pose or hostility rules | `director/HunterBotRespawner.ts`; the director keeps one-line delegates (`respawnStep`, `hostileSpecFor`, `arrivalPoseFor`). | live |
| A side-specific (robot / drone) per-tick hook | A field on `LivingWorldHooks`, wired in `src/server/boot/livingWorldBoot.ts` via `setHooks`. | live |

## Client: `ColyseusClient.ts` (`src/client/net/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A server→client message | Its zod schema in `src/shared-types/messages/` and a row in `ServerMessageSchemas` (`src/shared-types/messages.ts`); a `register<Feature>Handlers(room, ctx)` file in `src/client/net/handlers/` plus one row in `handlers/index.ts`. | live |
| A per-entity timer / state machine | Its own module, like `drawnShellTiming.ts`, `damageNumberTargets.ts`. | live |
| A per-frame mirror pass | A function `(ctx, frameNowMs, ...)` in `src/client/net/mirror/` taking the once-built `MirrorPassCtx`, plus one call in `updateMirror`, in frame order. | live |
| A prediction-step pass (input loop, energy, sentinel) | A function `(ctx, ...)` in `src/client/net/prediction/` taking the once-built `PredictionStepCtx` (getters/setters for reassigned fields), plus one call in `tickPhysics`, in the same order. | live |
| Sector-trip (travel) flight | `src/client/net/mirror/travelPass.ts` (`stepTravel`, the `TRAVEL_*` knobs, `travelApproach`); `updateMirror` calls it last. | live |
| Fire control / lock state | `FireControlClient` (`src/client/net/FireControlClient.ts`; the lock line in `fireControl/LockLineClient.ts`); `ColyseusClient` keeps one-line delegates and reaches it as `this.fc`. | live |
| Local fire / live beam | `LocalFireClient` (`src/client/net/fireControl/LocalFireClient.ts`: `sendFire`, `updateLiveBeam`, `localShipMounts`) with the once-built `LocalFireHost`; `ColyseusClient` keeps one-line delegates. | live |
| Damage / shield / death state | A function `(ctx, ...)` in `src/client/net/damagePath.ts` taking the once-built `DamagePathCtx`; the wire side stays in `handlers/combatHandlers.ts`. | live |
| Connection / join / room lifecycle | `src/client/net/connection/roomConnection.ts` (URL transport flags, join with timeout, DEV bandwidth tally, the DataChannel snapshot transport, `onLeave` / `onError`); `connect()` keeps the order of calls. The `welcome` handshake is `handlers/welcomeHandlers.ts` (its `WelcomeTarget` built once). | live |
| Sector-handoff prediction reset | `resetPredictionState(ctx)` in `src/client/net/prediction/resetPrediction.ts` with the once-built `PredictionResetCtx`; `ColyseusClient` keeps a one-line delegate. New per-sector state is reset there. | live |
| PredWorld body sync (local-body bootstrap, swarm bodies) | `tryInitPredWorld` / `syncSwarmIntoPredWorld` in `src/client/net/prediction/predWorldSync.ts`, run with the once-built `PredictionStepCtx`; `ColyseusClient` keeps one-line delegates. | live |
| An outbound room command (pilot swap, spectate / command view, fleet orders, ship upgrades, mount activation, respawn, `client_ready`) | A function `(ctx, ...)` in `src/client/net/connection/roomCommands.ts` taking the once-built `RoomCommandsCtx`; `ColyseusClient` keeps a one-line public delegate. | live |
| Client teardown (`dispose()`) | `disposeClient(ctx)` in `src/client/net/connection/clientTeardown.ts` with the once-built `ClientTeardownCtx` (the sector-reset ctx plus teardown-only fields). A new subsystem is disposed / cleared there. | live |
| Room-state mines into the mirror | `MineSync` (`src/client/net/mirror/mineSync.ts`), built once; `syncStructures` calls `sync()`. | live |

## Client: `PixiRenderer.ts` and `IRenderer.ts` (`src/client/render/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A per-frame visual | An updater module `update<X>Sprites(mirror, ctx)` with a pooled ctx built once in `init`, like `pixi/shipSpriteUpdater.ts` or `pixi/beamUpdater.ts` (beams of every kind, tractor included). | live |
| A step of `update()` | A pass function `(mirror, ctx)` over the pooled frame ctx (`pixi/frameCtx.ts`: live renderer fields through getters, pass state and scratch owned by the ctx), placed in order in `pixi/worldSpriteUpdater.ts`, `pixi/frameViewUpdater.ts` or `pixi/frameFeedbackUpdater.ts`; `update()` stays an ordered list of pass calls. The Pixi ticker callback is `pixi/rendererSetup/initTicker.ts`. | live |
| A test / perf probe | A function in `pixi/rendererProbes.ts` taking `RendererProbeState` (perf / draw-count rings: `RendererPerfProbe` there), plus a one-line delegate in `PixiRenderer`. | live |
| Per-ship renderer state that must follow a ship re-key | `shipRekey.ts` `rekeyShipVisuals` (and the thing's own `rekey(from, to)`). | live |
| An `init` setup step (scene layers, fx systems, updater ctx wiring, DOM listeners) | A function in `pixi/rendererSetup/` taking a narrow deps object and returning what it built; `init` stays a short call sequence that assigns the results. Its teardown goes next to it (like `removeDomListeners` in `initDomListeners.ts`), called from `pixi/rendererSetup/teardown.ts` (`disposeRenderer`, `resetEffectsForSectorHandoff`). What it builds (scene layers, overlays, backdrop, updater / beam ctxs, fx systems, beam pools) and the scratch that only feeds them go on the `RendererInitState` holder (`initWiring.ts`), never a new PixiRenderer field; deps the frame refs already carry are read from `this._frame.r`, the rest from the renderer's host view. | live |
| A renderer member a collaborator reads (frame refs, probes, teardown, input / camera deps, rekey) | One getter on the host view (`RendererViewHost`, built once in `PixiRenderer.viewHost`), and the matching view in `pixi/rendererSetup/rendererViews.ts` reads it. | live |
| A bound per-sprite callback handed to the frame passes or a ctx (sprite kind, sweep cleanup, re-key step, shield pose) | A member of `RendererSpriteFns` (`spriteFnsView` in `pixi/rendererSetup/rendererViews.ts`), built once over the host view and reading its live fields at call time; never a closure field on PixiRenderer. | live |
| A `RendererFeedback` field | Its initial value in `createRendererFeedback` and its per-frame write in `writeFrameFeedback` (`pixi/frameFeedbackUpdater.ts`). | live |
| Pointer / touch / wheel input, an RTS command gesture or selection rule | `pixi/rendererInputController.ts` (listeners, forwarded events, placement pointers) or its base `pixi/rendererCommandRouting.ts` (command routing, THE selection); the per-frame selection / hover brackets are its `updateSelectionBrackets`. PixiRenderer keeps one-line delegates. | live |
| Camera framing (hull zoom range, caps) or the cinematic director | `pixi/cameraDirector.ts` (`RendererCameraDirector`, built once; `updateFrame` per frame). | live |
| A render-mirror field | The entity's `*RenderState` file under `src/core/contracts/render/`. | planned |
| A renderer method (overlay, camera, radar) | The matching sub-interface (`IFleetView`, `IRadarView`, `ICameraControl`) that `IRenderer` extends. | planned |

## Core AI: `HostileDroneBehaviour.ts` (`src/core/ai/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A combat move | An `IManoeuvre` in `src/core/ai/tactics/` (`manoeuvre.ts`). | live |
| An order / stance / non-combat mode | An `IPilotMode` file in `src/core/ai/modes/` (lifecycle next to `IManoeuvre` in `tactics/manoeuvre.ts`) plus a case in `pilotJob()`. Live: leaving, patrol (course + orbit), travel / patrol leg, search, flock follow, guard return. An order's state (post, travel, hunt, course) is fields on its mode (the guard post also owns its radius floor, leash test and the pick's leash reach), and its setter, with the order's rules in its doc, is a method on that mode (the brain keeps a one-line delegate; cross-mode effects through `PilotOrderModes`). | live |
| A pilot helper the brain owns (senses, target pick, morale state) | A class in `src/core/ai/pilot/` built once in the constructor (`PilotSenses`, `TargetPick`, `PilotTargeting` the hostility ledger and targeting orders, `PilotMorale` the morale timers, die and hooks (`noteDamage`, `noteCapitalLost`), `MoveToHelm` the shared fly-to, `PilotHelm` the energy pool and virtual-pilot actuation (`fly`, `trySpendEnergy`); `PilotAim` the combat lead and turret aim point (`aimPoint`); the weapon engagement profile is `engagementProfile()` in `pilot/engagementProfile.ts`, filled once). Combat-side helpers (`TacticalFill` incl. the context's fixed fields (`init`), `BroadsideHelm`, `FireLaneSteer`, `CombatDecision` incl. Flee's warp-out test and stand-down, `CombatSteer`) are classes in `src/core/ai/tactics/`, built the same way. | live |
| A tuning number | `hostileDroneTuning.ts`. | live |

## Core: `World.ts` (`src/core/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A new body shape or collider set | A builder in `src/core/physics/spawnBodies.ts` (`createShipBody`, `createObstacleBody`, `createProjectileBody`, `createWallBody`, `mountShipColliders`) called from the `PhysicsWorld` spawn method; collider settings stay in `colliderConfig.ts`. | live |
| Warp body behaviour (spool turn, run, drop) | `src/core/physics/warpActuator.ts` (`applyPilotInput`, `botWarpStep`, `restoreWarp`); the warp state machine stays in `warpDrive.ts`. `PhysicsWorld` keeps one-line delegates. | live |
| A shared World record type | `src/core/physics/worldTypes.ts` (`ShipBody`, `ShipInput`, `ShipPhysicsState`), so extension modules never import `World.ts`. | live |
| A per-step pass | Its own module with a class or function called from `tick`, like `CapitalOverlapResolver` (`capitalOverlap.ts`), `SleepSettler` (`sleepSettle.ts`) or `applyForceFields` (`forceFields.ts`); scratch built once (#14). | live |
| A ray / hitscan query | `hitscanRay.ts`; `PhysicsWorld.hitscan` stays a thin wrapper (its skip filter is `RaySkipFilter`). | live |
| A velocity kick or impulse beyond `applyImpulse` | `src/core/physics/bodyImpulses.ts` (`addBodyVelocity`, `applyBodyImpulseAtPoint`, `applyRigidGroupImpulse`); scratch is module state built once (#14). | live |
| Reading or writing a body pose as `ShipPhysicsState` | `src/core/physics/bodyState.ts` (`writeBodyState`, `readBodyState`, `readAllBodyStates`). | live |
| A dev / diagnostic contact probe | `src/core/physics/contactProbe.ts` (`fastestContact`, `queryContactState`); not on a hot path. | live |

## Core: `fractureHull.ts` (`src/core/CLAUDE.md`)

`fractureHull.ts` keeps the plan, the sound primary and the piece split; it re-exports the moved public names (`FRACTURE_QUANTUM`, `EDGE_HULL`, `EDGE_CUT`, `FRACTURE_MAX_PIECES` and the `Fracture*` types). Every sibling stays under the determinism rules in its header and bumps `FRACTURE_ALGO_VERSION` on any output change.

| To add | Do this | Status |
|---|---|---|
| A new edge kind (`EDGE_*`) | `destruction/fractureRings.ts`; if it is jagged, add it to `jagged()` in `fractureJag.ts`. | live |
| A ring predicate, quantising rule or the piece builder (convex decomposition) | `destruction/fractureRings.ts`. | live |
| An input option, plan field or piece-output field (`FractureInput`, `FracturePlan`, `FracturePiece`) | `destruction/fractureTypes.ts` (types and piece limits only, so every sibling imports it without a cycle). | live |
| A hull measure (keel, beam, centroid, outline projection, chunky guard) | `destruction/fractureMeasure.ts`. | live |
| A jag shape, jag repair pass or T-junction weld rule | `destruction/fractureJag.ts`. | live |
| A splitting primitive (line clip, strip, extra cut) | `destruction/fractureSplit.ts`. | live |
| A new crack family (zone, fan, far, extra chunk, splinters) | `destruction/fractureCracks.ts` (its own seeded stream). | live |
| A plan draw | `fractureHull.ts` (`planFor`). | live |

## Shared data: `structureKinds.ts` (`src/shared-types/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A ship kind | A record in its family file under `src/shared-types/shipKinds/`, appended to `catalogueOrder.ts`. | live |
| A structure kind | A record in its family file under `src/shared-types/structureKinds/`, appended to its `catalogueOrder.ts`. | live |
| A weapon | A record in `src/core/combat/WeaponCatalogue.ts`. | live |

## Roll-out

The split runs as small, move-only PRs: code moves verbatim, behaviour and wire formats stay identical, and each PR lowers the god file's cap to its new size plus slack. When a planned point lands, its row flips to **live** and the nested `CLAUDE.md` for that folder is added or updated in the same PR.

This map supersedes the collaborator lists in `docs/plans/refactor-god-files.md` and `docs/plans/refactor-god-files-v3-hardened.md`, which were written when these files were a third of their current size.
