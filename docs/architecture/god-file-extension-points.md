# God-file extension points

<!-- showcase-exempt: process and architecture rules page, nothing to film -->

The file-size ratchet (`scripts/audit-god-files.mjs`, CI step "File-size ratchet") fails any `src/**` file over 600 LOC that is not allowlisted, and any allowlisted file that grows past its cap. The limits do not move. When a feature needs room, the code goes to the file's **extension point**: a new small file plus at most one line in the big file. Trimming comments or raising a cap is never the fix.

Each section below says: to add X, create file Y and add one row to Z. The nested `CLAUDE.md` next to each area carries the same rules in short form, and is loaded when an agent works in that folder.

Status column: **live** = the extension point exists today; **planned** = being built by the god-file split (see "Roll-out" below). Until a planned point lands, use the existing pattern named in its row.

## Server: `SectorRoom.ts` (`src/server/rooms/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A client→server message | A `register<Feature>(host)` file in `src/server/rooms/features/` that registers each message through `parsedMessage` (zod parse at the boundary, malformed tracker on failure), plus one row in `features/index.ts`. Reference: `registerTeleportMessages` (`features/teleportMessages.ts`). | live |
| A test-only `test_*` handler | `features/devTestMessages.ts`, gated on testMode or `EQX_ALLOW_DEV_OVERRIDES` (`TestMessageHandlers`). | live |
| A new subsystem | Construct it in its feature's register function; return `{ dispose }`; periodic work via `gameClock.every` + `guarded`; never a new field + `new X()` in `onCreate`. | planned |
| Join / leave / respawn logic | `JoinHandler` / `LeaveHandler` / `RespawnHandler` classes. | Leave/Respawn live; Join planned |
| A tick-phase step | A function taking a narrow ctx, like `runAiTick(ctx)` (`aiTickRunner.ts`). | live |

## Server: `src/server/index.ts` (`src/server/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A test / engineering / showcase room | A row in a per-feature room file in `src/server/rooms/testRooms/` (`engineeringRooms.ts`, `scenarioRooms.ts`, `worldRooms.ts`), `rooms/showcaseRooms.ts` or `definePerfRooms()`, all called from `index.ts` behind `shouldRegisterTestRooms()`. Never a `define` in `index.ts`. | live |
| An HTTP route | A router in `src/server/routes/` (like `diagRouter.ts`, `galaxyRouter.ts`), mounted with one line. Dev-only `/dev/*` and `/test/*` endpoints go in `routes/devRouter.ts` (mounted outside production). | live |
| A boot step | A step function in `src/server/boot/` (like `persistenceBoot.ts`, `livingWorldBoot.ts`, `economyBoot.ts`) taking a narrow deps object and returning what later steps need; `main()` is the ordered list of calls. Directors it starts go on `WorldHandles` (`boot/worldHandles.ts`). | live |

## Client: `ColyseusClient.ts` (`src/client/net/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A server→client message | Its zod schema in `src/shared-types/messages/` and a row in `ServerMessageSchemas` (`src/shared-types/messages.ts`); a `register<Feature>Handlers(room, ctx)` file in `src/client/net/handlers/` plus one row in `handlers/index.ts`. | live |
| A per-entity timer / state machine | Its own module, like `drawnShellTiming.ts`, `damageNumberTargets.ts`. | live |
| Fire control / lock state | `FireControlClient` (`src/client/net/FireControlClient.ts`; the lock line in `fireControl/LockLineClient.ts`); `ColyseusClient` keeps one-line delegates and reaches it as `this.fc`. | live |

## Client: `PixiRenderer.ts` and `IRenderer.ts` (`src/client/render/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A per-frame visual | An updater module `update<X>Sprites(mirror, ctx)` with a pooled ctx built once in `init`, like `pixi/shipSpriteUpdater.ts` or `pixi/beamUpdater.ts`. | live |
| A test / perf probe | A function in `pixi/rendererProbes.ts` taking `RendererProbeState`, plus a one-line delegate in `PixiRenderer`. | live |
| Pointer / touch / wheel input, an RTS command gesture or selection rule | `pixi/rendererInputController.ts` (listeners, forwarded events, placement pointers) or its base `pixi/rendererCommandRouting.ts` (command routing, THE selection); PixiRenderer keeps one-line delegates. | live |
| Camera framing (hull zoom range, caps) or the cinematic director | `pixi/cameraDirector.ts` (`RendererCameraDirector`, built once; `updateFrame` per frame). | live |
| A render-mirror field | The entity's `*RenderState` file under `src/core/contracts/render/`. | planned |
| A renderer method (overlay, camera, radar) | The matching sub-interface (`IFleetView`, `IRadarView`, `ICameraControl`) that `IRenderer` extends. | planned |

## Core AI: `HostileDroneBehaviour.ts` (`src/core/ai/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A combat move | An `IManoeuvre` in `src/core/ai/tactics/` (`manoeuvre.ts`). | live |
| An order / stance / non-combat mode | An `IPilotMode` file in `src/core/ai/modes/` (lifecycle next to `IManoeuvre` in `tactics/manoeuvre.ts`) plus a case in `pilotJob()`. Live: leaving, patrol (course + orbit), travel / patrol leg, search, flock follow, guard return. An order's state (post, travel, hunt) is fields on its mode, not the brain. | live |
| A pilot helper the brain owns (senses, target pick, morale state) | A class in `src/core/ai/pilot/` built once in the constructor (`PilotSenses`, `TargetPick`, `PilotMorale`). Combat-side helpers (`TacticalFill`, `BroadsideHelm`, `FireLaneSteer`, `CombatDecision`, `CombatSteer`) are classes in `src/core/ai/tactics/`, built the same way. | live |
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

## Shared data: `structureKinds.ts` (`src/shared-types/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A ship kind | A record in its family file under `src/shared-types/shipKinds/`, appended to `catalogueOrder.ts`. | live |
| A structure kind | A record in its family file under `src/shared-types/structureKinds/`, appended to its `catalogueOrder.ts`. | live |
| A weapon | A record in `src/core/combat/WeaponCatalogue.ts`. | live |

## Roll-out

The split runs as small, move-only PRs: code moves verbatim, behaviour and wire formats stay identical, and each PR lowers the god file's cap to its new size plus slack. When a planned point lands, its row flips to **live** and the nested `CLAUDE.md` for that folder is added or updated in the same PR.

This map supersedes the collaborator lists in `docs/plans/refactor-god-files.md` and `docs/plans/refactor-god-files-v3-hardened.md`, which were written when these files were a third of their current size.
