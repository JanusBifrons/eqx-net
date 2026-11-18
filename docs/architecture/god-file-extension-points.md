# God-file extension points

<!-- showcase-exempt: process and architecture rules page, nothing to film -->

The file-size ratchet (`scripts/audit-god-files.mjs`, CI step "File-size ratchet") fails any `src/**` file over 600 LOC that is not allowlisted, and any allowlisted file that grows past its cap. The limits do not move. When a feature needs room, the code goes to the file's **extension point**: a new small file plus at most one line in the big file. Trimming comments or raising a cap is never the fix.

Each section below says: to add X, create file Y and add one row to Z. The nested `CLAUDE.md` next to each area carries the same rules in short form, and is loaded when an agent works in that folder.

Status column: **live** = the extension point exists today; **planned** = being built by the god-file split (see "Roll-out" below). Until a planned point lands, use the existing pattern named in its row.

## Server: `SectorRoom.ts` (`src/server/rooms/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A client→server message | A `register<Feature>(host)` file in `src/server/rooms/features/` that calls `host.onMessage` with zod parsing at the boundary, plus one row in `features/index.ts`. Reference: `registerTeleportMessages` (`TeleportMessageHandlers.ts`). | planned (pattern live) |
| A test-only `test_*` handler | `features/devTestMessages.ts`, registered behind the test-room gate. | planned |
| A new subsystem | Construct it inside its feature's register function and return `{ tick?, dispose? }`; never a new field + `new X()` in `onCreate`. | planned |
| Join / leave / respawn logic | `JoinHandler` / `LeaveHandler` / `RespawnHandler` classes. | Leave/Respawn live; Join planned |
| A tick-phase step | A function taking a narrow ctx, like `runAiTick(ctx)` (`aiTickRunner.ts`). | live |

## Server: `src/server/index.ts` (`src/server/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A test / engineering / showcase room | A row in a per-feature room file in `src/server/rooms/testRooms/` (`engineeringRooms.ts`, `scenarioRooms.ts`, `worldRooms.ts`), `rooms/showcaseRooms.ts` or `definePerfRooms()`, all called from `index.ts` behind `shouldRegisterTestRooms()`. Never a `define` in `index.ts`. | live |
| An HTTP route | A router in `src/server/routes/` (like `diagRouter.ts`, `galaxyRouter.ts`), mounted with one line. Dev-only `/dev/*` and `/test/*` endpoints go in `routes/devRouter.ts` (mounted outside production). | live |
| A boot step | A function in `src/server/boot/`, called from `main()`. | planned |

## Client: `ColyseusClient.ts` (`src/client/net/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A server→client message | Its zod schema in `src/shared-types/messages/` and a name→schema row in `messageNames.ts`; a `register<Feature>Handlers(room, ctx)` file in `src/client/net/handlers/` plus one row in the handler list. | planned |
| A per-entity timer / state machine | Its own module, like `drawnShellTiming.ts`, `damageNumberTargets.ts`. | live |
| Fire control / lock state | `FireControlClient`. | planned |

## Client: `PixiRenderer.ts` and `IRenderer.ts` (`src/client/render/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A per-frame visual | An updater module `update<X>Sprites(mirror, ctx)` with a pooled ctx built once in `init`, like `pixi/shipSpriteUpdater.ts`. | live |
| A test / perf probe | `pixi/rendererProbes.ts`. | planned |
| A render-mirror field | The entity's `*RenderState` file under `src/core/contracts/render/`. | planned |
| A renderer method (overlay, camera, radar) | The matching sub-interface (`IFleetView`, `IRadarView`, `ICameraControl`) that `IRenderer` extends. | planned |

## Core AI: `HostileDroneBehaviour.ts` (`src/core/ai/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A combat move | An `IManoeuvre` in `src/core/ai/tactics/` (`manoeuvre.ts`). | live |
| An order / stance / non-combat mode | An `IPilotMode` file in `src/core/ai/modes/` (lifecycle next to `IManoeuvre` in `tactics/manoeuvre.ts`) plus a case in `pilotJob()`. Live: leaving, patrol (course + orbit), travel / patrol leg, search, flock follow, guard return. An order's state (post, travel, hunt, course) is fields on its mode, and its setter is a method on that mode (the brain keeps a one-line delegate; cross-mode effects through `PilotOrderModes`). | live |
| A pilot helper the brain owns (senses, target pick, morale state) | A class in `src/core/ai/pilot/` built once in the constructor (`PilotSenses`, `TargetPick`, `PilotMorale`, `MoveToHelm` the shared fly-to). Combat-side helpers (`TacticalFill`, `BroadsideHelm`, `FireLaneSteer`, `CombatDecision`, `CombatSteer`) are classes in `src/core/ai/tactics/`, built the same way. | live |
| A tuning number | `hostileDroneTuning.ts`. | live |

## Shared data: `structureKinds.ts` (`src/shared-types/CLAUDE.md`)

| To add | Do this | Status |
|---|---|---|
| A ship kind | A record in its family file under `src/shared-types/shipKinds/`, appended to `catalogueOrder.ts`. | live |
| A structure kind | A record in its family file under `src/shared-types/structureKinds/`, appended to its `catalogueOrder.ts`. | planned |
| A weapon | A record in `src/core/combat/WeaponCatalogue.ts`. | live |

## Roll-out

The split runs as small, move-only PRs: code moves verbatim, behaviour and wire formats stay identical, and each PR lowers the god file's cap to its new size plus slack. When a planned point lands, its row flips to **live** and the nested `CLAUDE.md` for that folder is added or updated in the same PR.

This map supersedes the collaborator lists in `docs/plans/refactor-god-files.md` and `docs/plans/refactor-god-files-v3-hardened.md`, which were written when these files were a third of their current size.
