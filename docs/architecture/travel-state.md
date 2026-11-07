# Travel state (warp as a pseudo state)

Plan prancy-squishing-donut, Phase 4. The user's direction: a warp should look like a real flight, but be an invisible loading state, "like the lifts in Fallout": the trip is longer on a slow device, shorter on a fast one, and the player never notices.

## In-system (shipped)

- **Mechanic** (`core/physics/warpDrive.ts`, `World.applyInput`): spool → run → drop, driven by the input stream so the server worker and the client prediction run it identically. During the spool `World.alignToWarp` turns the ship to its target. During the run the colliders are off.
- **Server tracker** (`server/rooms/warpTravel.ts`, `WarpTravelTracker`), ticked after the pending-join drain:
  - into the run → `ShipState.travelling = true`: no AI targeting (`aiTickRunner`), no damage (`applyDamage`), the pilot's interest window moves to the landing point (`SwarmBroadcaster.interestPointOf`), and the landing point is moved to the nearest clear spot if blocked (`warpLandingPoint` → `WARP_RETARGET`);
  - out of the run → `travelling = false`, "just arrived" for 30 ticks, and a `poseEpoch` bump if the landing moved (the pilot's client re-seeds with no correction slide).
- **Snapshot (#16):** `states[].warp` is 1 spool, 2 run, 3 just arrived. Others get 2 so they hide the ship (sprite, label, prediction body); 3 draws the arrival. A ship still joining (pending `client_ready`) is sent to its own pilot only.
- **Liveness (#17):** TRAVELLING is a fourth class beside ACTIVE / LINGERING / DEAD: an ACTIVE hull with `travelling = true`. Loops that touch the world (AI targets, damage, turrets) skip it; pilot-only loops (energy, shield regen) keep running.
- **Client:** `WarpFx` draws the build-up, departure and arrival from the mirror's `warp`. Another pilot's mirror pose is unreliable while it has no prediction body, so the departure heading is taken from the spool frames, and an arrival is snapped to the snapshot pose once before anything draws it (`syncRemoteWarpBodies`).

## Sector to sector (shipped)

The trip IS the loading screen; the player shouldn't notice it (the user: "like the lifts in Fallout"). The curtain only covers the very first join.

- **Spool (source sector, real, 30 s):** the engine build-up (`warp: 1` for everyone, from `TransitOrchestrator.isInFlight`). The destination's sky textures are prepared now (`mirror.prewarmSector` → `Backdrop.prewarm`), so their upload never lands mid-trip. Effect textures are not lit, so their cache key ignores the sector's sun (`ArtService.acquire`); otherwise the prewarm would miss.
- **Out (from `IN_TRANSIT`):** `ColyseusClient.beginTravel`; the store's `travelling` is set. The ship accelerates along its heading over `TRAVEL_OUT_S`. The old sector stays live and falls behind: the `transit_ready` room swap waits (`travelOutRemainingMs`) until the ship has flown out of it. Departure trails stop at the ship (they never reach ahead of it).
- **Cruise:** warp speed through deep space (`mirror.travelDeep`: the backdrop thins to stars); the destination room joins and loads underneath. Input is off, the HUD stays up; `WarpScreen` and the curtain stay hidden (a stalled trip still shows the loading screen with Cancel after `TRAVEL_STALL_TIMEOUT_MS`). The backdrop holds the sector switch until the old sky has thinned.
- **In:** after `TRAVEL_MIN_S` (minus the approach) and once the destination is loaded, the ship is placed on approach out along its heading (`mirror.travelJumpX/Y`; the renderer shifts the sky by it so the stars carry on), brakes from warp to a glide, then glides onto its arrival point (`travelApproach`), so what's near the arrival point is flown past at a visible speed. Landing opens `joinMinimumElapsed` → `client_ready` → the ship arrives for everyone (`warp: 3`).
- **Feel knobs** (`ColyseusClient`): `TRAVEL_OUT_S` 3, `TRAVEL_MIN_S` 25 (the user: "20–30 s, it needs to feel significant"), `TRAVEL_BRAKE_S` 2.5, `TRAVEL_GLIDE_V` 2500, `TRAVEL_GLIDE_D` 4000.
- **Known gap:** newly baked art re-uploads its whole atlas page, a GPU stall (0.25–0.6 s on integrated graphics) wherever a batch of new art lands. Fix in progress: upload new art in small pieces.
