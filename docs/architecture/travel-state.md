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

## Sector to sector (next)

The same shape replaces the loading screen: the ship leaves the source room, the pilot keeps the normal view (own ship, engines, sky thinning to empty space) while the destination room loads, and arrives only once loaded (`client_ready`).
