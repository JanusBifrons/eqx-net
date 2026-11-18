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
| Join / leave / respawn logic | `JoinHandler` (`join/`) / `LeaveHandler` / `RespawnHandler` classes. | live |
| A tick-phase step | A function taking a narrow ctx, like `runAiTick(ctx)` (`aiTickRunner.ts`). | live |
| Fire-control lock logic (lock-key resolution, the lock machines' deps, the mount-on-lock gates) | `FireControlLocks` (`features/fireControlLocks.ts`), held as `fireLocks` on the room with a narrow `Pick`-typed host. | live |

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

## Core: `fractureHull.ts` (`src/core/CLAUDE.md`)

`fractureHull.ts` keeps the plan, the crack lines and the piece split; it re-exports the moved public names (`FRACTURE_QUANTUM`, `EDGE_HULL`, `EDGE_CUT`, `FractureEdgeKind`). Every sibling stays under the determinism rules in its header and bumps `FRACTURE_ALGO_VERSION` on any output change.

| To add | Do this | Status |
|---|---|---|
| A new edge kind (`EDGE_*`) | `destruction/fractureRings.ts`; if it is jagged, add it to `jagged()` in `fractureJag.ts`. | live |
| A ring predicate, quantising rule or piece-output field (`FracturePiece`, convex decomposition) | `destruction/fractureRings.ts`. | live |
| A jag shape, jag repair pass or T-junction weld rule | `destruction/fractureJag.ts`. | live |
| A splitting primitive (line clip, strip, extra cut) | `destruction/fractureSplit.ts`. | live |
| A new crack family or plan draw | `fractureHull.ts` (`crackLines` / `planFor`) until a crack-lines module is split out. | planned |

## Shared data: `structureKinds.ts` (`src/shared-types/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A ship kind | A record in its family file under `src/shared-types/shipKinds/`, appended to `catalogueOrder.ts`. | live |
| A structure kind | A record in its family file under `src/shared-types/structureKinds/`, appended to its `catalogueOrder.ts`. | live |
| A weapon | A record in `src/core/combat/WeaponCatalogue.ts`. | live |

## Roll-out

The split runs as small, move-only PRs: code moves verbatim, behaviour and wire formats stay identical, and each PR lowers the god file's cap to its new size plus slack. When a planned point lands, its row flips to **live** and the nested `CLAUDE.md` for that folder is added or updated in the same PR.

This map supersedes the collaborator lists in `docs/plans/refactor-god-files.md` and `docs/plans/refactor-god-files-v3-hardened.md`, which were written when these files were a third of their current size.
